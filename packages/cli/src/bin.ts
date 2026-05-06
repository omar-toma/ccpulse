#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { existsSync, unlinkSync } from 'node:fs';
import { createServer } from 'ccpulse-daemon';
import { openDb, Indexer } from 'ccpulse-core';

const DEFAULT_PORT = Number(process.env.CCPULSE_PORT) || 7878;
const DB_PATH = process.env.CCPULSE_DB || join(homedir(), '.ccpulse', 'ccpulse.db');

const args = process.argv.slice(2);
const cmd = args[0];

function parseFlag(name: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--')) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  return undefined;
}

async function runDaemon() {
  const port = Number(parseFlag('port')) || DEFAULT_PORT;
  const server = createServer({ port, dbPath: DB_PATH });
  const { port: actualPort } = await server.start();
  console.log(`ccpulse daemon listening on http://localhost:${actualPort}`);
  console.log(`open dashboard:    ccpulse open`);
  console.log(`db:                ${DB_PATH}`);
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
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
}

function help() {
  console.log(`ccpulse — real-time analytics for Claude Code sessions

usage:
  ccpulse daemon [--port N]      start the daemon (foreground)
  ccpulse open [--project PATH]  open dashboard in browser, scoped to project
  ccpulse status                 check daemon health
  ccpulse reindex                drop SQLite index, rebuild on next daemon start
  ccpulse --help                 this message

env:
  CCPULSE_PORT (default 7878)
  CCPULSE_DB   (default ~/.ccpulse/ccpulse.db)
`);
}

async function main() {
  switch (cmd) {
    case 'daemon': await runDaemon(); break;
    case 'open':   await runOpen();   break;
    case 'status': await runStatus(); break;
    case 'reindex': runReindex(); break;
    case '--help':
    case '-h':
    case 'help':
    case undefined:
      help(); break;
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
