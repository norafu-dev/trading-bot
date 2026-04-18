import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { DiscordListener } from '../connectors/discord/listener.js'
import type { MessageStore } from '../domain/signals/message-store.js'
import { buildParserInput } from '../domain/signals/message-cleaner.js'

const exportSchema = z.object({
  channelId: z.string().min(1),
  /** Discord user IDs of KOLs to filter. Empty array = all authors. */
  authorIds: z.array(z.string()).default([]),
  /** ISO date string, start of range (inclusive) */
  dateFrom: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  /** ISO date string, end of range (inclusive) */
  dateTo: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  /** Max messages to fetch (default 500) */
  limit: z.number().int().min(1).max(500).default(200),
})

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
    .post('/export', zValidator('json', exportSchema), async (c) => {
      if (!listener) return c.json({ ok: false, message: 'Discord listener not running' }, 400)

      const body = c.req.valid('json')

      // Parse dates (accept both YYYY-MM-DD and ISO strings)
      const dateFrom = new Date(body.dateFrom.includes('T') ? body.dateFrom : body.dateFrom + 'T00:00:00Z')
      const dateTo   = new Date(body.dateTo.includes('T')   ? body.dateTo   : body.dateTo   + 'T23:59:59Z')

      if (isNaN(dateFrom.getTime()) || isNaN(dateTo.getTime())) {
        return c.json({ ok: false, message: 'Invalid date format' }, 400)
      }
      if (dateFrom > dateTo) {
        return c.json({ ok: false, message: 'dateFrom must be before dateTo' }, 400)
      }

      const messages = await listener.fetchHistory({
        channelId: body.channelId,
        authorIds: body.authorIds,
        dateFrom,
        dateTo,
        limit: body.limit,
      })

      // Build AI-ready export records
      const records = messages.map((m) => {
        // Collect all image URLs: embed image/thumbnail + file attachments
        const images: string[] = []
        for (const e of m.embeds) {
          if (e.image) images.push(e.image)
          if (e.thumbnail) images.push(e.thumbnail)
        }
        for (const a of m.attachments) {
          const isImage = a.contentType?.startsWith('image/') ||
            /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(a.name)
          if (isImage) images.push(a.url)
        }

        return {
          messageId:      m.messageId,
          authorId:       m.authorId,
          authorUsername: m.authorUsername,
          timestamp:      m.receivedAt,
          /** cleaned text ready for AI analysis */
          text:           buildParserInput(m),
          /** image URLs from embeds and file attachments */
          images,
          /** original raw content preserved for reference */
          rawContent:     m.content,
          hasEmbeds:      m.embeds.length > 0,
        }
      }).filter((r) => r.text.length > 0 || r.images.length > 0)

      return c.json({
        ok: true,
        channelId:  body.channelId,
        dateFrom:   dateFrom.toISOString(),
        dateTo:     dateTo.toISOString(),
        total:      records.length,
        messages:   records,
      })
    })
}
