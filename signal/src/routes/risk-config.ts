import { Hono } from 'hono'
import { loadRiskConfig, riskConfigUpdateSchema, saveRiskConfig } from '../core/risk-config.js'
import { logger } from '../core/logger.js'

/**
 * Risk-config CRUD for the dashboard.
 *
 *   GET  /api/config/risk    — load (returns defaults if no file yet)
 *   PUT  /api/config/risk    — partial update (any subset of fields)
 *
 * Changes take effect on the NEXT signal — the engine reads `loadRiskConfig`
 * on every operation creation, no in-memory cache to refresh.
 */
export function createRiskConfigRoutes() {
  return new Hono()
    .get('/', async (c) => {
      const cfg = await loadRiskConfig()
      return c.json(cfg)
    })
    .put('/', async (c) => {
      const body = (await c.req.json()) as Record<string, unknown>
      const parsed = riskConfigUpdateSchema.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: parsed.error.flatten() }, 400)
      }

      const existing = await loadRiskConfig()
      const merged = { ...existing, ...parsed.data }
      await saveRiskConfig(merged)
      logger.info(merged, 'Risk config updated')
      return c.json(merged)
    })
}
