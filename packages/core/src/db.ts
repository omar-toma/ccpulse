import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = InstanceType<typeof DatabaseSync>;

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  cwd TEXT PRIMARY KEY,
  last_active INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  cwd TEXT,
  title TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  branch TEXT
);

CREATE TABLE IF NOT EXISTS events (
  uuid TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_uuid TEXT,
  type TEXT NOT NULL,
  role TEXT,
  ts INTEGER NOT NULL,
  cwd TEXT,
  git_branch TEXT,
  version TEXT,
  is_sidechain INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_create INTEGER NOT NULL DEFAULT 0,
  tool_name TEXT,
  tool_use_id TEXT,
  tool_result_for_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_session_ts ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_cwd ON events(cwd);
CREATE INDEX IF NOT EXISTS idx_events_tool ON events(tool_name);
CREATE INDEX IF NOT EXISTS idx_events_role ON events(role);

CREATE TABLE IF NOT EXISTS tool_calls (
  tool_use_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_uuid TEXT NOT NULL,
  ts INTEGER NOT NULL,
  name TEXT NOT NULL,
  input_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(name);

CREATE TABLE IF NOT EXISTS tool_results (
  tool_use_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_uuid TEXT NOT NULL,
  ts INTEGER NOT NULL,
  is_error INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS file_offsets (
  path TEXT PRIMARY KEY,
  offset INTEGER NOT NULL,
  inode INTEGER,
  size INTEGER
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export function openDb(path: string): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);
  return db;
}

export function withTransaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
