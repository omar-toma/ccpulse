#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'ccpulse-daemon';
import { openDb, Indexer } from 'ccpulse-core';

const VERSION = readPackageVersion();

function readPackageVersion(): string {
  // Walk up from this file looking for package.json with "name": "ccpulse" / "@omartoma/ccpulse".
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      const pkg = join(dir, 'package.json');
      if (existsSync(pkg)) {
        const j = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string; version?: string };
        if (j.name && j.version && (j.name === 'ccpulse' || j.name.endsWith('/ccpulse'))) return j.version;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* fall through */ }
  return '0.0.0';
}

const DEFAULT_PORT = Number(process.env.CCPULSE_PORT) || 7878;
const DB_PATH = process.env.CCPULSE_DB || join(homedir(), '.ccpulse', 'ccpulse.db');

const args = process.argv.slice(2);
// Treat a leading flag (`--port`, `--no-open`, etc.) as "no subcommand" so that
// `ccpulse --port 8833` is equivalent to `ccpulse daemon --port 8833`.
const cmd = args[0]?.startsWith('-') ? undefined : args[0];

function parseFlag(name: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--')) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  return undefined;
}

async function runDaemon() {
  const port = Number(parseFlag('port')) || DEFAULT_PORT;
  const noOpen = args.includes('--no-open');
  const server = createServer({ port, dbPath: DB_PATH });
  const { port: actualPort } = await server.start();
  const baseUrl = `http://localhost:${actualPort}`;
  console.log(`ccpulse daemon listening on ${baseUrl}`);
  console.log(`db:                ${DB_PATH}`);
  if (!noOpen) {
    const url = await urlForCwd(baseUrl);
    openInBrowser(url);
    console.log(`opened ${url}`);
  }
  let shuttingDown = false;
  const shutdown = async (sig: NodeJS.Signals) => {
    if (shuttingDown) { process.exit(1); return; }
    shuttingDown = true;
    console.log(`\n[ccpulse] ${sig} received, shutting down`);
    const deadline = setTimeout(() => {
      console.error('[ccpulse] forced exit after 2s grace period');
      process.exit(1);
    }, 2000);
    deadline.unref();
    try { await server.stop(); } catch (e) { console.error(e); }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runOpen() {
  const port = Number(parseFlag('port')) || DEFAULT_PORT;
  const project = parseFlag('project') || process.cwd();
  const url = `http://localhost:${port}/?project=${encodeURIComponent(project)}`;

  // ping daemon first
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error('not ok');
  } catch {
    console.error(`ccpulse: daemon not reachable on port ${port}.`);
    console.error(`start it in another terminal:  ccpulse daemon`);
    process.exit(1);
  }
  openInBrowser(url);
  console.log(`opened ${url}`);
}

async function runStatus() {
  const port = Number(parseFlag('port')) || DEFAULT_PORT;
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const data = await res.json() as { ok: boolean; totals: { eventCount: number; sessionCount: number; projectCount: number } };
    console.log(`daemon:    up on http://localhost:${port}`);
    console.log(`projects:  ${data.totals.projectCount}`);
    console.log(`sessions:  ${data.totals.sessionCount}`);
    console.log(`events:    ${data.totals.eventCount}`);
  } catch {
    console.log(`daemon:    down (no response on port ${port})`);
    process.exit(1);
  }
}

function runReindex() {
  if (existsSync(DB_PATH)) {
    const db = openDb(DB_PATH);
    new Indexer(db).reset();
    db.close();
    console.log(`cleared index at ${DB_PATH}. start daemon to rebuild.`);
  } else {
    console.log(`no index at ${DB_PATH}`);
  }
}

function openInBrowser(url: string) {
  const p = platform();
  const child = p === 'win32'
    ? spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' })
    : spawn(p === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.on('error', (err) => {
    console.warn(`could not open browser: ${(err as Error).message}`);
  });
  child.unref();
}

/**
 * Pick a dashboard URL based on the current working directory:
 *   1. If a tracked project root === cwd, scope to it.
 *   2. Else if a tracked project root is an ANCESTOR of cwd (e.g. cwd is inside
 *      the repo), scope to that root (deepest match wins).
 *   3. Otherwise fall back to the all-projects landing page.
 */
async function urlForCwd(baseUrl: string): Promise<string> {
  const cwd = process.cwd();
  try {
    const res = await fetch(`${baseUrl}/api/projects`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return baseUrl;
    const projects = (await res.json()) as Array<{ cwd: string }>;
    const exact = projects.find((p) => p.cwd === cwd);
    if (exact) return `${baseUrl}/?project=${encodeURIComponent(exact.cwd)}`;
    const ancestors = projects
      .filter((p) => cwd === p.cwd || cwd.startsWith(p.cwd + '/'))
      .sort((a, b) => b.cwd.length - a.cwd.length);
    if (ancestors[0]) return `${baseUrl}/?project=${encodeURIComponent(ancestors[0].cwd)}`;
  } catch { /* ignore — fall back below */ }
  return baseUrl;
}

function help() {
  console.log(`ccpulse v${VERSION} — real-time analytics for Claude Code sessions

usage:
  ccpulse [--port N] [--no-open]            start daemon and open dashboard (default)
  ccpulse daemon [--port N] [--no-open]     same, explicit
  ccpulse open [--project PATH] [--port N]  open dashboard in browser, scoped to project
  ccpulse status [--port N]                 check daemon health
  ccpulse reindex                           drop SQLite index, rebuild on next daemon start
  ccpulse --version                         print version
  ccpulse --help                            this message

env:
  CCPULSE_PORT (default 7878)
  CCPULSE_DB   (default ~/.ccpulse/ccpulse.db)
`);
}

async function main() {
  // Help / version flags work at any position.
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') return help();
  if (args.includes('--version') || args.includes('-v') || args[0] === 'version') return void console.log(VERSION);
  switch (cmd) {
    case undefined:
    case 'daemon': await runDaemon(); break;
    case 'open':   await runOpen();   break;
    case 'status': await runStatus(); break;
    case 'reindex': runReindex(); break;
    default:
      console.error(`unknown command: ${cmd}`);
      help();
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// suppress unused var warning during build
void unlinkSync;
