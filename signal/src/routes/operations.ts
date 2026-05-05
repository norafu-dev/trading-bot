import { Hono } from 'hono'
import type { EventLog } from '../core/event-log.js'
import type { ApprovalService } from '../domain/copy-trading/approval/approval-service.js'
import type { IOperationStore } from '../domain/copy-trading/operation-store.js'
import type { Operation } from '../../../shared/types.js'

/**
 * Read + write surface over the copy-trading engine's `Operation` log.
 *
 *   GET  /api/operations?limit=200&kolId=...&status=...
 *   PUT  /api/operations/:id/status   { status, reason? }
 *
 * GET returns newest-first with status-change events folded in. PUT
 * delegates to ApprovalService.transition so the dashboard, the Telegram
 * bot, and any future surfaces share the same validation + persistence
 * + event-emission logic.
 */

export function createOperationsRoutes(
  store: IOperationStore,
  approvals: ApprovalService,
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
      const reason = typeof body.reason === 'string' ? body.reason : undefined

      const result = await approvals.transition({
        operationId: id,
        newStatus: body.status,
        by: 'dashboard',
        ...(reason !== undefined && { reason }),
      })

      if (!result.ok) {
        if (result.code === 'not-found') {
          return c.json({ error: 'operation not found' }, 404)
        }
        return c.json(
          {
            error: `cannot transition from ${result.currentStatus} to ${body.status}`,
            currentStatus: result.currentStatus,
          },
          409,
        )
      }
      return c.json({ operation: result.operation })
    })
    .post('/:id/resend-card', async (c) => {
      // Admin / recovery tool. Re-emits `operation.created` for an existing
      // pending op so the Telegram notifier resends the approval card —
      // useful if the bot was offline when the operation was first created,
      // or for smoke-testing the notifier without going through the full
      // signal → sizer pipeline. Only applies to pending ops; emitting for
      // an already-decided op would just generate a no-op event.
      const id = c.req.param('id')
      const all = await store.readAllOperations()
      const op = all.find((o) => o.id === id)
      if (!op) return c.json({ error: 'operation not found' }, 404)
      if (op.status !== 'pending') {
        return c.json(
          { error: `op is ${op.status}, not pending — nothing to resend` },
          409,
        )
      }
      await events.append('operation.created', {
        operationId: op.id,
        signalId: op.signalId,
        kolId: op.kolId,
        accountId: op.accountId,
        status: op.status,
        symbol: op.spec.action === 'placeOrder' ? op.spec.symbol : '(other)',
      })
      return c.json({ ok: true })
    })
}
