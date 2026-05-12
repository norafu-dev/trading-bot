import { Hono } from 'hono'
import type { EventLog } from '../core/event-log.js'
import type { ApprovalService } from '../domain/copy-trading/approval/approval-service.js'
import type { IOperationStore } from '../domain/copy-trading/operation-store.js'
import type { ResubmitService } from '../domain/copy-trading/resubmit-service.js'
import type { Operation } from '../../../shared/types.js'

/**
 * Read + write surface over the copy-trading engine's `Operation` log.
 *
 *   GET  /api/operations?limit=200&kolId=...&status=...
 *   PUT  /api/operations/:id/status   { status, reason? }
 *   POST /api/operations/:id/resubmit  → resubmit a timed-out op as a fresh pending one
 *   POST /api/operations/:id/resend-card → admin tool: re-emit operation.created
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
  resubmit: ResubmitService | null,
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
    .post('/:id/resubmit', async (c) => {
      // Re-runs a timed-out operation's signal through the engine, producing
      // a fresh pending op with a refreshed priceCheck. Useful when the
      // operator missed the 5-minute window on an otherwise still-actionable
      // signal (typically a limit waiting on a pullback). Guards re-fire,
      // so a truly stale signal is still rejected — this is not a guard
      // bypass.
      if (!resubmit) {
        return c.json(
          { error: 'resubmit unavailable — copy-trading engine not wired (no enabled account?)' },
          503,
        )
      }
      const id = c.req.param('id')
      const result = await resubmit.resubmit(id)
      if (!result.ok) {
        switch (result.code) {
          case 'op-not-found':
            return c.json({ error: 'operation not found' }, 404)
          case 'signal-not-found':
            return c.json(
              { error: `original signal ${result.signalId} not found in signals.jsonl` },
              404,
            )
          case 'kol-not-found':
            return c.json({ error: `KOL ${result.kolId} no longer registered` }, 404)
          case 'not-resubmittable':
            return c.json(
              {
                error: 'only approval-timeout or execution-failed ops can be resubmitted',
                currentStatus: result.currentStatus,
                lastDecisionBy: result.lastDecisionBy,
                lastDecisionReason: result.lastDecisionReason,
              },
              409,
            )
          case 'max-attempts-reached':
            return c.json(
              {
                error: `signal has already been submitted ${result.attemptCount} times (max reached)`,
                attemptCount: result.attemptCount,
              },
              409,
            )
        }
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
