# herdr-wake

A herdr plugin that delivers your Telegram messages to Claude Code sessions without
Claude Code channels. It works with [tg-mcp](https://github.com/Eithery-rc/tg-mcp) in
router mode (`ROUTER=1`, tg-mcp 0.2.0 or newer).

The router long-polls tg-mcp for messages that no channel session took, finds the herdr
pane the message is for, and types it in. If the Claude session in that pane has exited,
it resumes it first with `cldt --resume <session id>`, so the session comes back with the
same environment it was started with.

## How a message is routed

1. Candidate panes: the pane behind the bot message you replied to, panes connected to
   tg-mcp for the topic, then the panes of the herdr tab the topic is named after (the
   rule from `cldt.ps1`: first tab `topic:<workspace>`, other tabs
   `topic:<workspace> / <tab>`, non-ASCII stripped).
2. A pane running Claude wins. Otherwise a pane whose last Claude session the router has
   seen (it records them every 15 seconds) is resumed there.
3. The prompt is typed with `herdr agent prompt`, starting with
   `[telegram message_id=... ]`; tg-mcp tells agents to answer such prompts with `send`.
   Several messages for one topic go as one prompt.
4. The router acks: delivered gets 👀 (plus "⏰ Разбудил сессию" after a wake). If the
   session waits for a decision, or the input box holds text you are typing, it retries
   later and says so once. If no pane fits, the message goes back to tg-mcp's queue with a
   note, and the agent gets it when it connects.

cldt starts Claude with development channels, which asks for a confirmation on start. The
router answers that one dialog (only that one) when it wakes a session or finds one
stuck on it. The folder trust question ("Yes, I trust this folder") is left to you: the
router says so in the topic and delivers once you have answered. Claude can ask it for a
folder that inherited trust from a parent before, once it has written an explicit
`hasTrustDialogAccepted: false` for it into `~/.claude.json`.

## Setup

```bash
herdr plugin link C:\Work\Personal\herdr-wake
herdr plugin action invoke herdr-wake.start
```

The start action (and the startup hook after a herdr restart) opens the router in its own
workspace, `tg-router`. The url and token default to the `telegram` MCP server in
`~/.claude.json`. To pass pane hints, the client sends:

```
X-Herdr-Pane: ${COMPUTERNAME:-}:${HERDR_PANE_ID:-}
```

The machine prefix keeps a hint from another machine's herdr from matching a local pane.

Optional `config.json` in `herdr plugin config-dir herdr-wake`:

| Key | Default | Meaning |
| --- | --- | --- |
| `url`, `authorization` | from `~/.claude.json` | tg-mcp base url (without `/mcp`) and the `Authorization` header value |
| `server` | `telegram` | MCP server in `~/.claude.json` to take them from |
| `wakeCommand` | `cldt --resume {session}` | command typed into the pane to resume a session |
| `wakeTimeoutSec` | `120` | how long to wait for a resumed session |
| `pollTimeoutSec` | `25` | long poll length |
| `port` | `12421` | local status endpoint; also keeps the router single-instance |
| `workspace` | `tg-router` | workspace the router pane lives in |

## Operating it

- Status: `http://127.0.0.1:12421/status` (last poll, last error, sessions seen per pane).
- Log: `router.log` in `%LOCALAPPDATA%\herdr\plugins\herdr-wake`, next to `sessions.json`.
- Route a message by hand, without the server:
  `node src/router.mjs --deliver "topic:Billing" "text"`.
- Tests: `npm test`.
