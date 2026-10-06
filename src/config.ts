// Bun loads .env automatically; this module only validates and types it.

function required(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) {
    console.error(`missing required env var ${name} (see .env.example)`)
    process.exit(1)
  }
  return v
}

const mcpToken = required('MCP_TOKEN')
if (mcpToken.length < 32) {
  console.error('MCP_TOKEN must be at least 32 characters (try: openssl rand -hex 32)')
  process.exit(1)
}

const ownerRaw = process.env.OWNER_ID?.trim()

export const config = {
  botToken: required('TELEGRAM_BOT_TOKEN'),
  // When unset the bot runs in pairing mode: it only tells people their id.
  ownerId: ownerRaw ? Number(ownerRaw) : undefined,
  mcpToken,
  host: process.env.HOST?.trim() || '127.0.0.1',
  port: Number(process.env.PORT || 8790),
  dataDir: process.env.DATA_DIR?.trim() || './data',
  askTimeoutSec: Number(process.env.ASK_TIMEOUT_SEC || 600),
  relayPermissions: (process.env.RELAY_PERMISSIONS ?? '1') !== '0',
}

if (config.ownerId !== undefined && !Number.isSafeInteger(config.ownerId)) {
  console.error('OWNER_ID must be a numeric Telegram user id')
  process.exit(1)
}
