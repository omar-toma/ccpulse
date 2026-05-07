import chokidar, { type FSWatcher } from 'chokidar';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { Indexer, IngestStats } from './indexer.js';

export const DEFAULT_CLAUDE_DIR = join(homedir(), '.claude', 'projects');

export interface WatchEvent {
  path: string;
  stats: IngestStats;
  cwd: string | null;
}

export class JsonlWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private pending = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private indexer: Indexer, private rootDir = DEFAULT_CLAUDE_DIR) {
    super();
  }

  /** Initial backfill across all jsonl files. */
  backfill(): IngestStats {
    const total: IngestStats = { filesScanned: 0, bytesRead: 0, events: 0, toolCalls: 0, toolResults: 0, aiTitles: 0 };
    if (!existsSync(this.rootDir)) return total;
    for (const projDir of readdirSync(this.rootDir)) {
      const projPath = join(this.rootDir, projDir);
      let st;
      try { st = statSync(projPath); } catch { continue; }
      if (!st.isDirectory()) continue;
      let entries: string[];
      try { entries = readdirSync(projPath); } catch { continue; }
      for (const name of entries) {
        if (!name.endsWith('.jsonl')) continue;
        const p = join(projPath, name);
        const s = this.indexer.ingestFile(p);
        total.filesScanned += s.filesScanned;
        total.bytesRead += s.bytesRead;
        total.events += s.events;
        total.toolCalls += s.toolCalls;
        total.toolResults += s.toolResults;
        total.aiTitles += s.aiTitles;
      }
    }
    return total;
  }

  start() {
    if (this.watcher) return;
    if (!existsSync(this.rootDir)) return;
    // Chokidar 4 removed glob support — watch the dir and filter via `ignored`.
    this.watcher = chokidar.watch(this.rootDir, {
      ignoreInitial: true,
      awaitWriteFinish: false,
      persistent: true,
      ignored: (path, stats) => {
        if (!stats) return false;            // unknown — let it through, will resolve on stat
        if (stats.isDirectory()) return false;
        return !path.endsWith('.jsonl');
      },
    });
    const handler = (event: string) => (path: string) => {
      if (process.env.CCPULSE_DEBUG_WATCHER) {
        // eslint-disable-next-line no-console
        console.log(`[watcher] ${event} ${path}`);
      }
      this.queue(path);
    };
    this.watcher.on('add', handler('add')).on('change', handler('change'));
    this.watcher.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[watcher] error', err);
    });
    if (process.env.CCPULSE_DEBUG_WATCHER) {
      this.watcher.on('ready', () => {
        // eslint-disable-next-line no-console
        console.log('[watcher] ready, watching', `${this.rootDir}/**/*.jsonl`);
      });
    }
  }

  private queue(path: string) {
    this.pending.add(path);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 150);
  }

  private flush() {
    this.flushTimer = null;
    const paths = [...this.pending];
    this.pending.clear();
    for (const p of paths) {
      const stats = this.indexer.ingestFile(p);
      if (stats.events || stats.toolCalls || stats.toolResults || stats.aiTitles || stats.bytesRead) {
        const cwd = this.cwdFromPath(p);
        const ev: WatchEvent = { path: p, stats, cwd };
        this.emit('ingest', ev);
      }
    }
  }

  private cwdFromPath(p: string): string | null {
    // dir name is encoded cwd: leading dash + slashes-as-dashes
    const parts = p.split('/');
    const dir = parts[parts.length - 2] ?? '';
    if (!dir) return null;
    // best-effort decode: replace `-` with `/`. Imperfect (cwds with dashes collide), but events also carry cwd.
    return dir.replace(/-/g, '/');
  }

  async stop() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.watcher) { await this.watcher.close(); this.watcher = null; }
  }
}
