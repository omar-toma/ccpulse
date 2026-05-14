import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DB } from './db.js';
import { costOf } from './pricing.js';
import type { ProjectSummary, SessionSummary, ToolBucket } from './types.js';

export class Queries {
  constructor(private db: DB) {}

  /** Cache: sessionId → project root (computed via .git probe + LCP fallback). */
  private rootsCache: Map<string, string> | null = null;

  /** Inverse: project root → set of session ids. Built alongside rootsCache. */
  private sessionsByRootCache: Map<string, Set<string>> | null = null;

  /** Call after ingest so the next query rebuilds the project grouping. */
  invalidate(): void {
    this.rootsCache = null;
    this.sessionsByRootCache = null;
  }

  private buildRootIndex(): { roots: Map<string, string>; byRoot: Map<string, Set<string>> } {
    if (this.rootsCache && this.sessionsByRootCache) {
      return { roots: this.rootsCache, byRoot: this.sessionsByRootCache };
    }
    const rows = this.db.prepare(`
      SELECT session_id, cwd FROM events WHERE cwd IS NOT NULL GROUP BY session_id, cwd
    `).all() as Array<{ session_id: string; cwd: string }>;

    const cwdsBySession = new Map<string, Set<string>>();
    for (const r of rows) {
      let set = cwdsBySession.get(r.session_id);
      if (!set) { set = new Set(); cwdsBySession.set(r.session_id, set); }
      set.add(r.cwd);
    }

    const roots = new Map<string, string>();
    const byRoot = new Map<string, Set<string>>();
    for (const [sid, cwds] of cwdsBySession) {
      const root = computeSessionRoot([...cwds]);
      roots.set(sid, root);
      let set = byRoot.get(root);
      if (!set) { set = new Set(); byRoot.set(root, set); }
      set.add(sid);
    }
    this.rootsCache = roots;
    this.sessionsByRootCache = byRoot;
    return { roots, byRoot };
  }

  /** Read-only: which sessions belong to this project root. */
  sessionsForRoot(root: string): string[] {
    const { byRoot } = this.buildRootIndex();
    return [...(byRoot.get(root) ?? [])];
  }

  /** Read-only: project root for a given session id, if known. */
  rootForSession(sessionId: string): string | null {
    const { roots } = this.buildRootIndex();
    return roots.get(sessionId) ?? null;
  }

  listProjects(): ProjectSummary[] {
    const { byRoot } = this.buildRootIndex();
    if (byRoot.size === 0) return [];

    // One query: per-session aggregates.
    const perSession = this.db.prepare(`
      SELECT session_id,
             COALESCE(SUM(input_tokens), 0) as i,
             COALESCE(SUM(output_tokens), 0) as o,
             COALESCE(SUM(cache_read), 0) as cr,
             COALESCE(SUM(cache_create), 0) as cc,
             MAX(ts) as last_ts
      FROM events GROUP BY session_id
    `).all() as Array<{ session_id: string; i: number; o: number; cr: number; cc: number; last_ts: number }>;
    const ix = new Map(perSession.map((r) => [r.session_id, r]));

    const out: ProjectSummary[] = [];
    for (const [root, sids] of byRoot) {
      let lastActive = 0, ti = 0, to = 0, tcr = 0, tcc = 0;
      for (const sid of sids) {
        const r = ix.get(sid);
        if (!r) continue;
        if (r.last_ts > lastActive) lastActive = r.last_ts;
        ti += r.i; to += r.o; tcr += r.cr; tcc += r.cc;
      }
      out.push({
        cwd: root,
        lastActive,
        sessionCount: sids.size,
        totalInputTokens: ti,
        totalOutputTokens: to,
        totalCacheRead: tcr,
        totalCacheCreate: tcc,
        estimatedCost: this.costForSessions(sids),
      });
    }
    out.sort((a, b) => b.lastActive - a.lastActive);
    return out;
  }

  /** Cost for an arbitrary set of session ids, model-weighted. */
  private costForSessions(sessionIds: Set<string> | string[]): number {
    const ids = Array.isArray(sessionIds) ? sessionIds : [...sessionIds];
    if (!ids.length) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT model, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cache_read) cr, SUM(cache_create) cc
      FROM events
      WHERE session_id IN (${placeholders}) AND model IS NOT NULL
      GROUP BY model
    `).all(...ids) as Array<{ model: string; i: number; o: number; cr: number; cc: number }>;
    let c = 0;
    for (const r of rows) c += costOf(r.model, { input: r.i, output: r.o, cacheRead: r.cr, cacheCreate: r.cc });
    return c;
  }

  listSessions(root: string): SessionSummary[] {
    const sids = this.sessionsForRoot(root);
    if (!sids.length) return [];
    const placeholders = sids.map(() => '?').join(',');
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
        (SELECT COUNT(*) FROM tool_calls tc WHERE tc.session_id = s.id) as tool_calls
      FROM sessions s
      LEFT JOIN events e ON e.session_id = s.id
      WHERE s.id IN (${placeholders})
      GROUP BY s.id
      ORDER BY ended_at DESC
    `).all(...sids) as Array<any>;

    return rows.map((r) => ({
      id: r.id,
      cwd: root,
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
      estimatedCost: this.sessionCost(r.id),
    }));
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
    const sessionIds = this.scopeToSessions(filter);
    if (sessionIds && !sessionIds.length) return [];

    const where: string[] = [];
    const params: any[] = [];
    if (sessionIds) {
      where.push(`tc.session_id IN (${sessionIds.map(() => '?').join(',')})`);
      params.push(...sessionIds);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT tc.name as name,
             COUNT(*) as cnt,
             AVG(CASE WHEN tr.ts IS NOT NULL THEN tr.ts - tc.ts END) as avg_ms,
             SUM(CASE WHEN tr.ts IS NOT NULL THEN tr.ts - tc.ts ELSE 0 END) as total_ms
      FROM tool_calls tc
      LEFT JOIN tool_results tr ON tr.tool_use_id = tc.tool_use_id
      ${w}
      GROUP BY tc.name
      ORDER BY cnt DESC
    `).all(...params) as Array<{ name: string; cnt: number; avg_ms: number | null; total_ms: number }>;

    return rows.map((r) => ({
      name: r.name,
      count: r.cnt,
      avgLatencyMs: r.avg_ms,
      p95LatencyMs: this.toolP95(r.name, sessionIds),
      totalLatencyMs: r.total_ms ?? 0,
    }));
  }

  private toolP95(name: string, sessionIds: string[] | null): number | null {
    const where: string[] = ['tc.name = ?', 'tr.ts IS NOT NULL'];
    const params: any[] = [name];
    if (sessionIds) {
      where.push(`tc.session_id IN (${sessionIds.map(() => '?').join(',')})`);
      params.push(...sessionIds);
    }
    const rows = this.db.prepare(`
      SELECT tr.ts - tc.ts as dur
      FROM tool_calls tc
      JOIN tool_results tr ON tr.tool_use_id = tc.tool_use_id
      WHERE ${where.join(' AND ')}
      ORDER BY dur ASC
    `).all(...params) as Array<{ dur: number }>;
    if (!rows.length) return null;
    const idx = Math.floor(rows.length * 0.95);
    return rows[Math.min(idx, rows.length - 1)]!.dur;
  }

  /**
   * Translate a {cwd, sessionId} filter to a flat session-id list.
   * Returns null when no scoping is requested (=> return everything).
   * Returns empty array when scoping requested but nothing matched.
   */
  private scopeToSessions(filter: { cwd?: string; sessionId?: string }): string[] | null {
    if (filter.sessionId) return [filter.sessionId];
    if (filter.cwd) return this.sessionsForRoot(filter.cwd);
    return null;
  }

  sessionTimeline(sessionId: string, idleThresholdMs = 120_000) {
    const meta = this.db.prepare(`
      SELECT id, title, cwd, branch FROM sessions WHERE id = ?
    `).get(sessionId) as { id: string; title: string | null; cwd: string | null; branch: string | null } | undefined;

    const rows = this.db.prepare(`
      SELECT uuid, type, role, ts, model, input_tokens, output_tokens, cache_read, cache_create,
             tool_name, tool_use_id, tool_result_for_id, parent_uuid, is_sidechain
      FROM events WHERE session_id = ? ORDER BY ts ASC
    `).all(sessionId) as Array<any>;

    // Batch-fetch tool_calls.input_json for any tool_use or tool_result event so we can
    // expose a search-friendly flattened text on each row.
    const toolIds = new Set<string>();
    for (const e of rows) {
      if (e.tool_use_id) toolIds.add(e.tool_use_id);
      if (e.tool_result_for_id) toolIds.add(e.tool_result_for_id);
    }
    const toolInputByUseId = new Map<string, string>();
    if (toolIds.size > 0) {
      const ids = [...toolIds];
      const ph = ids.map(() => '?').join(',');
      const trows = this.db.prepare(
        `SELECT tool_use_id, input_json FROM tool_calls WHERE tool_use_id IN (${ph})`,
      ).all(...ids) as Array<{ tool_use_id: string; input_json: string }>;
      for (const tr of trows) toolInputByUseId.set(tr.tool_use_id, tr.input_json);
    }

    const events = rows.map((e) => {
      const raw = readRawJsonlByUuid(e.session_id ?? sessionId, e.uuid);
      const tid = e.tool_use_id ?? e.tool_result_for_id;
      const rawInput = tid ? toolInputByUseId.get(tid) : undefined;
      return {
        ...e,
        cost: costOf(e.model, {
          input: e.input_tokens,
          output: e.output_tokens,
          cacheRead: e.cache_read,
          cacheCreate: e.cache_create,
        }),
        summary: extractEventSummary(raw, e),
        hasThinking: hasThinkingBlock(raw),
        toolInputText: rawInput ? flattenJsonForSearch(rawInput, 500) : null,
      };
    });

    const gaps: Array<{ from: number; to: number; durationMs: number }> = [];
    for (let i = 1; i < events.length; i++) {
      const dt = events[i].ts - events[i - 1].ts;
      if (dt > idleThresholdMs) gaps.push({ from: events[i - 1].ts, to: events[i].ts, durationMs: dt });
    }
    const projectRoot = this.rootForSession(sessionId);
    const session = meta
      ? { id: meta.id, title: meta.title, cwd: meta.cwd, branch: meta.branch, projectRoot }
      : { id: sessionId, title: null, cwd: null, branch: null, projectRoot };
    return { session, events, gaps };
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
    const sessionIds = this.scopeToSessions(filter);
    if (sessionIds && !sessionIds.length) return [];

    const where: string[] = ['model IS NOT NULL'];
    const params: any[] = [];
    if (sessionIds) {
      where.push(`session_id IN (${sessionIds.map(() => '?').join(',')})`);
      params.push(...sessionIds);
    }
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

  /**
   * Search event summaries across sessions. Reads raw JSONL files, derives summary text
   * via extractEventSummary, performs case-insensitive substring match. Optionally scoped
   * to a project cwd. Returns one result per session (the first matching snippet).
   */
  searchEventSummaries(
    q: string,
    opts: { cwd?: string; limit?: number } = {},
  ): Array<{ sessionId: string; cwd: string | null; snippet: string; matchCount: number; lastTs: number }> {
    const query = q.trim().toLowerCase();
    if (query.length < 2) return [];
    const limit = opts.limit ?? 100;

    let sessionIds: string[];
    if (opts.cwd) {
      sessionIds = this.sessionsForRoot(opts.cwd);
    } else {
      const { roots } = this.buildRootIndex();
      sessionIds = [...roots.keys()];
    }
    if (!sessionIds.length) return [];

    // Order by recency so top results surface first when we hit the limit.
    const lastTsRows = this.db.prepare(`
      SELECT session_id, MAX(ts) as last_ts FROM events
      WHERE session_id IN (${sessionIds.map(() => '?').join(',')})
      GROUP BY session_id
    `).all(...sessionIds) as Array<{ session_id: string; last_ts: number }>;
    const lastTsMap = new Map(lastTsRows.map((r) => [r.session_id, r.last_ts]));
    sessionIds.sort((a, b) => (lastTsMap.get(b) ?? 0) - (lastTsMap.get(a) ?? 0));

    const out: Array<{ sessionId: string; cwd: string | null; snippet: string; matchCount: number; lastTs: number }> = [];

    for (const sid of sessionIds) {
      if (out.length >= limit) break;
      const path = findJsonlPath(sid);
      if (!path) continue;
      const entry = loadJsonlCache(path);
      if (!entry) continue;

      let matchCount = 0;
      let snippet: string | null = null;
      for (const raw of entry.byUuid.values()) {
        const role = raw.message?.role ?? raw.role ?? null;
        const toolName = Array.isArray(raw.message?.content)
          ? (raw.message.content.find((b: any) => b?.type === 'tool_use')?.name ?? null)
          : null;
        const summary = extractEventSummary(raw, { type: raw.type, tool_name: toolName, role });
        if (!summary) continue;
        if (summary.toLowerCase().includes(query)) {
          matchCount++;
          if (!snippet) snippet = summary;
        }
      }

      if (matchCount > 0) {
        out.push({
          sessionId: sid,
          cwd: this.rootForSession(sid),
          snippet: snippet ?? '',
          matchCount,
          lastTs: lastTsMap.get(sid) ?? 0,
        });
      }
    }
    return out;
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

function loadJsonlCache(path: string): JsonlCacheEntry | null {
  let mtimeMs: number;
  try { mtimeMs = statSync(path).mtimeMs; } catch { return null; }

  let entry = jsonlCache.get(path);
  if (!entry || entry.mtimeMs !== mtimeMs) {
    let text: string;
    try { text = readFileSync(path, 'utf8'); } catch { return null; }
    const byUuid = new Map<string, any>();
    for (const line of text.split('\n')) {
      if (!line) continue;
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
  return entry;
}

export function readRawJsonlByUuid(sessionId: string, uuid: string): any | null {
  const path = findJsonlPath(sessionId);
  if (!path) return null;
  const entry = loadJsonlCache(path);
  return entry?.byUuid.get(uuid) ?? null;
}

const SUMMARY_MAX = 220;

/** First text-ish snippet from a raw JSONL line, used as the timeline detail blurb. */
export function extractEventSummary(raw: any | null, e: { type?: string; tool_name?: string | null; role?: string | null }): string | null {
  if (!raw) return null;
  // Prefer message content
  const c = raw.message?.content;
  if (typeof c === 'string') return clip(c);
  if (Array.isArray(c)) {
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) return clip(b.text);
      if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) return clip(b.thinking);
      if (b.type === 'tool_result') {
        const t = stringifyToolResultLite(b.content);
        if (t) return clip(`→ ${t}`);
      }
    }
    // fall through to tool_use detail (already shown via tool_name; skip)
  }
  // Attachment events: derive a useful sentence from the payload
  if (e.type === 'attachment' && raw.attachment) {
    const a = raw.attachment;
    const head = a.hookName || a.hookEvent || a.reminderType || a.filename || a.displayPath;
    if (typeof a.content === 'string' && a.content.trim()) return clip(`${head ? head + ' — ' : ''}${a.content}`);
    if (head) return clip(`${a.type ?? 'attachment'} · ${head}`);
    if (typeof a.type === 'string') return clip(a.type);
  }
  // System events: subtype + a useful field
  if (e.type === 'system') {
    const parts: string[] = [];
    if (raw.subtype) parts.push(String(raw.subtype));
    if (typeof raw.durationMs === 'number') parts.push(`${raw.durationMs}ms`);
    if (raw.stopReason) parts.push(String(raw.stopReason));
    if (parts.length) return clip(parts.join(' · '));
  }
  return null;
}

export function hasThinkingBlock(raw: any | null): boolean {
  if (!raw?.message?.content || !Array.isArray(raw.message.content)) return false;
  return raw.message.content.some((b: any) =>
    b && typeof b === 'object' && (b.type === 'thinking' || b.type === 'redacted_thinking'),
  );
}

function clip(s: string): string {
  const trimmed = s.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= SUMMARY_MAX) return trimmed;
  return trimmed.slice(0, SUMMARY_MAX) + '…';
}

/**
 * Flatten a JSON string into a values-only, space-joined text blob for fuzzy search.
 * Strips keys to avoid false positives on field names like "command" or "file_path".
 * Caps total length to `maxLen` to bound fuse.js index size.
 */
function flattenJsonForSearch(jsonText: string, maxLen: number): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(jsonText); } catch { return jsonText.slice(0, maxLen); }
  const parts: string[] = [];
  const walk = (v: unknown) => {
    if (v == null) return;
    if (typeof v === 'string') { parts.push(v); return; }
    if (typeof v === 'number' || typeof v === 'boolean') { parts.push(String(v)); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (typeof v === 'object') { for (const x of Object.values(v as object)) walk(x); }
  };
  walk(parsed);
  const out = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (!out) return null;
  return out.length > maxLen ? out.slice(0, maxLen) : out;
}

/* ---------------------------------------------------------------------------
   Project-root resolution
     1. .git ancestor probe — for each cwd, walk up looking for `.git`.
        If any cwd resolves, group under the most-common .git root in the session.
     2. Longest-common-prefix fallback — when no .git is found.
     3. First cwd — when LCP is degenerate (e.g. single event).
--------------------------------------------------------------------------- */

const gitRootCache = new Map<string, string | null>();

function findGitRoot(cwd: string): string | null {
  if (gitRootCache.has(cwd)) return gitRootCache.get(cwd)!;
  let p = cwd;
  let depth = 0;
  while (p && p !== '/' && depth < 32) {
    if (existsSync(join(p, '.git'))) {
      gitRootCache.set(cwd, p);
      return p;
    }
    const next = dirname(p);
    if (next === p) break;
    p = next;
    depth++;
  }
  gitRootCache.set(cwd, null);
  return null;
}

function longestCommonPathPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  if (paths.length === 1) return paths[0]!;
  const split = paths.map((p) => p.split('/'));
  const min = Math.min(...split.map((s) => s.length));
  const common: string[] = [];
  for (let i = 0; i < min; i++) {
    const seg = split[0]![i];
    if (split.every((s) => s[i] === seg)) common.push(seg!);
    else break;
  }
  const joined = common.join('/');
  return joined || paths[0]!;
}

export function computeSessionRoot(cwds: string[]): string {
  if (cwds.length === 0) return '';
  if (cwds.length === 1) return findGitRoot(cwds[0]!) ?? cwds[0]!;

  // 1) git ancestor probe
  const counts = new Map<string, number>();
  for (const c of cwds) {
    const root = findGitRoot(c);
    if (root) counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  if (counts.size > 0) {
    let winner = '';
    let max = -1;
    for (const [root, n] of counts) if (n > max) { winner = root; max = n; }
    return winner;
  }

  // 2) LCP fallback (degrades gracefully to first cwd if LCP is empty)
  return longestCommonPathPrefix(cwds);
}

function stringifyToolResultLite(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c === 'object' && (c as any).type === 'text' && typeof (c as any).text === 'string') return (c as any).text;
    }
    return '';
  }
  if (content && typeof content === 'object') return JSON.stringify(content);
  return '';
}
