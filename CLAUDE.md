# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`ccpulse` is a local-first dashboard for Claude Code session analytics. A daemon watches `~/.claude/projects/**/*.jsonl`, indexes events into SQLite, and serves a REST + SSE API consumed by an embedded React SPA. Single npm package, pnpm workspaces internally.

## Common commands

Run from the repo root unless noted.

```bash
# install (first time, or after dependency changes)
pnpm install

# native binding for better-sqlite3 — required after a Node version change
pnpm rebuild better-sqlite3

# package-level builds (each emits dist/)
pnpm --filter ccpulse-core build
pnpm --filter ccpulse-daemon build
pnpm --filter ccpulse build              # the CLI package, name is bare `ccpulse`
pnpm --filter ccpulse-web build

# embed the web bundle into the daemon (must run after web build)
pnpm exec tsx scripts/embed-web.ts

# typecheck everything
pnpm -r typecheck

# tests (vitest, currently only in core)
pnpm --filter ccpulse-core test
pnpm --filter ccpulse-core test -- src/parser.test.ts -t "ai-title"   # single test

# dev loop — daemon + Vite with API proxy
pnpm dev:daemon      # terminal 1 — Hono server on :7878, no UI bundle
pnpm dev:web         # terminal 2 — Vite on :5174, proxies /api → :7878
```

The full release build is: `core` → `web` → `daemon` → `cli` → `embed-web.ts`. `package.json`'s `build` script runs them in order.

## Running the built CLI

```bash
node packages/cli/dist/bin.js daemon          # foreground server
node packages/cli/dist/bin.js open            # opens browser scoped to $PWD
node packages/cli/dist/bin.js status
node packages/cli/dist/bin.js reindex         # drops SQLite, rebuilds on next daemon start
```

Env: `CCPULSE_PORT` (default 7878), `CCPULSE_DB` (default `~/.ccpulse/ccpulse.db`), `CCPULSE_CLAUDE_DIR` (override the JSONL root for tests).

## Data flow you need to understand

```
~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl  ← canonical event log (append-only)
        │
        ▼
  watcher.ts (chokidar)  ─►  indexer.ts  ─►  SQLite (~/.ccpulse/ccpulse.db)
        │                                          │
        ▼                                          ▼
  EventEmitter                               queries.ts
        │                                          │
        └────► server.ts (Hono) ──► /api/* + /api/stream (SSE) ──► web SPA
```

- JSONL is the source of truth. SQLite is a rebuildable index. Event UUIDs are unique; ingest is idempotent (`INSERT … ON CONFLICT(uuid) DO NOTHING`).
- The watcher tracks per-file byte offsets in `file_offsets`, so a daemon restart only re-ingests new bytes. If the file rotates (inode changes or size shrinks) the offset resets to 0.
- SSE pushes `ingest` events from the watcher's EventEmitter; the web client uses them only as cache-invalidation triggers, then refetches.

## Architecture notes that are not obvious from reading one file

**Sessions can span multiple cwds.** A single session UUID can have events with different `cwd` values (the user `cd`'d mid-session). This is why:
- `Queries.listSessions(cwd)` is derived from the `events` table (`WHERE e.cwd = ?`), not from `sessions.cwd`. Adding cwd-scoped queries that join through `sessions.cwd` will silently miss sessions.
- `upsertSession`'s `ON CONFLICT` does `cwd = COALESCE(excluded.cwd, sessions.cwd)` — last-event cwd wins. Don't flip this back to `COALESCE(sessions.cwd, excluded.cwd)`; that pins a session to its first cwd and breaks `listSessions` for any project the session moved into.

**Tool calls and tool results are separate tables.** `tool_calls` (assistant emits) and `tool_results` (user message replies) join on `tool_use_id`. Latency = `tool_results.ts - tool_calls.ts`. The `events` table also carries `tool_name` / `tool_use_id` / `tool_result_for_id` denormalized for cheap filtering, but the join through the dedicated tables is what powers per-tool latency stats.

**Event content is NOT in the events table.** Only metadata is indexed. To show message text, tool input JSON, attachment payload, system hook details, etc., `Queries.eventDetail` reads the raw JSONL line from disk via `readRawJsonlByUuid`, cached per-file by `mtime`. Don't try to add a SQL column for content — it bloats the DB and the cache is fast enough.

**Pricing is per-model, with prefix fallback.** `pricing.ts` has a static rate table for Claude 4.x models. Lookup tries exact match, then prefix match (so `claude-sonnet-4-6-foo` resolves to `claude-sonnet-4-6`), then `__default__`. Override at `~/.ccpulse/models.json`; the loader merges over defaults and caches forever (process restart to reload).

**Cwd encoding.** Directories under `~/.claude/projects/` are encoded cwds with `/` replaced by `-`. The decode is lossy (real cwds with `-` collide), so the codebase always reads `cwd` from the event payload and uses the directory name only as a hint.

**Web bundle is embedded, not separate.** `daemon/src/server.ts:resolveStaticRoot` walks candidate paths to find a built bundle: `packages/daemon/embedded` (production), then `packages/web/dist` (post-build but pre-embed), then dirname-relative variants. After editing web code, re-run `pnpm --filter ccpulse-web build && pnpm exec tsx scripts/embed-web.ts` (or restart `pnpm dev:web` for HMR).

## Operational gotchas

- **Node 25 + better-sqlite3**: there is no prebuilt binding for current Node. `pnpm` requires `pnpm.onlyBuiltDependencies: ["better-sqlite3"]` in the root `package.json` to compile from source on install. If you change Node major versions, run `pnpm rebuild better-sqlite3`.
- **TanStack Router route tree** at `packages/web/src/routeTree.gen.ts` is generated by the Vite plugin on dev/build. It's gitignored; if `tsc --noEmit` runs before Vite ever has, it will error. The web `build` script intentionally calls only `vite build` and not `tsc -b` for that reason. Use `pnpm typecheck` separately.
- **SSE connections keep the HTTP server alive on shutdown.** `server.stop()` calls `closeAllConnections()` before `close()` so SIGINT exits cleanly. The CLI also has a 2-second forced-exit deadline as a safety net. Don't remove either.
- **Frontend is dark-only**, with `darkMode: 'class'` and `<html class="dark">` set in `main.tsx`. The Tailwind palette uses local tokens (`ink-*`, `pulse`); Tremor classes are mapped to the same tokens via `tailwind.config.js` `theme.extend.colors`.

## Where to make common changes

- New API endpoint: `daemon/src/server.ts` (route) + `core/src/queries.ts` (query method).
- New aggregation: `core/src/queries.ts`.
- New event type rendering in modal: `web/src/routes/session.$sid.tsx`, in `extractContent` and `ContentBlock` (text/thinking/tool_use/tool_result/attachment_card/system_card).
- New filter chip kind: extend the `KINDS` tuple, `eventKind` mapper, and `KIND_STYLES` map in `session.$sid.tsx`.
- Pricing: `core/src/pricing.ts` — bundled defaults plus `~/.ccpulse/models.json` override.
- Schema migration: edit `core/src/db.ts`'s `SCHEMA` (CREATE TABLE IF NOT EXISTS is idempotent for additions). Existing rows won't backfill new columns; document that and tell users to `ccpulse reindex`.
