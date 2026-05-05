/**
 * Auto-reject pending operations that have been awaiting approval for
 * longer than `approvalTimeoutSeconds`. Belongs in the copy-trading
 * domain (not the telegram connector) because the timeout policy is
 * a business rule — it applies regardless of which approval surface
 * eventually fires.
 *
 * Lifecycle:
 *   - On `start()`: scan the operation log for pending records, schedule
 *     a timer for each. If a record is already past its deadline we
 *     time it out immediately rather than waiting another full window.
 *   - On `operation.created` (status='pending'): schedule a fresh timer.
 *   - On `operation.status-changed`: cancel the timer for that op
 *     (any decision wins — manual approve/reject pre-empts timeout).
 *   - On `stop()`: cancel every pending timer and return.
 *
 * Why we don't persist timers across restarts: timers are recoverable
 * by re-scanning the store at boot. A restart always rebuilds the full
 * timer set from scratch, so there's nothing extra to persist beyond
 * what's already in `operations.jsonl`.
 */

import type { EventLog, EventLogEntry } from '../../../core/event-log.js'
import { logger } from '../../../core/logger.js'
import type { ApprovalService } from './approval-service.js'
import type { IOperationStore } from '../operation-store.js'

interface OperationCreatedPayload {
  operationId: string
  status: string
}

interface StatusChangedPayload {
  operationId: string
  to: string
}

export interface ApprovalTimeoutsDeps {
  store: IOperationStore
  events: EventLog
  approvals: ApprovalService
  /** 0 disables; otherwise reject pending ops after this many seconds. */
  timeoutSeconds: number
}

export class ApprovalTimeouts {
  private timers = new Map<string, NodeJS.Timeout>()
  private unsubscribers: Array<() => void> = []
  private running = false

  constructor(private readonly deps: ApprovalTimeoutsDeps) {}

  async start(): Promise<void> {
    if (this.deps.timeoutSeconds <= 0) {
      logger.info('ApprovalTimeouts: timeoutSeconds=0; auto-reject disabled')
      return
    }
    this.running = true

    // Scan existing pending ops and arm their timers.
    const all = await this.deps.store.readAllOperations()
    const nowMs = Date.now()
    for (const op of all) {
      if (op.status !== 'pending') continue
      this.armTimer(op.id, op.createdAt, nowMs)
    }

    // Subscribe for new ops + decisions.
    this.unsubscribers.push(
      this.deps.events.subscribeType('operation.created', (e) => {
        const p = (e as EventLogEntry<OperationCreatedPayload>).payload
        if (p.status !== 'pending') return
        this.armTimer(p.operationId, new Date().toISOString(), Date.now())
      }),
    )
    this.unsubscribers.push(
      this.deps.events.subscribeType('operation.status-changed', (e) => {
        const p = (e as EventLogEntry<StatusChangedPayload>).payload
        // Any leaving-pending event cancels.
        this.cancelTimer(p.operationId)
      }),
    )

    logger.info(
      { armed: this.timers.size, timeoutSeconds: this.deps.timeoutSeconds },
      'ApprovalTimeouts: started',
    )
  }

  async stop(): Promise<void> {
    this.running = false
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    for (const u of this.unsubscribers) u()
    this.unsubscribers = []
  }

  /** Scheduled timer count — exposed for diagnostics / tests. */
  size(): number {
    return this.timers.size
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private armTimer(operationId: string, createdAtIso: string, nowMs: number): void {
    if (!this.running) return
    if (this.timers.has(operationId)) return  // already armed (de-dupe)

    const createdAtMs = new Date(createdAtIso).getTime()
    if (Number.isNaN(createdAtMs)) {
      logger.warn({ operationId, createdAtIso }, 'ApprovalTimeouts: bad createdAt; skipping')
      return
    }

    const deadlineMs = createdAtMs + this.deps.timeoutSeconds * 1000
    const remainingMs = Math.max(0, deadlineMs - nowMs)
    const handle = setTimeout(() => {
      this.timers.delete(operationId)
      void this.fireTimeout(operationId)
    }, remainingMs)
    // Don't keep the event loop alive just for this timer.
    handle.unref?.()
    this.timers.set(operationId, handle)
  }

  private cancelTimer(operationId: string): void {
    const t = this.timers.get(operationId)
    if (t) {
      clearTimeout(t)
      this.timers.delete(operationId)
    }
  }

  private async fireTimeout(operationId: string): Promise<void> {
    const result = await this.deps.approvals.transition({
      operationId,
      newStatus: 'rejected',
      by: 'engine',
      reason: `approval timeout (${this.deps.timeoutSeconds}s)`,
    })
    if (!result.ok) {
      // Could be: race against a manual decision (invalid-transition), or
      // op was deleted (not-found, shouldn't happen). Either way, harmless.
      logger.info(
        { operationId, code: result.code },
        'ApprovalTimeouts: fire skipped — op already resolved',
      )
    } else {
      logger.info({ operationId }, 'ApprovalTimeouts: pending op auto-rejected (timeout)')
    }
  }
}
