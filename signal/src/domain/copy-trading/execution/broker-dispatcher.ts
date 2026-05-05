/**
 * Subscribes to ApprovalService outputs and turns approved Operations
 * into broker orders.
 *
 * Flow:
 *   approval.transition('approved')                       (telegram tap / dashboard PUT)
 *     → events.append('operation.status-changed', to:'approved')
 *     → BrokerDispatcher.handleStatusChanged
 *     → OrderExecutor.execute(op)        (dry-run or live)
 *     → on success: ApprovalService.transition('executed', by='broker', reason=mainOrderId)
 *                   events.append('trade.executed', {orderIds, refPrice, amount, ...})
 *     → on failure: ApprovalService.transition('failed', by='broker', reason=err.message)
 *                   events.append('trade.failed', {category, message})
 *
 * Concurrency: each operation is processed by exactly one event delivery.
 * If two `approved` events fire for the same op (theoretically possible
 * if dashboard + telegram race past ApprovalService's idempotency), the
 * second `approved → executed` transition will be rejected as
 * invalid-transition (executed is not allowed from already-executed) —
 * the executor will not double-place an order.
 *
 * No retry policy yet. A network failure on the main order surfaces as
 * a `failed` op; the operator can manually re-approve via dashboard
 * resend-card if the position state on the exchange is known. Phase 7
 * will add classified retry (network / rate-limit only).
 */

import type { EventLog, EventLogEntry } from '../../../core/event-log.js'
import { logger } from '../../../core/logger.js'
import type { Operation } from '../../../../../shared/types.js'
import type { ApprovalService } from '../approval/approval-service.js'
import type { IOperationStore } from '../operation-store.js'
import type { OrderExecutor } from './order-executor.js'
import { ExecutionError } from './order-executor.js'

interface StatusChangedPayload {
  operationId: string
  from: string
  to: string
  by: 'dashboard' | 'telegram' | 'engine' | 'broker'
}

export interface BrokerDispatcherDeps {
  store: IOperationStore
  events: EventLog
  approvals: ApprovalService
  executor: OrderExecutor
}

export class BrokerDispatcher {
  private unsubscribe: (() => void) | null = null

  constructor(private readonly deps: BrokerDispatcherDeps) {}

  start(): void {
    this.unsubscribe = this.deps.events.subscribeType(
      'operation.status-changed',
      (e) => {
        void this.handleStatusChanged(e as EventLogEntry<StatusChangedPayload>)
      },
    )
    logger.info('BrokerDispatcher: subscribed to operation.status-changed')
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
  }

  private async handleStatusChanged(
    entry: EventLogEntry<StatusChangedPayload>,
  ): Promise<void> {
    const { operationId, to, by } = entry.payload
    if (to !== 'approved') return
    // `by` matters for diagnostics only — broker side reacts the same
    // regardless of whether telegram or dashboard approved.
    void by

    // Re-load the operation. `readAllOperations` folds prior status changes;
    // the current status MUST be 'approved' here (we're handling that very
    // transition), but defend against races.
    const all = await this.deps.store.readAllOperations()
    const op = all.find((o) => o.id === operationId)
    if (!op) {
      logger.warn(
        { operationId },
        'BrokerDispatcher: status-changed for unknown op',
      )
      return
    }
    if (op.status !== 'approved') {
      // Another transition ran between subscribeType firing and our
      // re-read — e.g. timeout fired the same tick. Skip; whatever
      // wrote the newer status owns it.
      return
    }

    try {
      const attachment = await this.deps.executor.execute(op)
      logger.info(
        {
          opId: op.id,
          mainOrderId: attachment.mainOrderId,
          extraTps: attachment.extraTpOrderIds.length,
          refPrice: attachment.refPrice,
          amount: attachment.amount,
        },
        'BrokerDispatcher: order placed',
      )

      await this.deps.events.append('trade.executed', {
        operationId: op.id,
        signalId: op.signalId,
        kolId: op.kolId,
        accountId: op.accountId,
        symbol: op.spec.action === 'placeOrder' ? op.spec.symbol : '(other)',
        ...attachment,
      })

      const result = await this.deps.approvals.transition({
        operationId: op.id,
        newStatus: 'executed',
        by: 'broker',
        reason: attachment.mainOrderId,
      })
      if (!result.ok) {
        logger.warn(
          { opId: op.id, code: result.code },
          'BrokerDispatcher: transition to executed rejected',
        )
      }
    } catch (err) {
      const isExecErr = err instanceof ExecutionError
      const category = isExecErr ? err.category : 'unknown'
      const message = err instanceof Error ? err.message : String(err)
      logger.error(
        { err, opId: op.id, category },
        'BrokerDispatcher: order placement failed',
      )

      await this.deps.events.append('trade.failed', {
        operationId: op.id,
        signalId: op.signalId,
        kolId: op.kolId,
        accountId: op.accountId,
        category,
        message,
      })

      const result = await this.deps.approvals.transition({
        operationId: op.id,
        newStatus: 'failed',
        by: 'broker',
        reason: `[${category}] ${message}`,
      })
      if (!result.ok) {
        logger.warn(
          { opId: op.id, code: result.code },
          'BrokerDispatcher: transition to failed rejected',
        )
      }
    }
  }
}
