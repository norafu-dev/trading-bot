/**
 * Resubmit a timed-out OR execution-failed operation as a fresh pending one.
 *
 * Two eligible cases:
 *
 * **A. Approval timeout** — operator stepped away, the 5-minute window
 * lapsed, engine auto-rejected with `lastDecision.by='engine'`,
 * `reason='approval timeout …'`. Limit-order setups often still
 * actionable hours later (waiting on a pullback / bounce).
 *
 * **B. Execution failure** — broker rejected the MAIN order, so the op
 * carries `status='failed'`, `lastDecision.by='broker'`. By construction
 * the executor only marks an op failed when the main order didn't fill —
 * partial-fill / TP-only failures stay `executed`. So a `failed` op has
 * zero broker-side side effects and re-submitting is equivalent to
 * placing a new order. Note: some failure categories (invalid-order,
 * permission) won't get healed by retry — the operator reads the reason
 * and decides. The MAX_RESUBMITS_PER_SIGNAL cap is the safety net.
 *
 * What this is NOT:
 *   - Not a way to bypass guards. Guards run again against fresh market
 *     state. A 1-hour-stale signal will be re-rejected by StaleSignalGuard.
 *   - Not a way to recover a guard-rejected op. Guard rejection means
 *     the engine considered the op and decided no; re-running would
 *     produce the same verdict.
 *   - Not a way to "retry" an executed op. Once broker confirmed the
 *     main order, retrying belongs to a different code path (manual
 *     position management).
 *
 * Bounded chain: a single signal can spawn at most MAX_RESUBMITS_PER_SIGNAL
 * ops total (original + retries). Without this, repeated timeouts /
 * failures could spawn infinite ops.
 */

import type { EventLog } from '../../core/event-log.js'
import { logger } from '../../core/logger.js'
import type { Operation, Signal, KolConfig } from '../../../../shared/types.js'
import type { IPriceService } from '../../connectors/market/types.js'
import { computePriceCheck } from '../signals/price-check.js'
import type { ISignalStore } from '../signals/persistence/signal-store.js'
import type { CopyTradingEngine } from './engine.js'
import type { IOperationStore } from './operation-store.js'

/**
 * How many times a single signal can be resubmitted. The original op
 * counts as attempt #1, so MAX=3 allows the original plus two resubmits.
 */
export const MAX_RESUBMITS_PER_SIGNAL = 3

export type ResubmitResult =
  | { ok: true; operation: Operation }
  | { ok: false; code: 'op-not-found' }
  | { ok: false; code: 'signal-not-found'; signalId: string }
  | { ok: false; code: 'kol-not-found'; kolId: string }
  | {
      ok: false
      code: 'not-resubmittable'
      currentStatus: Operation['status']
      lastDecisionBy?: string
      lastDecisionReason?: string
    }
  | { ok: false; code: 'max-attempts-reached'; attemptCount: number }

/**
 * Eligibility predicate. Pulled out so the dashboard and Telegram
 * surfaces (which need to decide whether to show a 🔄 button) can
 * share the exact same rule as the resubmit endpoint itself.
 */
export function isResubmittable(op: Operation): boolean {
  if (op.status === 'rejected') {
    return (
      op.lastDecision?.by === 'engine' &&
      (op.lastDecision?.reason ?? '').startsWith('approval timeout')
    )
  }
  if (op.status === 'failed') {
    // Executor only marks an op failed when the MAIN order didn't fill.
    // Partial-fill / TP-only failures stay `executed`. So any `failed`
    // op is safe to resubmit (zero broker-side state to reconcile).
    return op.lastDecision?.by === 'broker'
  }
  return false
}

export interface ResubmitDeps {
  store: IOperationStore
  signalStore: ISignalStore
  engine: CopyTradingEngine
  events: EventLog
  /** Lookup KOL config; pulled from KolRegistry. */
  getKol: (kolId: string) => KolConfig | undefined
  /** Optional — refresh signal.priceCheck before resubmitting. */
  priceService?: IPriceService
}

export class ResubmitService {
  constructor(private readonly deps: ResubmitDeps) {}

  async resubmit(operationId: string): Promise<ResubmitResult> {
    // 1. Find the source op.
    const allOps = await this.deps.store.readAllOperations()
    const op = allOps.find((o) => o.id === operationId)
    if (!op) return { ok: false, code: 'op-not-found' }

    // 2. Eligibility: approval timeout OR broker-failed main order.
    if (!isResubmittable(op)) {
      return {
        ok: false,
        code: 'not-resubmittable',
        currentStatus: op.status,
        ...(op.lastDecision?.by !== undefined && { lastDecisionBy: op.lastDecision.by }),
        ...(op.lastDecision?.reason !== undefined && { lastDecisionReason: op.lastDecision.reason }),
      }
    }

    // 3. Enforce per-signal attempt cap. Count every op that traces
    //    back to this signal (the original + any prior resubmits).
    const attemptCount = allOps.filter((o) => o.signalId === op.signalId).length
    if (attemptCount >= MAX_RESUBMITS_PER_SIGNAL) {
      return {
        ok: false,
        code: 'max-attempts-reached',
        attemptCount,
      }
    }

    // 4. Recover the original signal. SignalStore is replay-only, so
    //    walk the file (small at current volume) until we hit the id.
    const signal = await this.findSignalById(op.signalId)
    if (!signal) {
      return { ok: false, code: 'signal-not-found', signalId: op.signalId }
    }

    const kol = this.deps.getKol(signal.kolId)
    if (!kol) {
      return { ok: false, code: 'kol-not-found', kolId: signal.kolId }
    }

    // 5. Refresh the priceCheck so the new op reflects current market
    //    state. Without this the StaleSignalGuard would see whatever
    //    stale `signal.priceCheck` was attached at original parse time
    //    — defeating the whole point of re-running guards.
    const refreshedSignal: Signal = { ...signal }
    if (this.deps.priceService) {
      try {
        const check = await computePriceCheck(refreshedSignal, this.deps.priceService)
        if (check) refreshedSignal.priceCheck = check
      } catch (err) {
        // Same policy as the main pipeline: failures don't block.
        logger.warn(
          { err, signalId: signal.id },
          'ResubmitService: priceCheck refresh failed; resubmitting with stale data',
        )
      }
    }

    // 6. Run the engine. Same code path as a fresh signal — guards fire,
    //    sizer pulls a current snapshot, operation gets persisted, and
    //    the operation.created event triggers the Telegram notifier
    //    (which will send a brand-new approval card).
    const newOp = await this.deps.engine.process(refreshedSignal, kol)
    if (!newOp) {
      // engine returns null when there's no enabled account or no snapshot.
      // Treat as a soft failure — surface the original op's status so the
      // caller can tell the operator "couldn't resubmit; engine isn't
      // ready for this account yet."
      logger.warn(
        { operationId, signalId: signal.id },
        'ResubmitService: engine.process returned null (no account / no snapshot)',
      )
      return { ok: false, code: 'op-not-found' }
    }

    // 7. Audit trail — emit a dedicated event so the dashboard event
    //    timeline can show "resubmitted from <oldId>" alongside the
    //    routine operation.created. The operation.created event is
    //    already emitted by engine.process so we don't duplicate it.
    await this.deps.events.append('operation.resubmitted', {
      originalOperationId: op.id,
      newOperationId: newOp.id,
      signalId: signal.id,
      kolId: signal.kolId,
      attemptNumber: attemptCount + 1,
    })

    logger.info(
      {
        originalOperationId: op.id,
        newOperationId: newOp.id,
        signalId: signal.id,
        attemptNumber: attemptCount + 1,
      },
      'ResubmitService: signal resubmitted',
    )

    return { ok: true, operation: newOp }
  }

  private async findSignalById(signalId: string): Promise<Signal | null> {
    for await (const rec of this.deps.signalStore.replay()) {
      if (rec.kind === 'signal' && rec.record.id === signalId) {
        return rec.record
      }
    }
    return null
  }
}
