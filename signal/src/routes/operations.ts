import { Hono } from 'hono'
import type { EventLog } from '../core/event-log.js'
import type { IOperationStore } from '../domain/copy-trading/operation-store.js'
import type { Operation } from '../../../shared/types.js'

/**
 * Read + write surface over the copy-trading engine's `Operation` log.
 *
 *   GET  /api/operations?limit=200&kolId=...&status=...
 *   PUT  /api/operations/:id/status   { status, reason? }
 *
 * GET returns newest-first with status-change events folded in. PUT lets
 * the dashboard's approve/reject buttons advance an operation through its
 * state machine — currently only `pending → approved | rejected` is
 * accepted; broker-side transitions (executed / failed) come from the
 * engine, not from the dashboard.
 */

type DashboardTransition = 'approved' | 'rejected'

const ALLOWED_TRANSITIONS: Record<Operation['status'], DashboardTransition[]> = {
  pending: ['approved', 'rejected'],
  approved: [],
  rejected: [],
  executed: [],
  failed: [],
}

export function createOperationsRoutes(
  store: IOperationStore,
  events: EventLog,
) {
  return new Hono()
    .get('/', async (c) => {
      const limit = Math.min(Number(c.req.query('limit') ?? 200), 1000)
      const kolId = c.req.query('kolId') ?? undefined
      const status = c.req.query('status') ?? undefined

      const all = await store.readAllOperations()
      // Newest-first for the dashboard timeline.
      all.reverse()

      const filtered: Operation[] = []
      for (const op of all) {
        if (kolId && op.kolId !== kolId) continue
        if (status && op.status !== status) continue
        filtered.push(op)
        if (filtered.length >= limit) break
      }

      return c.json({
        operations: filtered,
        total: all.length,
        limit,
      })
    })
    .put('/:id/status', async (c) => {
      const id = c.req.param('id')
      let body: { status?: unknown; reason?: unknown }
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'invalid JSON body' }, 400)
      }

      if (body.status !== 'approved' && body.status !== 'rejected') {
        return c.json(
          { error: "status must be 'approved' or 'rejected'" },
          400,
        )
      }
      const newStatus: DashboardTransition = body.status
      const reason = typeof body.reason === 'string' ? body.reason : undefined

      // Find the current operation. readAllOperations folds prior changes,
      // so what we see here IS the current view.
      const all = await store.readAllOperations()
      const current = all.find((op) => op.id === id)
      if (!current) return c.json({ error: 'operation not found' }, 404)

      const allowed = ALLOWED_TRANSITIONS[current.status]
      if (!allowed.includes(newStatus)) {
        return c.json(
          {
            error: `cannot transition from ${current.status} to ${newStatus}`,
            currentStatus: current.status,
          },
          409,
        )
      }

      const at = new Date().toISOString()
      await store.appendStatusChange({
        operationId: id,
        newStatus,
        at,
        by: 'dashboard',
        ...(reason !== undefined && { reason }),
      })

      await events.append('operation.status-changed', {
        operationId: id,
        from: current.status,
        to: newStatus,
        by: 'dashboard',
        at,
        reason,
      })

      const updated: Operation = { ...current, status: newStatus }
      return c.json({ operation: updated })
    })
}
