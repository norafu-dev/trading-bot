import { Hono } from 'hono'
import { logger } from '../core/logger.js'
import type { MessageStore } from '../domain/signals/message-store.js'
import type { SignalPipeline } from '../pipeline.js'

/**
 * Dev-tool endpoints for replaying messages through the live pipeline.
 *
 *   POST /api/pipeline/inject   — replay one or more messages by snowflake
 *   POST /api/pipeline/flush    — force-close all open aggregator windows
 *
 * The inject route is intended for development and prompt-iteration. It
 * runs each message through the SAME handler the Discord listener uses
 * (`pipeline.handleDiscordMessage`), so behaviour matches production.
 *
 * After the messages are ingested, the route always force-flushes the
 * aggregator so the operator sees a result immediately rather than waiting
 * out the 30s idleTimeoutMs. This deliberately bypasses the natural
 * windowing — fine for one-off replay, would be wrong on the hot path.
 */

interface InjectBody {
  messageIds?: string[]
  /** Convenience for replaying a single message. */
  messageId?: string
}

export function createPipelineRoutes(
  pipeline: SignalPipeline,
  messageStore: MessageStore,
) {
  return new Hono()
    .post('/inject', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as InjectBody
      const ids = body.messageIds ?? (body.messageId ? [body.messageId] : [])
      if (ids.length === 0) {
        return c.json({ error: 'Missing messageId or messageIds' }, 400)
      }

      const found: string[] = []
      const missing: string[] = []
      for (const id of ids) {
        const msg = messageStore.findById(id)
        if (!msg) {
          missing.push(id)
          continue
        }
        found.push(id)
        await pipeline.handleDiscordMessage(msg)
      }

      // Force-close all open aggregator windows so the caller doesn't have
      // to wait the idle timeout to see signals/events show up.
      await pipeline.flush()

      logger.info(
        { injected: found.length, missing: missing.length },
        'Pipeline: inject + flush completed',
      )

      return c.json({
        ok: true,
        injected: found,
        missing,
        message:
          found.length > 0
            ? `Injected ${found.length} message(s); aggregator flushed. Check /signals and /events for results.`
            : 'No messages found in MessageStore — they may have aged out of the in-memory tail.',
      })
    })
    .post('/flush', async (c) => {
      await pipeline.flush()
      return c.json({ ok: true })
    })
}
