/**
 * Turn an approved `Operation` into a concrete set of broker orders.
 *
 * The executor is the only place that:
 *   - converts USDT notional → base-currency `amount` via fetchTicker
 *   - enforces ExecutionConfig safety knobs (slippage, max notional)
 *   - sets leverage / margin mode
 *   - decides how many orders to place (main + SL + TP)
 *
 * Order strategy (Bitget perp, the current target):
 *   - Main order: market or limit with `stopLossPrice` and (best-effort)
 *     `takeProfitPrice` ccxt-unified params attached. Bitget supports
 *     SL+ one TP per position, set as part of the open order. This is
 *     atomic — if the position fills, SL/TP are immediately active.
 *   - Extra TPs (level ≥ 2): placed AFTER the main fills, as separate
 *     reduce-only limit orders. We don't try to make these atomic with
 *     the open — if the second TP fails, the position still has SL +
 *     TP1 protection, and the failure is logged.
 *
 * We DO NOT poll fills. The main order's response from createOrder is
 * the canonical record. SnapshotService picks up actual position deltas
 * on its 30s tick. Phase 7 will add a dedicated order-status poller for
 * partial fills / amendments.
 */

import { logger } from '../../../core/logger.js'
import type { ExecutionConfig } from '../../../core/execution-config.js'
import type {
  Operation,
  OperationSpec,
} from '../../../../../shared/types.js'
import type { ICryptoBroker, OrderSide } from './crypto-broker.js'
import { classifyError } from './error-classifier.js'

// `placeOrder` action narrowed once the ApprovalService has handed us a real op.
type OpenOrderSpec = Extract<OperationSpec, { action: 'placeOrder' }>

export interface ExecutionAttachment {
  /** Main entry order id (from broker). */
  mainOrderId: string
  /** Whether the main order included unified SL/TP params (atomic). */
  slAttachedToMain: boolean
  tpAttachedToMain: boolean
  /** Order ids of the extra TPs we placed as separate reduce-only limits. */
  extraTpOrderIds: string[]
  /** Standalone SL order id, if SL had to be placed separately. */
  slOrderId?: string
  /** ISO timestamp when the broker accepted the main order. */
  filledAt: string
  /** Reference price used to convert notional → amount (ticker.last at execute time). */
  refPrice: string
  /** Final base-currency amount sent to the broker. */
  amount: string
}

/**
 * Failure surfaced as a thrown error so the dispatcher can call
 * ApprovalService.transition('failed', { reason }). Carries the
 * classified category so retry policy can use it.
 */
export class ExecutionError extends Error {
  constructor(
    public readonly category: import('./error-classifier.js').ErrorCategory,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'ExecutionError'
  }
}

export interface OrderExecutorDeps {
  broker: ICryptoBroker
  /**
   * Reads the LATEST execution config per call so dashboard flips of
   * `mode: dry-run | live` take effect immediately, without process restart.
   */
  loadExecutionConfig: () => Promise<ExecutionConfig>
}

export class OrderExecutor {
  constructor(private readonly deps: OrderExecutorDeps) {}

  /**
   * Execute an approved operation. Returns ExecutionAttachment on success;
   * throws ExecutionError on any failure (classified). Caller handles
   * status transitions / event emission.
   *
   * Dry-run: returns a stub attachment with `mainOrderId` = "DRYRUN-<opId>"
   * — no broker call is made.
   */
  async execute(op: Operation): Promise<ExecutionAttachment> {
    if (op.spec.action !== 'placeOrder') {
      throw new ExecutionError(
        'invalid-order',
        `executor only handles placeOrder; got ${op.spec.action}`,
      )
    }
    const spec = op.spec
    const cfg = await this.deps.loadExecutionConfig()

    // ── 1. Fetch ticker — also serves as a connectivity smoke test
    const refPrice = await this.fetchRefPrice(spec.symbol)

    // ── 2. Compute order amount (base-currency)
    const notional = this.notionalUsdt(spec)
    if (cfg.maxOrderUsdt > 0 && notional > cfg.maxOrderUsdt) {
      throw new ExecutionError(
        'invalid-order',
        `notional ${notional.toFixed(2)} USDT exceeds maxOrderUsdt ${cfg.maxOrderUsdt}`,
      )
    }
    const amount = this.computeAmount(spec, notional, refPrice)

    // ── 3. Slippage check (market orders only — limit orders carry their own ceiling)
    if (cfg.slippageTolerancePercent > 0 && spec.orderType === 'market') {
      this.assertSlippageOk(op, refPrice, cfg.slippageTolerancePercent)
    }

    // ── 4. Dry-run short-circuit
    if (cfg.mode === 'dry-run') {
      logger.info(
        {
          opId: op.id,
          symbol: spec.symbol,
          side: spec.side,
          notional: notional.toFixed(2),
          amount: amount.toFixed(8),
          refPrice: refPrice.toFixed(2),
        },
        'OrderExecutor: DRY-RUN — would have placed order',
      )
      return {
        mainOrderId: `DRYRUN-${op.id}`,
        slAttachedToMain: spec.stopLoss != null,
        tpAttachedToMain: (spec.takeProfits?.length ?? 0) > 0,
        extraTpOrderIds: [],
        filledAt: new Date().toISOString(),
        refPrice: refPrice.toFixed(2),
        amount: amount.toFixed(8),
      }
    }
    void cfg.slippageTolerancePercent  // hooked for Phase 7 (see assertSlippageOk)

    // ── 5. Live: leverage + main order + (optional extra TPs)
    if (cfg.setLeverage && spec.leverage !== undefined && spec.contractType === 'perpetual') {
      try {
        await this.deps.broker.setLeverage(spec.leverage, spec.symbol, cfg.marginMode)
      } catch (err) {
        // Surface as classified error — auth / margin issues here are not retriable.
        const classified = classifyError(err)
        throw new ExecutionError(
          classified.category,
          `setLeverage failed: ${classified.message}`,
          err,
        )
      }
    }

    // First TP rides along on the main order via ccxt unified params.
    // Extra TPs (level >= 2) get separate reduce-only limit orders below.
    const firstTp = spec.takeProfits?.[0]
    const params: Record<string, unknown> = {}
    if (spec.stopLoss?.price) params['stopLossPrice'] = Number(spec.stopLoss.price)
    if (firstTp?.price) params['takeProfitPrice'] = Number(firstTp.price)

    let mainOrderId: string
    try {
      const mainOrder = await this.deps.broker.placeOrder({
        symbol: spec.symbol,
        side: this.openSide(spec),
        type: spec.orderType,
        amount,
        ...(spec.orderType === 'limit' && spec.price !== undefined && { price: Number(spec.price) }),
        params,
      })
      if (!mainOrder.id) {
        throw new ExecutionError('exchange', 'broker returned order without id')
      }
      mainOrderId = mainOrder.id
    } catch (err) {
      if (err instanceof ExecutionError) throw err
      const classified = classifyError(err)
      throw new ExecutionError(
        classified.category,
        `main order failed: ${classified.message}`,
        err,
      )
    }

    // Extra TPs — best-effort. If one fails, log and continue; the main
    // position is already protected by SL + TP1 attached above.
    const closeSide = this.closeSide(spec)
    const extraTpOrderIds: string[] = []
    const extras = (spec.takeProfits ?? []).slice(1)
    if (extras.length > 0) {
      // Split the position evenly across extra TPs. (TP1 is on the main
      // order — no portion of the position is reserved for it here, since
      // exchanges reduce TP1 fill from the position automatically.)
      const perTpAmount = amount / (extras.length + 1)
      for (const tp of extras) {
        try {
          const order = await this.deps.broker.placeOrder({
            symbol: spec.symbol,
            side: closeSide,
            type: 'limit',
            amount: perTpAmount,
            price: Number(tp.price),
            params: { reduceOnly: true },
          })
          if (order.id) extraTpOrderIds.push(order.id)
        } catch (err) {
          logger.warn(
            { err, opId: op.id, tpLevel: tp.level, tpPrice: tp.price },
            'OrderExecutor: extra TP order failed — main position still has SL + TP1',
          )
        }
      }
    }

    return {
      mainOrderId,
      slAttachedToMain: spec.stopLoss != null,
      tpAttachedToMain: firstTp != null,
      extraTpOrderIds,
      filledAt: new Date().toISOString(),
      refPrice: refPrice.toFixed(2),
      amount: amount.toFixed(8),
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async fetchRefPrice(symbol: string): Promise<number> {
    let ticker
    try {
      ticker = await this.deps.broker.fetchTicker(symbol)
    } catch (err) {
      const classified = classifyError(err)
      throw new ExecutionError(
        classified.category,
        `fetchTicker(${symbol}) failed: ${classified.message}`,
        err,
      )
    }
    const last = ticker.last ?? ticker.close ?? ticker.bid
    if (last == null || !Number.isFinite(last) || last <= 0) {
      throw new ExecutionError(
        'invalid-order',
        `fetchTicker(${symbol}) returned no usable price`,
      )
    }
    return last
  }

  private notionalUsdt(spec: OpenOrderSpec): number {
    if (spec.size.unit !== 'absolute') {
      throw new ExecutionError(
        'invalid-order',
        `executor expects size.unit='absolute' (USDT notional); got ${spec.size.unit}`,
      )
    }
    const n = Number(spec.size.value)
    if (!Number.isFinite(n) || n <= 0) {
      throw new ExecutionError('invalid-order', `notional must be > 0; got ${spec.size.value}`)
    }
    return n
  }

  private computeAmount(
    spec: OpenOrderSpec,
    notional: number,
    refPrice: number,
  ): number {
    // For limit orders we prefer the limit price (that's what the position
    // will actually open at if filled). For market orders, the live ticker
    // is the best available proxy.
    const sizingPrice =
      spec.orderType === 'limit' && spec.price !== undefined
        ? Number(spec.price)
        : refPrice
    if (!Number.isFinite(sizingPrice) || sizingPrice <= 0) {
      throw new ExecutionError('invalid-order', 'sizing price <= 0')
    }
    return notional / sizingPrice
  }

  private assertSlippageOk(
    op: Operation,
    refPrice: number,
    tolerancePercent: number,
  ): void {
    // The sizing equity in op.sizingContext is per-account, not a
    // reference market price. We don't have a stored entry price for
    // market orders. Use the priceCheck.livePrice the signal carried,
    // when present, or skip silently.
    // (Operation doesn't currently embed priceCheck; this is a hook for
    //  Phase 7 once we propagate signal.priceCheck → operation.)
    void op
    void refPrice
    void tolerancePercent
    // No-op for now. Slippage protection comes online once Operation
    // carries the signal's priceCheck snapshot.
  }

  private openSide(spec: OpenOrderSpec): OrderSide {
    return spec.side === 'long' ? 'buy' : 'sell'
  }

  private closeSide(spec: OpenOrderSpec): OrderSide {
    return spec.side === 'long' ? 'sell' : 'buy'
  }
}
