import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import { serve } from '@hono/node-server';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { openDb, Indexer, Queries, JsonlWatcher, type DB, type WatchEvent } from 'ccpulse-core';

export interface ServerOptions {
  port?: number;
  dbPath?: string;
  webDist?: string;
  claudeDir?: string;
}

export interface Server {
  start: () => Promise<{ port: number }>;
  stop: () => Promise<void>;
  bus: EventEmitter;
  db: DB;
}

export function createServer(opts: ServerOptions = {}): Server {
  const port = opts.port ?? 7878;
  const dbPath = opts.dbPath ?? join(homedir(), '.ccpulse', 'ccpulse.db');
  const db = openDb(dbPath);
  const indexer = new Indexer(db);
  const queries = new Queries(db);
  const watcher = new JsonlWatcher(indexer, opts.claudeDir);
  const bus = new EventEmitter();
  bus.setMaxListeners(0);

  watcher.on('ingest', (e: WatchEvent) => {
    queries.invalidate();
    bus.emit('ingest', e);
  });

  const app = new Hono();
  app.use('/api/*', cors());

  app.get('/api/health', (c) => c.json({ ok: true, totals: queries.totals() }));

  app.get('/api/projects', (c) => c.json(queries.listProjects()));

  app.get('/api/projects/:cwd/sessions', (c) => {
    const cwd = decodeURIComponent(c.req.param('cwd'));
    return c.json(queries.listSessions(cwd));
  });

  app.get('/api/projects/:cwd/tools', (c) => {
    const cwd = decodeURIComponent(c.req.param('cwd'));
    return c.json(queries.toolHistogram({ cwd }));
  });

  app.get('/api/projects/:cwd/models', (c) => {
    const cwd = decodeURIComponent(c.req.param('cwd'));
    return c.json(queries.modelBreakdown({ cwd }));
  });

  app.get('/api/sessions/:id', (c) => {
    const id = c.req.param('id');
    return c.json(queries.sessionTimeline(id));
  });

  app.get('/api/sessions/:id/tools', (c) => {
    const id = c.req.param('id');
    return c.json(queries.toolHistogram({ sessionId: id }));
  });

  app.get('/api/events/:uuid', (c) => {
    const uuid = c.req.param('uuid');
    const detail = queries.eventDetail(uuid);
    if (!detail) return c.notFound();
    return c.json(detail);
  });

  app.get('/api/totals', (c) => c.json(queries.totals()));

  app.get('/api/stream', (c) =>
    streamSSE(c, async (stream) => {
      const onIngest = async (e: WatchEvent) => {
        await stream.writeSSE({ event: 'ingest', data: JSON.stringify({ cwd: e.cwd, stats: e.stats }) });
      };
      bus.on('ingest', onIngest);
      const ping = setInterval(() => {
        stream.writeSSE({ event: 'ping', data: String(Date.now()) }).catch(() => {});
      }, 20_000);
      try {
        // hold the stream open until client disconnects
        await new Promise<void>((resolveOuter) => {
          const close = () => { clearInterval(ping); bus.off('ingest', onIngest); resolveOuter(); };
          stream.onAbort(close);
        });
      } finally {
        clearInterval(ping);
        bus.off('ingest', onIngest);
      }
    }),
  );

  // static (SPA) — try webDist, fallback to embedded next to build output
  const staticRoot = resolveStaticRoot(opts.webDist);
  if (staticRoot) {
    app.use('/*', serveStatic({ root: relativeToCwd(staticRoot) }));
    app.get('*', (c) => {
      const indexHtml = join(staticRoot, 'index.html');
      if (existsSync(indexHtml)) {
        return c.html(readFileSync(indexHtml, 'utf8'));
      }
      return c.text('UI not built. Run `pnpm build` or `pnpm --filter ccpulse-web dev`.', 500);
    });
  } else {
    app.get('/', (c) =>
      c.html(`<!doctype html><meta charset="utf-8"><title>ccpulse</title><body style="font-family:system-ui;padding:2rem"><h1>ccpulse daemon</h1><p>API ready at <code>/api/health</code>. UI not built — run <code>pnpm --filter ccpulse-web dev</code>.</p></body>`),
    );
  }

  let handle: ReturnType<typeof serve> | null = null;

  return {
    bus,
    db,
    start: async () => {
      const stats = watcher.backfill();
      // eslint-disable-next-line no-console
      console.log(`[ccpulse] backfill: ${stats.filesScanned} files, ${stats.events} events, ${stats.toolCalls} tool calls`);
      watcher.start();
      handle = serve({ fetch: app.fetch, port });
      return { port };
    },
    stop: async () => {
      await watcher.stop();
      if (handle) {
        const h = handle as unknown as { closeAllConnections?: () => void; close: (cb: () => void) => void };
        h.closeAllConnections?.();
        await new Promise<void>((r) => h.close(() => r()));
      }
      db.close();
    },
  };
}

function resolveStaticRoot(explicit?: string): string | null {
  if (explicit && existsSync(explicit)) return resolve(explicit);
  // candidates relative to daemon dist or src
  const candidates = [
    join(import.meta.dirname ?? '', 'embedded'),
    join(process.cwd(), 'packages/daemon/embedded'),
    join(process.cwd(), 'packages/web/dist'),
    join(import.meta.dirname ?? '', '../embedded'),
    join(import.meta.dirname ?? '', '../../web/dist'),
  ];
  for (const c of candidates) {
    if (existsSync(c) && safeIsDir(c)) return resolve(c);
  }
  return null;
}

function safeIsDir(p: string) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function relativeToCwd(p: string): string {
  // hono's serveStatic uses paths relative to process.cwd()
  const cwd = process.cwd();
  return p.startsWith(cwd) ? p.slice(cwd.length + 1) : p;
}
