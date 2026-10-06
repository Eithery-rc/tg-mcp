# tg-mcp

Remote Telegram MCP server for Claude Code agents. One Bun process; clients connect over
Streamable HTTP. See README.md for the user-facing picture.

## Layout
- `src/main.ts` — Bun.serve: `/health`, `/mcp` (bearer auth), `/notify`; starts Telegram long polling
- `src/hub.ts` — session registry, topic per working dir, inbound routing, `ask`, permission relay
- `src/mcp.ts` — per-session McpServer: tools + `claude/channel` capabilities
- `src/telegram.ts` — minimal Bot API client; `src/store.ts` — bun:sqlite (topics, inbox)
- `src/format.ts` — Markdown → Telegram HTML + chunking (tested in `format.test.ts`)

## Rules
- Secrets live only in `.env` (git-ignored). `.githooks/pre-commit` blocks bot tokens and
  `.env` values; keep `git config core.hooksPath .githooks` set.
- Use Bun APIs (bun:sqlite, Bun.serve, bun test); Bun loads `.env` itself.

## Commands
- `bun test`, `bun run typecheck`
- Deployed as a systemd user unit: `systemctl --user restart tg-mcp`, logs `journalctl --user -u tg-mcp -f`
- Public endpoint: nginx `location /tg-mcp/` → 127.0.0.1:8790
