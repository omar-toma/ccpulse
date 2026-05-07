# ccpulse

Real-time analytics dashboard for Claude Code sessions. Local-first: a daemon
watches `~/.claude/projects/**/*.jsonl`, indexes events into SQLite, and serves
a REST + SSE API consumed by an embedded React SPA.

## Install

```bash
npm install -g ccpulse
```

Requires Node 22 or later. No native compilation needed (uses `node:sqlite`).

## Usage

```bash
ccpulse daemon          # start the server (default port 7878)
ccpulse open            # open the dashboard in your browser, scoped to $PWD
ccpulse status
ccpulse reindex         # drop the SQLite index; rebuild on next daemon start
```

## Environment

- `CCPULSE_PORT` — HTTP port (default `7878`)
- `CCPULSE_DB` — SQLite path (default `~/.ccpulse/ccpulse.db`)
- `CCPULSE_CLAUDE_DIR` — JSONL root (default `~/.claude/projects`)

## License

MIT
