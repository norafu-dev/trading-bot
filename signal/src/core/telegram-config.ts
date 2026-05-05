/**
 * Telegram approval channel configuration.
 *
 * Storage split:
 *   - `data/config/telegram.json`     — non-secret: chatId, enabled,
 *                                       approvalTimeoutSeconds. Editable
 *                                       from the dashboard /settings page.
 *   - `data/config/secrets.json`      — botToken, under `telegram.botToken`.
 *
 * Both files live under `data/`, which is .gitignored. Splitting them
 * matches the convention established by accounts / llm config (DEC-secrets):
 * the visible file can be moved between machines or pasted into a chat
 * for debugging without leaking the bot token.
 *
 * Read at boot only — there's no hot-reload because the long-poll loop
 * caches the bot token. Restart the signal process after rotating the
 * token; chatId / timeout changes also take effect on restart.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { PATHS } from './paths.js'
import { readSecrets, writeSecrets } from './secrets-store.js'

// ── Schema (full, with secret) ──────────────────────────────────────────────

export const telegramConfigSchema = z.object({
  /** Master switch. When false, no notifier / listener / timeouts run. */
  enabled: z.boolean().default(false),
  /**
   * Group / supergroup / private chat ID. Negative for groups (e.g.
   * `-5136040062`), positive for private chats. The chat must already
   * have the bot added.
   */
  chatId: z.number().int().default(0),
  /**
   * Pending approvals auto-reject after this many seconds. 5 minutes is
   * the CLAUDE.md default. Set to 0 to disable timeout (useful only for
   * tests / dev).
   */
  approvalTimeoutSeconds: z.number().int().min(0).default(300),
  /**
   * Bot token from BotFather. Stored in `secrets.json`, but folded in
   * here at load time so the rest of the codebase only ever sees one
   * unified config object.
   */
  botToken: z.string().default(''),
})

export type TelegramConfig = z.infer<typeof telegramConfigSchema>

/** Update body — every field optional so the dashboard can rotate one at a time. */
export const telegramConfigUpdateSchema = telegramConfigSchema.partial()
export type TelegramConfigUpdate = z.infer<typeof telegramConfigUpdateSchema>

// ── Public-safe view (no plaintext botToken) ────────────────────────────────

export interface PublicTelegramConfig {
  enabled: boolean
  chatId: number
  approvalTimeoutSeconds: number
  botTokenConfigured: boolean
  botTokenLast4: string
}

export function toPublic(cfg: TelegramConfig): PublicTelegramConfig {
  const last4 = cfg.botToken.length >= 4 ? cfg.botToken.slice(-4) : ''
  return {
    enabled: cfg.enabled,
    chatId: cfg.chatId,
    approvalTimeoutSeconds: cfg.approvalTimeoutSeconds,
    botTokenConfigured: cfg.botToken.length > 0,
    botTokenLast4: last4,
  }
}

// ── File location ───────────────────────────────────────────────────────────

const TELEGRAM_CONFIG_FILE = join(PATHS.configDir, 'telegram.json')

// ── Read / write ────────────────────────────────────────────────────────────

/**
 * Load the merged config. Returns defaults (with empty token + chatId 0)
 * if neither the file nor the secret exists — caller is expected to
 * check `enabled && botToken && chatId` before initializing the
 * connector.
 */
export async function loadTelegramConfig(): Promise<TelegramConfig> {
  // 1. Read non-secret file
  let baseConfig: TelegramConfig | null = null
  try {
    const raw = await readFile(TELEGRAM_CONFIG_FILE, 'utf-8')
    const parsed = telegramConfigSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      throw new Error(
        `Telegram config at ${TELEGRAM_CONFIG_FILE} is malformed: ${parsed.error.message}`,
      )
    }
    baseConfig = parsed.data
  } catch (err) {
    if (!isENOENT(err)) throw err
  }

  // 2. Merge secret
  const secrets = await readSecrets()
  const secretToken = secrets.telegram?.botToken ?? ''

  if (baseConfig) {
    return {
      ...baseConfig,
      botToken: secretToken || baseConfig.botToken,
    }
  }

  // 3. No file — env-var fallback
  return telegramConfigSchema.parse({
    botToken: secretToken || process.env['TELEGRAM_BOT_TOKEN'] || '',
    ...(process.env['TELEGRAM_CHAT_ID'] && {
      chatId: Number(process.env['TELEGRAM_CHAT_ID']),
    }),
  })
}

/**
 * Persist config, splitting the secret out:
 *   - botToken   → secrets.json
 *   - rest       → telegram.json (botToken always emptied on disk)
 */
export async function saveTelegramConfig(cfg: TelegramConfig): Promise<void> {
  await mkdir(dirname(TELEGRAM_CONFIG_FILE), { recursive: true })

  const existingSecrets = await readSecrets()
  const updatedSecrets = {
    ...existingSecrets,
    telegram: { botToken: cfg.botToken },
  }
  await writeSecrets(updatedSecrets)

  const publicConfig: TelegramConfig = { ...cfg, botToken: '' }
  await writeFile(
    TELEGRAM_CONFIG_FILE,
    JSON.stringify(publicConfig, null, 2) + '\n',
    'utf-8',
  )
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
