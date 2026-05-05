import { Hono } from 'hono'
import {
  executionConfigUpdateSchema,
  loadExecutionConfig,
  saveExecutionConfig,
  type ExecutionConfig,
} from '../core/execution-config.js'
import { logger } from '../core/logger.js'

/**
 * Execution mode + safety knobs.
 *
 *   GET /api/config/execution     — full config (no secrets in this domain)
 *   PUT /api/config/execution     — partial update; takes effect IMMEDIATELY
 *                                   (broker dispatcher reads per operation)
 *
 * Switching dry-run ↔ live is a deliberate dashboard action — there is
 * no kill-switch beyond changing this field. The broker dispatcher
 * reads the latest config on every approval, so flipping this is the
 * fastest stop-trading lever an operator has short of killing the
 * process.
 */

export function createExecutionConfigRoutes() {
  return new Hono()
    .get('/', async (c) => {
      return c.json(await loadExecutionConfig())
    })
    .put('/', async (c) => {
      const body = (await c.req.json()) as Record<string, unknown>
      const parsed = executionConfigUpdateSchema.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: parsed.error.flatten() }, 400)
      }

      const existing = await loadExecutionConfig()
      const merged: ExecutionConfig = { ...existing, ...parsed.data }
      await saveExecutionConfig(merged)
      logger.warn(
        {
          before: existing,
          after: merged,
          changedToLive: existing.mode === 'dry-run' && merged.mode === 'live',
          changedToDryRun: existing.mode === 'live' && merged.mode === 'dry-run',
        },
        'Execution config updated',
      )
      return c.json(merged)
    })
}
