# ccpulse

Real-time analytics dashboard for Claude Code sessions. Local-first: a daemon
watches `~/.claude/projects/**/*.jsonl`, indexes events into SQLite, and serves
a REST + SSE API consumed by an embedded React SPA.

## Install

```bash
npm install -g @omartoma/ccpulse
```

Or run without installing:

```bash
npx @omartoma/ccpulse
```

Requires Node 22 or later. No native compilation needed (uses `node:sqlite`).

## Usage

```bash
ccpulse                  # start daemon and open dashboard (default)
ccpulse daemon           # start the server, opens browser; add --no-open to suppress
ccpulse open             # open the dashboard scoped to $PWD (daemon must be running)
ccpulse status
ccpulse reindex          # drop the SQLite index; rebuild on next daemon start
```

## Environment

- `CCPULSE_PORT` — HTTP port (default `7878`)
- `CCPULSE_DB` — SQLite path (default `~/.ccpulse/ccpulse.db`)
- `CCPULSE_CLAUDE_DIR` — JSONL root (default `~/.claude/projects`)

## License

MIT
