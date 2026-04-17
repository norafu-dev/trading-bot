import { Hono } from 'hono'
import type { DiscordListener } from '../connectors/discord/listener.js'
import type { MessageStore } from '../domain/signals/message-store.js'

export function createDiscordRoutes(listener: DiscordListener | null, store: MessageStore) {
  return new Hono()
    .get('/status', (c) => {
      if (!listener) {
        return c.json({ status: 'disabled', message: 'DISCORD_TOKEN not set' })
      }
      return c.json({
        status: listener.status,
        username: listener.username,
        monitoredChannels: 0,
        enabledKols: 0,
        messageCount: store.count,
        lastError: listener.lastError,
      })
    })
    .post('/reload', async (c) => {
      if (!listener) return c.json({ ok: false, message: 'Discord listener not running' }, 400)
      await listener.reloadConfig()
      return c.json({ ok: true })
    })
}
