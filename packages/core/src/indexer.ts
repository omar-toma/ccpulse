import { openSync, readSync, closeSync, statSync, existsSync } from 'node:fs';
import type { DB } from './db.js';
import { parseLine } from './parser.js';
import type { ParsedLine } from './parser.js';

const CHUNK = 1 << 16;

export interface IngestStats {
  filesScanned: number;
  bytesRead: number;
  events: number;
  toolCalls: number;
  toolResults: number;
  aiTitles: number;
}

export class Indexer {
  private upsertEvent;
  private upsertToolCall;
  private upsertToolResult;
  private upsertProject;
  private upsertSession;
  private updateSessionTitle;
  private getOffset;
  private setOffset;

  constructor(private db: DB) {
    this.upsertEvent = db.prepare(`
      INSERT INTO events (uuid, session_id, parent_uuid, type, role, ts, cwd, git_branch, version,
                          is_sidechain, model, input_tokens, output_tokens, cache_read, cache_create,
                          tool_name, tool_use_id, tool_result_for_id)
      VALUES (@uuid, @sessionId, @parentUuid, @type, @role, @ts, @cwd, @gitBranch, @version,
              @isSidechain, @model, @inputTokens, @outputTokens, @cacheRead, @cacheCreate,
              @toolName, @toolUseId, @toolResultForId)
      ON CONFLICT(uuid) DO NOTHING
    `);
    this.upsertToolCall = db.prepare(`
      INSERT INTO tool_calls (tool_use_id, session_id, event_uuid, ts, name, input_json)
      VALUES (@toolUseId, @sessionId, @eventUuid, @ts, @name, @inputJson)
      ON CONFLICT(tool_use_id) DO NOTHING
    `);
    this.upsertToolResult = db.prepare(`
      INSERT INTO tool_results (tool_use_id, session_id, event_uuid, ts, is_error)
      VALUES (@toolUseId, @sessionId, @eventUuid, @ts, @isError)
      ON CONFLICT(tool_use_id) DO NOTHING
    `);
    this.upsertProject = db.prepare(`
      INSERT INTO projects (cwd, last_active) VALUES (?, ?)
      ON CONFLICT(cwd) DO UPDATE SET last_active = MAX(last_active, excluded.last_active)
    `);
    this.upsertSession = db.prepare(`
      INSERT INTO sessions (id, cwd, started_at, ended_at, branch) VALUES (@id, @cwd, @ts, @ts, @branch)
      ON CONFLICT(id) DO UPDATE SET
        cwd = COALESCE(excluded.cwd, sessions.cwd),
        started_at = MIN(sessions.started_at, excluded.started_at),
        ended_at = MAX(sessions.ended_at, excluded.ended_at),
        branch = COALESCE(excluded.branch, sessions.branch)
    `);
    this.updateSessionTitle = db.prepare(`
      INSERT INTO sessions (id, title) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title
    `);
    this.getOffset = db.prepare(`SELECT offset, inode, size FROM file_offsets WHERE path = ?`);
    this.setOffset = db.prepare(`
      INSERT INTO file_offsets (path, offset, inode, size) VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, inode = excluded.inode, size = excluded.size
    `);
  }

  /** Ingest new bytes from a JSONL file since last offset. */
  ingestFile(path: string): IngestStats {
    const stats: IngestStats = { filesScanned: 1, bytesRead: 0, events: 0, toolCalls: 0, toolResults: 0, aiTitles: 0 };
    if (!existsSync(path)) return stats;
    const fileStat = statSync(path);
    const prev = this.getOffset.get(path) as { offset: number; inode: number; size: number } | undefined;
    let startOffset = prev?.offset ?? 0;
    if (prev && (prev.inode !== fileStat.ino || fileStat.size < prev.size)) {
      startOffset = 0; // file rotated/truncated
    }
    if (startOffset >= fileStat.size) return stats;

    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(CHUNK);
      let pos = startOffset;
      let leftover = '';
      const lines: string[] = [];
      while (pos < fileStat.size) {
        const toRead = Math.min(CHUNK, fileStat.size - pos);
        const n = readSync(fd, buf, 0, toRead, pos);
        if (n <= 0) break;
        const chunk = leftover + buf.subarray(0, n).toString('utf8');
        const split = chunk.split('\n');
        leftover = split.pop() ?? '';
        for (const l of split) lines.push(l);
        pos += n;
        stats.bytesRead += n;
      }
      // If file ends without newline, leftover is partial — keep it for next round by NOT advancing past it
      const finalOffset = leftover.length ? fileStat.size - Buffer.byteLength(leftover, 'utf8') : fileStat.size;

      this.applyLines(lines, stats);
      this.setOffset.run(path, finalOffset, fileStat.ino, fileStat.size);
    } finally {
      closeSync(fd);
    }
    return stats;
  }

  private applyLines(lines: string[], stats: IngestStats) {
    const apply = this.db.transaction((batch: ParsedLine[]) => {
      for (const p of batch) {
        if (p.aiTitle) {
          this.updateSessionTitle.run(p.aiTitle.sessionId, p.aiTitle.title);
          stats.aiTitles++;
          continue;
        }
        if (p.event) {
          const e = p.event;
          this.upsertEvent.run(e);
          stats.events++;
          if (e.cwd) this.upsertProject.run(e.cwd, e.ts);
          this.upsertSession.run({ id: e.sessionId, cwd: e.cwd, ts: e.ts, branch: e.gitBranch });
        }
        for (const tc of p.toolCalls) {
          this.upsertToolCall.run(tc);
          stats.toolCalls++;
        }
        for (const tr of p.toolResults) {
          this.upsertToolResult.run(tr);
          stats.toolResults++;
        }
      }
    });

    const parsed = lines.map(parseLine).filter((p) => p.event || p.aiTitle || p.toolCalls.length || p.toolResults.length);
    if (parsed.length) apply(parsed);
  }

  /** Drop all data and reset offsets. Used by `ccpulse reindex`. */
  reset() {
    this.db.exec(`
      DELETE FROM events;
      DELETE FROM tool_calls;
      DELETE FROM tool_results;
      DELETE FROM sessions;
      DELETE FROM projects;
      DELETE FROM file_offsets;
    `);
  }
}
