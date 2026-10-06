# tg-mcp

A Telegram bridge for Claude Code agents: one small server process that all your agents
reach over HTTP. Agents can message you, ask you questions with tap-to-answer buttons,
and send files. You can write back, and your message is **pushed into the running
session** as a [Claude Code channel](https://code.claude.com/docs/en/channels-reference)
event, the same way the official local Telegram plugin does it, without a local
process per session.

```
laptop: claude ──HTTPS (MCP Streamable HTTP + Bearer)──► reverse proxy ──► tg-mcp (one Bun process)
                                                                              │ long polling
                                                                        Telegram Bot API ⇄ you
```

- **Nothing runs on the client.** Claude Code connects to a remote HTTP MCP server.
- **A topic per project.** The bot creates a forum topic in your private chat with it for
  each working directory (sent by the client in a header) and reuses it across sessions.
- **Two-way.** Messages in a topic go to the agent working in that project: pushed live
  when the session runs as a channel, otherwise queued until the agent calls `inbox`.
- **Permission relay.** Tool-approval prompts from channel sessions show up in Telegram
  with Allow / Deny buttons.
- **Owner-only.** The bot ignores everyone except `OWNER_ID`.

## Tools

| Tool | What it does |
| --- | --- |
| `send` | Send a Markdown message to the project's topic |
| `ask` | Ask a question (optionally with button options) and wait for the answer |
| `send_file` | Send a text or base64 file; images go as photos |
| `get_attachment` | Fetch a photo or file you sent (images come back as images) |
| `inbox` | Read queued messages (for sessions not running as a channel) |
| `set_topic` | Use a differently named topic for this session |

## Server setup

Requirements: [Bun](https://bun.sh) 1.3+, a bot from [@BotFather](https://t.me/BotFather)
with **Threaded Mode** enabled (so the bot can create topics in private chats), and a TLS
reverse proxy.

```bash
git clone https://github.com/Eithery-rc/tg-mcp && cd tg-mcp
bun install
cp .env.example .env && chmod 600 .env
# fill in TELEGRAM_BOT_TOKEN and MCP_TOKEN (openssl rand -hex 32)
bun src/main.ts
```

Send `/start` to your bot. While `OWNER_ID` is empty the bot runs in pairing mode and
replies with your numeric id; put it into `.env` and restart.

To run it permanently as a systemd user service (needs `loginctl enable-linger $USER`):

```bash
ln -s ~/tg-mcp/deploy/tg-mcp.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now tg-mcp
journalctl --user -u tg-mcp -f
```

Reverse proxy (nginx). SSE streams and `ask` calls stay open for a long time, so turn
off buffering and raise the read timeout:

```nginx
location /tg-mcp/ {
    proxy_pass http://127.0.0.1:8790/;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 3700s;
    client_max_body_size 64m;
}
```

## Client setup (Claude Code)

Add the server once, at user scope. `${PWD}` and `${TG_CHANNEL}` are expanded by Claude
Code at startup: the first tells the server which project the session belongs to, the
second whether the session listens as a channel.

```bash
claude mcp add --transport http -s user telegram https://example.com/tg-mcp/mcp \
  --header 'Authorization: Bearer <MCP_TOKEN>' \
  --header 'X-Cwd: ${PWD}' \
  --header 'X-Channel: ${TG_CHANNEL:-0}'
```

Every session can now use the tools. To have your Telegram messages pushed into a
session, start it as a channel. During the channels research preview custom channels need
the development flag (Claude Code shows a confirmation prompt on start):

```bash
alias claude-tg='TG_CHANNEL=1 claude --dangerously-load-development-channels server:telegram'
```

On Windows PowerShell `${PWD}` does not work, see the notes below.

### Client setup notes

- **The bearer is `MCP_TOKEN`, not the bot token.** A wrong token gets a bare
  `401 unauthorized`, the same answer as no header at all; `claude mcp list` shows
  "Server rejected the configured Authorization header (HTTP 401)".
- **Header variables are expanded once, when a session starts**, from the environment
  Claude Code was launched with. Changes apply to sessions started afterwards.
- **An unset variable without a default is sent literally.** `claude mcp list` warns
  `Missing environment variables: PWD`, and the server creates a topic named `${PWD}`.
  Give every header variable a default, e.g. `${TG_KEY:-}`. With an empty `X-Cwd` the
  server asks the client for its workspace root (MCP roots) instead.
- **PowerShell has no `PWD` environment variable.** `$PWD` exists only inside PowerShell,
  so `${PWD}` never expands for a Claude Code started from pwsh. Set your own variable in
  the script you launch Claude Code with.
- **`X-Cwd` does not have to be a path.** Its value is the routing key, and a key of the
  form `topic:<name>` (what `set_topic` uses) gives a topic with exactly that name. This
  lets you group sessions by something other than the folder, e.g. a terminal workspace.
- **Every session can be a channel.** Routing picks the most recently active channel
  session of a topic, and a reply to a bot message goes to the session that sent it, so
  launching all sessions with the channel flag works fine.
- **Remove the official local Telegram plugin if it used the same bot.** Telegram serves
  `getUpdates` to one consumer per token, and the plugin starts its own poller (a
  `bun server.ts` of about 250 MB) in every session where it is enabled. On Windows its
  stale-poller cleanup calls `ps`, which does not exist there, so the pollers pile up.
- **To see what the server received**, look for the `session #N up: <key> channel=<bool>`
  line it logs for every connection: `journalctl --user -u tg-mcp | grep ' up:'`.

Example: a PowerShell launcher that makes every session a channel and names topics after
the herdr workspace (falling back to the folder), with the server
added as `--header 'X-Cwd: ${TG_KEY:-}' --header 'X-Channel: ${TG_CHANNEL:-0}'`:

```powershell
$key = (Get-Location).Path
if ($env:HERDR_PANE_ID -and $env:HERDR_BIN_PATH) {
    try {
        $ws = (& $env:HERDR_BIN_PATH pane get $env:HERDR_PANE_ID | ConvertFrom-Json).result.pane.workspace_id
        $label = ((& $env:HERDR_BIN_PATH workspace list | ConvertFrom-Json).result.workspaces |
            Where-Object workspace_id -eq $ws).label
        if ($label) { $key = "topic:$label" }
    } catch {}
}
$env:TG_KEY = $key
$env:TG_CHANNEL = '1'
try {
    claude --dangerously-load-development-channels server:telegram @args
} finally {
    Remove-Item Env:TG_KEY, Env:TG_CHANNEL -ErrorAction SilentlyContinue
}
```

## Using it from scripts

`POST /notify` sends a plain message without MCP, for cron jobs, CI or Claude Code hooks:

```bash
curl -s https://example.com/tg-mcp/notify \
  -H "Authorization: Bearer $MCP_TOKEN" -H 'content-type: application/json' \
  -d '{"text": "backup finished", "topic": "server"}'
```

Pass `"cwd": "/path/to/project"` instead of `topic` to post into a project's topic.

## How routing works

- A message in a topic goes to the session that most recently did something in that
  project. Reply to a specific bot message to target the session that sent it.
- If no channel session is listening, the message is queued. Channel sessions receive the
  queue as soon as they connect; other sessions see a hint in their next tool result.
- An open `ask` in the topic takes your next message (or button tap) as its answer.
- `/status` in the bot lists connected sessions.
- If you delete a topic, the bot creates a new one the next time the agent writes.

## Security notes

- `.env` holds the bot token and the MCP bearer token; it is git-ignored. Keep it `chmod 600`.
- Anything you send to the bot is injected into an agent session that can run tools. The
  bot drops messages from anyone but `OWNER_ID`, and the HTTP endpoint requires the bearer token.
- Permission relay lets you approve tool calls from your phone. Set `RELAY_PERMISSIONS=0`
  to turn it off.

## Development

```bash
bun test          # formatter tests
bun run typecheck
bun run dev       # restart on change
```

## License

[MIT](LICENSE)
