# ccpulse

> See where your Claude Code tokens, time, and money actually go.

![ccpulse dashboard](https://raw.githubusercontent.com/omar-toma/ccpulse/main/docs/screenshot.png)

<!-- After uploading the demo clip, drag ccpulse-demo.mp4 into the GitHub README
     editor on this line so it renders as an inline player. -->

Live, local-first analytics for [Claude Code](https://claude.com/claude-code) —
tokens, cost, tool latency, and session timelines, sliced by project and session.
A daemon watches your local session logs, indexes them into SQLite, and serves a
dashboard. Nothing leaves your machine.

## Quickstart

```bash
npx @omartoma/ccpulse@latest          # starts the daemon and opens the dashboard
```

Or install globally:

```bash
npm i -g @omartoma/ccpulse
ccpulse                               # same thing
```

The daemon watches `~/.claude/projects/`, indexes events into SQLite, and serves
the dashboard at `http://localhost:7878`. To scope the dashboard to one project,
run `npx @omartoma/ccpulse@latest open` from that project's directory while the
daemon is running.

```bash
npx @omartoma/ccpulse@latest daemon --no-open   # daemon without auto-opening the browser
npx @omartoma/ccpulse@latest status             # check daemon health
npx @omartoma/ccpulse@latest reindex            # drop the SQLite index, rebuild on next start
```

## What it shows

- **Per-project rollups** — cost, tokens, sessions, and tool calls, with projects
  sorted by recency.
- **Per-session timeline** — sortable by time, in / out / cache↓ / cache↑, total
  tokens, or cost. Filter by kind (`tool` / `claude` / `user` / `system` /
  `attachment`). Click any row for the full event — message text, tool input JSON,
  hook payloads, the raw JSONL line.
- **Tool latency** — count, average, and p95, per project and per session.
- **Global time range** — scope every view to the last 24h / 7d / 30d, a custom
  window, or all time. The range lives in the URL, so it survives reloads and
  makes views shareable.

Live updates stream over SSE — click the status pill in the header to pause or
resume the subscription; resuming refreshes everything that changed while paused.

## Configuration

Environment variables:

| Variable             | Default                   | Purpose                          |
| -------------------- | ------------------------- | -------------------------------- |
| `CCPULSE_PORT`       | `7878`                    | Dashboard / API port             |
| `CCPULSE_DB`         | `~/.ccpulse/ccpulse.db`   | SQLite index location            |
| `CCPULSE_CLAUDE_DIR` | `~/.claude/projects`      | JSONL session-log root           |

Cost is estimated from a bundled per-model rate table. Override or extend it by
dropping a `~/.ccpulse/models.json` file.

## Limitations

- Reads `~/.claude/projects/*.jsonl` directly — if Anthropic changes that log
  format, parsing may need an update.
- Cost is an estimate from bundled rates; correct it via `~/.ccpulse/models.json`
  if the published rates drift.
- Built in an hour to scratch a personal itch. No roadmap — but issues and PRs
  are welcome.

Requires Node ≥ 22.5 (uses the built-in `node:sqlite`). The daemon is local and
your data stays on your disk.

---

MIT — [@omar-toma](https://github.com/omar-toma)
