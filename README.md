# herdr-wake

A herdr plugin that lets idle Claude Code sessions sleep and wakes them when there is work:

- **Reaper.** A session that sat idle for an hour is put to sleep: it gets `/exit`, the pane
  stays, labelled `💤 <name>`, with `cldt --resume <session id>` already typed at its
  prompt (press Enter to wake it yourself).
- **Telegram router.** Your Telegram messages reach sessions without Claude Code channels.
  It works with [tg-mcp](https://github.com/Eithery-rc/tg-mcp) in router mode (`ROUTER=1`,
  tg-mcp 0.2.0 or newer): the router long-polls tg-mcp, finds the pane a message is for,
  wakes the session there if it sleeps, and types the message in.
- **Handoff between sessions.** `ListAgents` also lists the sleeping sessions, and a
  `SendMessage` to a sleeping one wakes it first (Claude Code hooks, see below).

Waking always goes through `cldt --resume <session id>`, so a session comes back with the
same environment it was started with, under the same name.

## Reaper

Every minute the router asks two sources: herdr (`api snapshot`) and Claude Code's own
session registry, `~/.claude/sessions/<pid>.json` (what `ListAgents` reads). A session is
put to sleep when all of these hold:

- Claude reports it `idle` for at least `idleMinutes`. `busy` and `shell` (a background
  command such as a waiter or a Monitor) keep it up.
- herdr sees it idle too, not blocked on a question.
- Its pane is not the focused one, and its input box holds no draft.
- It is not excluded in `config.json`.
- Its transcript shows no `CronCreate` or `ScheduleWakeup` call in the last 7 days. Such
  jobs live only in the session's memory and would die with it.

At most `maxPerRound` sessions go to sleep per minute. `node src/router.mjs --reap-dry`
shows the current verdict for every Claude pane.

## How a Telegram message is routed

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

`cldt` no longer starts Claude with development channels (since 2026-10-13). Sessions
started the old way ask for a confirmation on start; the router answers that one dialog
(only that one). The folder trust question ("Yes, I trust this folder") is left to you:
the router says so in the topic and delivers once you have answered. Claude can ask it for
a folder that inherited trust from a parent before, once it has written an explicit
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

Hooks in `~/.claude/settings.json`:

```json
"PreToolUse":  [{ "matcher": "SendMessage", "hooks": [{ "type": "command", "command": "node \"C:\\Work\\Personal\\herdr-wake\\src\\hook.mjs\" pre-send", "timeout": 180 }] }],
"PostToolUse": [{ "matcher": "ListAgents",  "hooks": [{ "type": "command", "command": "node \"C:\\Work\\Personal\\herdr-wake\\src\\hook.mjs\" post-list", "timeout": 10 }] }]
```

Both do nothing when the router is not running.

Optional `config.json` in `herdr plugin config-dir herdr-wake`:

| Key | Default | Meaning |
| --- | --- | --- |
| `reaper.enabled` | `false` | put idle sessions to sleep |
| `reaper.idleMinutes` | `60` | how long a session must sit idle |
| `reaper.exclude` | `[]` | session names, workspace labels or titles never to put to sleep; exact (any case) or `"/regex/"` |
| `reaper.maxPerRound` | `3` | sessions put to sleep per minute at most |
| `url`, `authorization` | from `~/.claude.json` | tg-mcp base url (without `/mcp`) and the `Authorization` header value |
| `server` | `telegram` | MCP server in `~/.claude.json` to take them from |
| `wakeCommand` | `cldt --resume {session}` | command typed into the pane to resume a session |
| `wakeTimeoutSec` | `120` | how long to wait for a resumed session |
| `pollTimeoutSec` | `25` | long poll length |
| `port` | `12421` | local API; also keeps the router single-instance |
| `workspace` | `tg-router` | workspace the router pane lives in |

## Operating it

- herdr actions for the focused pane: `herdr-wake.sleep`, `herdr-wake.wake` (bind them to
  keys with `[[keys.command]]`, `type = "plugin_action"`).
- Local API on `127.0.0.1:12421`: `GET /status`, `GET /sleeping`,
  `POST /wake {"target": ...}`, `POST /sleep {"target": ...}`; a target is a session name,
  a pane id or a session id.
- Log: `router.log` in `%LOCALAPPDATA%\herdr\plugins\herdr-wake`, next to `sessions.json`.
- Route a message by hand, without the server:
  `node src/router.mjs --deliver "topic:Billing" "text"`.
- Tests: `npm test`.
