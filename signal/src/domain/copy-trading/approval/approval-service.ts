/**
 * Single source of truth for `Operation.status` transitions.
 *
 * Both the dashboard's PUT /api/operations/:id/status route AND the
 * Telegram callback handler funnel through `transition()` so the
 * concurrency guarantees, validation rules, and event-emission policy
 * stay identical. Adding another front-end (CLI, Slack, …) is a matter
 * of calling this service.
 *
 * Concurrency model: the function re-reads the current operation right
 * before deciding, then appends a `status-change` line. Two simultaneous
 * "approve" calls from different surfaces will both find status=pending,
 * both append "approved" lines — but the fold logic in OperationStore
 * keeps "latest wins", so the operation lands at `approved` either way.
 * The second caller still gets a `success` outcome rather than a 409,
 * which is the desired UX (don't punish the operator for double-tapping).
 *
 * What we DO NOT guard against here:
 *   - status === 'approved' getting flipped to 'rejected' AFTER the
 *     broker fired the order. That's a Phase 5 problem; once a broker
 *     order is in flight, status moves to 'executed'/'failed' from the
 *     engine, not from a human.
 */

import type { EventLog } from '../../../core/event-log.js'
import { logger } from '../../../core/logger.js'
import type { Operation } from '../../../../../shared/types.js'
import type { IOperationStore } from '../operation-store.js'

/** Surfaces that can produce a transition. Mirrors the store's `by` field. */
export type Actor = 'dashboard' | 'telegram' | 'engine' | 'broker'

/** Statuses callers from a human surface (dashboard/telegram) may set. */
export type ManualTransition = 'approved' | 'rejected'

/** Statuses the engine / broker side may set after a manual approve. */
export type SystemTransition = 'executed' | 'failed'

export type TransitionTarget = ManualTransition | SystemTransition

/**
 * Per-source allowed transitions. Two layers of authorisation:
 *   1. Where can the actor START from? (current status)
 *   2. Where can the actor END at? (new status)
 *
 * Dashboard and telegram can only push pending → approved | rejected.
 * The engine / broker can push approved → executed | failed and is
 * also the source of the very first append (pending), but that path
 * goes through OperationStore.append, not this service.
 */
const RULES: Record<Actor, Partial<Record<Operation['status'], TransitionTarget[]>>> = {
  dashboard: { pending: ['approved', 'rejected'] },
  telegram: { pending: ['approved', 'rejected'] },
  engine: { approved: ['executed', 'failed'], pending: ['rejected'] /* timeout */ },
  broker: { approved: ['executed', 'failed'] },
}

export type TransitionResult =
  | { ok: true; operation: Operation; previousStatus: Operation['status'] }
  | { ok: false; code: 'not-found' }
  | { ok: false; code: 'invalid-transition'; currentStatus: Operation['status'] }

export interface TransitionInput {
  operationId: string
  newStatus: TransitionTarget
  by: Actor
  /** Optional human reason (typical for rejects + timeouts). */
  reason?: string
  /** ISO 8601. Injected for testability; defaults to `new Date().toISOString()`. */
  at?: string
}

export class ApprovalService {
  constructor(
    private readonly store: IOperationStore,
    private readonly events: EventLog,
  ) {}

  async transition(input: TransitionInput): Promise<TransitionResult> {
    const { operationId, newStatus, by, reason } = input
    const at = input.at ?? new Date().toISOString()

    // Read current view.
    const all = await this.store.readAllOperations()
    const current = all.find((op) => op.id === operationId)
    if (!current) return { ok: false, code: 'not-found' }

    const allowedFromHere = RULES[by][current.status] ?? []
    if (!allowedFromHere.includes(newStatus)) {
      return {
        ok: false,
        code: 'invalid-transition',
        currentStatus: current.status,
      }
    }

    await this.store.appendStatusChange({
      operationId,
      newStatus,
      at,
      by,
      ...(reason !== undefined && { reason }),
    })

    await this.events.append('operation.status-changed', {
      operationId,
      from: current.status,
      to: newStatus,
      by,
      at,
      reason,
    })

    logger.info(
      { operationId, from: current.status, to: newStatus, by, reason },
      'ApprovalService: status transitioned',
    )

    return {
      ok: true,
      operation: { ...current, status: newStatus },
      previousStatus: current.status,
    }
  }
}
