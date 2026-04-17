import { Hono } from 'hono'
import type { MessageStore } from '../domain/signals/message-store.js'

export function createMessageRoutes(store: MessageStore) {
  return new Hono()
    .get('/', (c) => {
      const channelId = c.req.query('channelId') || undefined
      const limit = Number(c.req.query('limit') ?? 200)
      return c.json(store.query(channelId, limit))
    })
    .get('/channels', (c) => {
      return c.json(store.distinctChannels())
    })
}
