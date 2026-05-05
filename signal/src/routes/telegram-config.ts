import { Hono } from 'hono'
import {
  loadTelegramConfig,
  saveTelegramConfig,
  telegramConfigUpdateSchema,
  toPublic,
  type TelegramConfig,
} from '../core/telegram-config.js'
import { TelegramClient } from '../connectors/telegram/client.js'
import { logger } from '../core/logger.js'

/**
 * Telegram approval-channel configuration HTTP API.
 *
 *   GET  /api/config/telegram        — public-safe view (no plaintext token)
 *   PUT  /api/config/telegram        — partial update; missing botToken
 *                                       keeps the old one
 *   POST /api/config/telegram/test   — getMe + sendMessage to verify the
 *                                       token + chatId reach the configured
 *                                       chat. Caller may pass a candidate
 *                                       config to test before saving.
 *
 * Like the LLM config, the pipeline reads Telegram settings once at boot.
 * After a PUT the dashboard shows a "restart required" banner.
 */

export function createTelegramConfigRoutes() {
  return new Hono()
    .get('/', async (c) => {
      const cfg = await loadTelegramConfig()
      return c.json(toPublic(cfg))
    })
    .put('/', async (c) => {
      const body = (await c.req.json()) as Record<string, unknown>
      const parsed = telegramConfigUpdateSchema.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: parsed.error.flatten() }, 400)
      }

      const existing = await loadTelegramConfig()
      const merged: TelegramConfig = {
        ...existing,
        ...parsed.data,
        botToken:
          parsed.data.botToken && parsed.data.botToken.length > 0
            ? parsed.data.botToken
            : existing.botToken,
      }
      await saveTelegramConfig(merged)
      logger.info(
        {
          enabled: merged.enabled,
          chatId: merged.chatId,
          approvalTimeoutSeconds: merged.approvalTimeoutSeconds,
          botTokenChanged:
            (parsed.data.botToken?.length ?? 0) > 0 &&
            parsed.data.botToken !== existing.botToken,
        },
        'Telegram config updated — restart required for pipeline to pick up changes',
      )
      return c.json(toPublic(merged))
    })
    .post('/test', async (c) => {
      // Same pattern as LLM /test: optional override lets the caller try
      // a new token / chatId before clicking Save.
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
      const candidate = telegramConfigUpdateSchema.safeParse(body)
      if (!candidate.success) {
        return c.json({ ok: false, error: candidate.error.flatten() }, 400)
      }

      const stored = await loadTelegramConfig()
      const cfg: TelegramConfig = {
        ...stored,
        ...candidate.data,
        botToken:
          candidate.data.botToken && candidate.data.botToken.length > 0
            ? candidate.data.botToken
            : stored.botToken,
      }

      if (!cfg.botToken) {
        return c.json({ ok: false, error: 'bot token is empty' }, 200)
      }
      if (!cfg.chatId) {
        return c.json({ ok: false, error: 'chat ID is empty' }, 200)
      }

      try {
        const client = new TelegramClient({ botToken: cfg.botToken })
        const me = await client.getMe()
        const startedAt = Date.now()
        await client.sendMessage({
          chatId: cfg.chatId,
          text: `🤖 *连通测试成功* — Bot \`${me.username ?? me.first_name}\` 已成功推送到 chat \`${cfg.chatId}\``,
        })
        return c.json({
          ok: true,
          botUsername: me.username ?? me.first_name,
          chatId: cfg.chatId,
          latencyMs: Date.now() - startedAt,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn({ err, message }, 'Telegram config test call failed')
        return c.json({ ok: false, error: message }, 200)
      }
    })
}
