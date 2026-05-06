import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DB } from './db.js';
import { costOf } from './pricing.js';
import type { ProjectSummary, SessionSummary, ToolBucket } from './types.js';

export class Queries {
  constructor(private db: DB) {}

  listProjects(): ProjectSummary[] {
    const rows = this.db.prepare(`
      SELECT
        e.cwd as cwd,
        MAX(e.ts) as last_active,
        COUNT(DISTINCT e.session_id) as session_count,
        SUM(e.input_tokens) as in_t,
        SUM(e.output_tokens) as out_t,
        SUM(e.cache_read) as cr_t,
        SUM(e.cache_create) as cc_t
      FROM events e
      WHERE e.cwd IS NOT NULL
      GROUP BY e.cwd
      ORDER BY last_active DESC
    `).all() as Array<{ cwd: string; last_active: number; session_count: number; in_t: number; out_t: number; cr_t: number; cc_t: number }>;

    return rows.map((r) => this.attachCost({
      cwd: r.cwd,
      lastActive: r.last_active ?? 0,
      sessionCount: r.session_count ?? 0,
      totalInputTokens: r.in_t ?? 0,
      totalOutputTokens: r.out_t ?? 0,
      totalCacheRead: r.cr_t ?? 0,
      totalCacheCreate: r.cc_t ?? 0,
      estimatedCost: 0,
    }));
  }

  private attachCost(p: ProjectSummary): ProjectSummary {
    // approximate: per-model breakdown for accurate cost
    const breakdown = this.db.prepare(`
      SELECT model, SUM(input_tokens) as i, SUM(output_tokens) as o, SUM(cache_read) as cr, SUM(cache_create) as cc
      FROM events WHERE cwd = ? AND model IS NOT NULL GROUP BY model
    `).all(p.cwd) as Array<{ model: string; i: number; o: number; cr: number; cc: number }>;
    let cost = 0;
    for (const b of breakdown) {
      cost += costOf(b.model, { input: b.i, output: b.o, cacheRead: b.cr, cacheCreate: b.cc });
    }
    return { ...p, estimatedCost: cost };
  }

  listSessions(cwd: string): SessionSummary[] {
    // Session can span multiple cwds (user cd's mid-session). Pick sessions that
    // have ANY event with the target cwd, and scope token/cost metrics to events
    // recorded under that cwd so per-project numbers reflect work-in-this-project.
    const rows = this.db.prepare(`
      SELECT
        s.id, s.cwd as session_cwd, s.title, s.branch,
        MIN(e.ts) as started_at,
        MAX(e.ts) as ended_at,
        COUNT(e.uuid) as event_count,
        COALESCE(SUM(e.input_tokens), 0) as in_t,
        COALESCE(SUM(e.output_tokens), 0) as out_t,
        COALESCE(SUM(e.cache_read), 0) as cr_t,
        COALESCE(SUM(e.cache_create), 0) as cc_t,
        (SELECT COUNT(*) FROM tool_calls tc
           JOIN events e2 ON e2.uuid = tc.event_uuid
           WHERE tc.session_id = s.id AND e2.cwd = ?) as tool_calls
      FROM events e
      JOIN sessions s ON s.id = e.session_id
      WHERE e.cwd = ?
      GROUP BY s.id
      ORDER BY ended_at DESC
    `).all(cwd, cwd) as Array<any>;

    return rows.map((r) => ({
      id: r.id,
      cwd,
      title: r.title,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      branch: r.branch ?? null,
      eventCount: r.event_count ?? 0,
      inputTokens: r.in_t ?? 0,
      outputTokens: r.out_t ?? 0,
      cacheRead: r.cr_t ?? 0,
      cacheCreate: r.cc_t ?? 0,
      toolCallCount: r.tool_calls ?? 0,
      estimatedCost: this.sessionCostScoped(r.id, cwd),
    }));
  }

  sessionCostScoped(sessionId: string, cwd: string): number {
    const rows = this.db.prepare(`
      SELECT model, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cache_read) cr, SUM(cache_create) cc
      FROM events WHERE session_id = ? AND cwd = ? AND model IS NOT NULL GROUP BY model
    `).all(sessionId, cwd) as Array<{ model: string; i: number; o: number; cr: number; cc: number }>;
    let c = 0;
    for (const r of rows) c += costOf(r.model, { input: r.i, output: r.o, cacheRead: r.cr, cacheCreate: r.cc });
    return c;
  }

  sessionCost(sessionId: string): number {
    const rows = this.db.prepare(`
      SELECT model, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cache_read) cr, SUM(cache_create) cc
      FROM events WHERE session_id = ? AND model IS NOT NULL GROUP BY model
    `).all(sessionId) as Array<{ model: string; i: number; o: number; cr: number; cc: number }>;
    let c = 0;
    for (const r of rows) c += costOf(r.model, { input: r.i, output: r.o, cacheRead: r.cr, cacheCreate: r.cc });
    return c;
  }

  toolHistogram(filter: { cwd?: string; sessionId?: string }): ToolBucket[] {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.cwd) { where.push('e.cwd = ?'); params.push(filter.cwd); }
    if (filter.sessionId) { where.push('tc.session_id = ?'); params.push(filter.sessionId); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT tc.name as name,
             COUNT(*) as cnt,
             AVG(CASE WHEN tr.ts IS NOT NULL THEN tr.ts - tc.ts END) as avg_ms,
             SUM(CASE WHEN tr.ts IS NOT NULL THEN tr.ts - tc.ts ELSE 0 END) as total_ms
      FROM tool_calls tc
      LEFT JOIN tool_results tr ON tr.tool_use_id = tc.tool_use_id
      LEFT JOIN events e ON e.uuid = tc.event_uuid
      ${w}
      GROUP BY tc.name
      ORDER BY cnt DESC
    `).all(...params) as Array<{ name: string; cnt: number; avg_ms: number | null; total_ms: number }>;

    return rows.map((r) => ({
      name: r.name,
      count: r.cnt,
      avgLatencyMs: r.avg_ms,
      p95LatencyMs: this.toolP95(r.name, filter),
      totalLatencyMs: r.total_ms ?? 0,
    }));
  }

  private toolP95(name: string, filter: { cwd?: string; sessionId?: string }): number | null {
    const where: string[] = ['tc.name = ?', 'tr.ts IS NOT NULL'];
    const params: any[] = [name];
    if (filter.cwd) { where.push('e.cwd = ?'); params.push(filter.cwd); }
    if (filter.sessionId) { where.push('tc.session_id = ?'); params.push(filter.sessionId); }
    const rows = this.db.prepare(`
      SELECT tr.ts - tc.ts as dur
      FROM tool_calls tc
      JOIN tool_results tr ON tr.tool_use_id = tc.tool_use_id
      LEFT JOIN events e ON e.uuid = tc.event_uuid
      WHERE ${where.join(' AND ')}
      ORDER BY dur ASC
    `).all(...params) as Array<{ dur: number }>;
    if (!rows.length) return null;
    const idx = Math.floor(rows.length * 0.95);
    return rows[Math.min(idx, rows.length - 1)]!.dur;
  }

  sessionTimeline(sessionId: string, idleThresholdMs = 120_000) {
    const rows = this.db.prepare(`
      SELECT uuid, type, role, ts, model, input_tokens, output_tokens, cache_read, cache_create,
             tool_name, tool_use_id, tool_result_for_id, parent_uuid, is_sidechain
      FROM events WHERE session_id = ? ORDER BY ts ASC
    `).all(sessionId) as Array<any>;

    const events = rows.map((e) => ({
      ...e,
      cost: costOf(e.model, {
        input: e.input_tokens,
        output: e.output_tokens,
        cacheRead: e.cache_read,
        cacheCreate: e.cache_create,
      }),
    }));

    const gaps: Array<{ from: number; to: number; durationMs: number }> = [];
    for (let i = 1; i < events.length; i++) {
      const dt = events[i].ts - events[i - 1].ts;
      if (dt > idleThresholdMs) gaps.push({ from: events[i - 1].ts, to: events[i].ts, durationMs: dt });
    }
    return { events, gaps };
  }

  eventDetail(uuid: string) {
    const e = this.db.prepare(`
      SELECT uuid, session_id, parent_uuid, type, role, ts, cwd, git_branch, version,
             is_sidechain, model, input_tokens, output_tokens, cache_read, cache_create,
             tool_name, tool_use_id, tool_result_for_id
      FROM events WHERE uuid = ?
    `).get(uuid) as any;
    if (!e) return null;

    let toolCallInput: unknown = null;
    let toolResult: { ts: number; isError: number; matchedToolUseId: string } | null = null;

    if (e.tool_use_id) {
      const tc = this.db.prepare(`SELECT input_json FROM tool_calls WHERE tool_use_id = ?`).get(e.tool_use_id) as { input_json: string } | undefined;
      if (tc?.input_json) {
        try { toolCallInput = JSON.parse(tc.input_json); } catch { toolCallInput = tc.input_json; }
      }
      const tr = this.db.prepare(`SELECT ts, is_error FROM tool_results WHERE tool_use_id = ?`).get(e.tool_use_id) as { ts: number; is_error: number } | undefined;
      if (tr) toolResult = { ts: tr.ts, isError: tr.is_error, matchedToolUseId: e.tool_use_id };
    }
    if (e.tool_result_for_id) {
      const tc = this.db.prepare(`SELECT input_json, name, ts FROM tool_calls WHERE tool_use_id = ?`).get(e.tool_result_for_id) as { input_json: string; name: string; ts: number } | undefined;
      if (tc) {
        try { toolCallInput = JSON.parse(tc.input_json); } catch { toolCallInput = tc.input_json; }
        toolResult = { ts: tc.ts, isError: 0, matchedToolUseId: e.tool_result_for_id };
        e.tool_name = tc.name; // help UI display the tool this result belongs to
      }
    }

    const raw = readRawJsonlByUuid(e.session_id, e.uuid);
    const message = raw?.message ?? null;

    return {
      ...e,
      cost: costOf(e.model, {
        input: e.input_tokens,
        output: e.output_tokens,
        cacheRead: e.cache_read,
        cacheCreate: e.cache_create,
      }),
      toolCallInput,
      toolResult,
      message,
      raw,
    };
  }

  modelBreakdown(filter: { cwd?: string; sessionId?: string }) {
    const where: string[] = ['model IS NOT NULL'];
    const params: any[] = [];
    if (filter.cwd) { where.push('cwd = ?'); params.push(filter.cwd); }
    if (filter.sessionId) { where.push('session_id = ?'); params.push(filter.sessionId); }
    const rows = this.db.prepare(`
      SELECT model,
             SUM(input_tokens) as i,
             SUM(output_tokens) as o,
             SUM(cache_read) as cr,
             SUM(cache_create) as cc,
             COUNT(*) as n
      FROM events WHERE ${where.join(' AND ')} GROUP BY model ORDER BY (i+o+cr+cc) DESC
    `).all(...params) as Array<{ model: string; i: number; o: number; cr: number; cc: number; n: number }>;
    return rows.map((r) => ({
      model: r.model,
      messages: r.n,
      inputTokens: r.i,
      outputTokens: r.o,
      cacheRead: r.cr,
      cacheCreate: r.cc,
      cost: costOf(r.model, { input: r.i, output: r.o, cacheRead: r.cr, cacheCreate: r.cc }),
    }));
  }

  totals(): { eventCount: number; sessionCount: number; projectCount: number } {
    const e = this.db.prepare('SELECT COUNT(*) as c FROM events').get() as { c: number };
    const s = this.db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number };
    const p = this.db.prepare('SELECT COUNT(*) as c FROM projects').get() as { c: number };
    return { eventCount: e.c, sessionCount: s.c, projectCount: p.c };
  }
}

/* Read the original JSONL line for a given event uuid by scanning the
 * session-id-named file under ~/.claude/projects/<*>/<sessionId>.jsonl.
 * Returns parsed JSON or null. Cached per (sessionId, mtime). */

interface JsonlCacheEntry {
  mtimeMs: number;
  byUuid: Map<string, any>;
}
const jsonlCache = new Map<string, JsonlCacheEntry>();
const CACHE_BUDGET = 32; // bound memory; evict oldest

function rootDir() {
  return process.env.CCPULSE_CLAUDE_DIR || join(homedir(), '.claude', 'projects');
}

function findJsonlPath(sessionId: string): string | null {
  const root = rootDir();
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    const candidate = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function readRawJsonlByUuid(sessionId: string, uuid: string): any | null {
  const path = findJsonlPath(sessionId);
  if (!path) return null;
  let mtimeMs: number;
  try { mtimeMs = statSync(path).mtimeMs; } catch { return null; }

  let entry = jsonlCache.get(path);
  if (!entry || entry.mtimeMs !== mtimeMs) {
    let text: string;
    try { text = readFileSync(path, 'utf8'); } catch { return null; }
    const byUuid = new Map<string, any>();
    for (const line of text.split('\n')) {
      if (!line) continue;
      // cheap pre-filter: only attempt parse if uuid string appears
      if (!line.includes('"uuid"')) continue;
      try {
        const o = JSON.parse(line);
        if (o.uuid) byUuid.set(o.uuid, o);
      } catch { /* skip malformed */ }
    }
    entry = { mtimeMs, byUuid };
    if (jsonlCache.size >= CACHE_BUDGET) {
      const firstKey = jsonlCache.keys().next().value;
      if (firstKey) jsonlCache.delete(firstKey);
    }
    jsonlCache.set(path, entry);
  }
  return entry.byUuid.get(uuid) ?? null;
}
