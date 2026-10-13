# herdr-wake

A [herdr](https://herdr.dev) plugin that lets idle Claude Code sessions sleep and wakes them
when there is work for them:

- **Reaper.** A session that sat idle for an hour is put to sleep: it gets `/exit`, the pane
  stays, labelled `💤 <name>`, with the resume command already typed at its prompt (press
  Enter to wake it yourself).
- **Telegram router.** Your Telegram messages reach sessions without Claude Code channels.
  It works with [tg-mcp](../README.md) in router mode (`ROUTER=1`, tg-mcp 0.2.0 or newer):
  the router long-polls tg-mcp, finds the pane a message is for, wakes the session there if
  it sleeps, and types the message in.
- **Handoff between sessions.** `ListAgents` also lists the sleeping sessions, and a
  `SendMessage` to a sleeping one wakes it first (Claude Code hooks, see Setup). For the
  running ones it adds how long each has been idle or busy and when it goes to sleep;
  `ListAgents` itself only shows when a session's process started.

Waking runs `wakeCommand` in the session's pane (`claude --resume <session id>` by
default; point it at your own launcher if you have one), so the session comes back in the
same pane, under the same name, with the same transcript.

Tested on Windows (PowerShell panes). Linux and macOS should work, but have not been tried.

## Setup

1. tg-mcp server: set `ROUTER=1` in its `.env` and restart it (only needed for Telegram).
2. Install and start the plugin. The router runs in a pane of its own workspace,
   `tg-router`, and comes back by itself after a herdr restart (startup hook).

   ```bash
   herdr plugin install Eithery-rc/tg-mcp/herdr-wake
   herdr plugin action invoke herdr-wake.start
   ```

3. Install the Claude Code hooks (they make sleeping sessions visible in `ListAgents` and
   wake them on `SendMessage`; both do nothing while the router is not running):

   ```bash
   herdr plugin action invoke herdr-wake.install-hooks
   ```

4. Turn the reaper on and adjust the wake command in `config.json`, in the directory
   `herdr plugin config-dir herdr-wake` prints. Restart the router afterwards (close its
   pane, then `herdr plugin action invoke herdr-wake.start`).

   ```json
   {
     "wakeCommand": "claude --resume {session}",
     "reaper": { "enabled": true, "idleMinutes": 60, "exclude": ["/monitor/"] }
   }
   ```

5. Optional, for exact Telegram routing: let sessions tell tg-mcp which pane they run in.
   Add this header to the `telegram` MCP server in `~/.claude.json`, next to `X-Cwd`:

   ```
   X-Herdr-Pane: ${COMPUTERNAME:-}:${HERDR_PANE_ID:-}     (Windows)
   X-Herdr-Pane: ${HERDR_PANE_ID:-}                       (Linux, macOS)
   ```

   The machine prefix keeps a hint from another machine's herdr from matching a local pane.

The tg-mcp url and token are taken from the `telegram` MCP server in `~/.claude.json`.
Sessions can then drop `--dangerously-load-development-channels` and `X-Channel`: the
router types your messages into their pane instead.

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
  jobs live in the session and would stop with it.

If `/exit` still asks whether to stop background tasks, the router cancels and leaves the
session running. At most `maxPerRound` sessions go to sleep per minute.
`node src/router.mjs --reap-dry` shows the current verdict for every Claude pane.

## How a Telegram message is routed

1. Candidate panes: the pane behind the bot message you replied to, panes connected to
   tg-mcp for the topic, then the panes the topic's routing key names. A key of the form
   `topic:<workspace>` / `topic:<workspace> / <tab>` names a herdr tab (the launcher
   example in tg-mcp's README, non-ASCII stripped); any other key is matched against the
   panes' working directories.
2. A pane running Claude wins. Otherwise a pane whose last Claude session the router has
   seen (it records them every 15 seconds) is resumed there.
3. The prompt is typed with `herdr agent prompt`, starting with
   `[telegram message_id=... ]`; tg-mcp tells agents to answer such prompts with `send`.
   Several messages for one topic go as one prompt.
4. The router acks: delivered gets 👀 (plus "⏰ Разбудил сессию" after a wake). If the
   session waits for a decision, or the input box holds text you are typing, it retries
   later and says so once. If no pane fits, the message goes back to tg-mcp's queue with a
   note, and the agent gets it when it connects.

Sessions started with development channels ask for a confirmation on start; the router
answers that one dialog (only that one). The folder trust question ("Yes, I trust this
folder") is left to you: the router says so in the topic and delivers once you have
answered. Claude can ask it for a folder that inherited trust from a parent before, once
it has written an explicit `hasTrustDialogAccepted: false` for it into `~/.claude.json`.

## Configuration

`config.json` in `herdr plugin config-dir herdr-wake`, every key optional:

| Key | Default | Meaning |
| --- | --- | --- |
| `reaper.enabled` | `false` | put idle sessions to sleep |
| `reaper.idleMinutes` | `60` | how long a session must sit idle |
| `reaper.exclude` | `[]` | session names, workspace labels or titles never to put to sleep; exact (any case) or `"/regex/"` |
| `reaper.maxPerRound` | `3` | sessions put to sleep per minute at most |
| `listSleepingDays` | `7` | `ListAgents` lists sessions asleep for less than this (at most 15) and only counts the rest; a session sleeps until its pane is closed, so the full list keeps growing. All of them stay wakeable by name |
| `wakeCommand` | `claude --resume {session}` | command typed into the pane to resume a session |
| `wakeTimeoutSec` | `120` | how long to wait for a resumed session |
| `url`, `authorization` | from `~/.claude.json` | tg-mcp base url (without `/mcp`) and the `Authorization` header value |
| `server` | `telegram` | MCP server in `~/.claude.json` to take them from |
| `pollTimeoutSec` | `25` | long poll length |
| `port` | `12421` | local API; also keeps the router single-instance |
| `workspace` | `tg-router` | workspace the router pane lives in |

## Operating it

- herdr actions for the focused pane: `herdr-wake.sleep`, `herdr-wake.wake` (bind them to
  keys with `[[keys.command]]`, `type = "plugin_action"`).
- Local API on `127.0.0.1:12421`: `GET /status`, `GET /sleeping`, `GET /awake` (running
  sessions: status, since when, minutes until sleep or why they stay up),
  `POST /wake {"target": ...}`, `POST /sleep {"target": ...}`; a target is a session name,
  a pane id or a session id.
- Log: `router.log` in the plugin state directory (`%LOCALAPPDATA%\herdr\plugins\herdr-wake`
  on Windows), next to `sessions.json`.
- Route a message by hand, without the server:
  `node src/router.mjs --deliver "topic:Billing" "text"`.
- Tests: `npm test` (Node 20+).
