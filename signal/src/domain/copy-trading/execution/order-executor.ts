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
  RiskConfig,
} from '../../../../../shared/types.js'
import type { ICryptoBroker, OrderSide } from './crypto-broker.js'
import { classifyError } from './error-classifier.js'
import { distributeTpAmounts } from './tp-distribution.js'

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
  /**
   * Reads the LATEST risk config — used here for `tpDistribution` (how
   * the position is split across TP levels). Loaded per-execute for the
   * same reason: dashboard edits should land on the next operation
   * without requiring a restart.
   */
  loadRiskConfig: () => Promise<RiskConfig>
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
    const riskCfg = await this.deps.loadRiskConfig()

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

    // ── 4. TP filter — drop levels the live price has already crossed
    // (long: TP below live; short: TP above live). Such reduce-only
    // limits would fill instantly on position open. Computed here so
    // dry-run sees the same surviving set as live would.
    const validTps = (spec.takeProfits ?? []).filter((tp) => {
      const v = Number(tp.price)
      if (!Number.isFinite(v) || v <= 0) return false
      return spec.side === 'long' ? v > refPrice : v < refPrice
    })
    if (spec.takeProfits && validTps.length < spec.takeProfits.length) {
      const skipped = spec.takeProfits.filter((tp) => !validTps.includes(tp))
      logger.warn(
        {
          opId: op.id,
          live: refPrice,
          skipped: skipped.map((tp) => ({ level: tp.level, price: tp.price })),
        },
        `OrderExecutor: ${skipped.length} TP(s) already crossed by live price — skipping`,
      )
    }

    // ── 5. Dry-run short-circuit
    if (cfg.mode === 'dry-run') {
      logger.info(
        {
          opId: op.id,
          symbol: spec.symbol,
          side: spec.side,
          notional: notional.toFixed(2),
          amount: amount.toFixed(8),
          refPrice: refPrice.toFixed(2),
          validTps: validTps.map((tp) => tp.level),
        },
        'OrderExecutor: DRY-RUN — would have placed order',
      )
      return {
        mainOrderId: `DRYRUN-${op.id}`,
        slAttachedToMain: spec.stopLoss != null,
        tpAttachedToMain: false,  // TPs are standalone reduce-only orders now
        extraTpOrderIds: validTps.map((tp) => `DRYRUN-tp${tp.level}-${op.id}`),
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

    // SL rides along on the main order as a position-attached preset SL —
    // broker closes the WHOLE position if SL trips, which is the right
    // semantic ("we're stopped out, exit everything"). TPs are placed
    // AFTER the main fills, each as a sized reduce-only limit order so
    // partial fills work as the operator expects (TP1 closes 25%, TP2
    // closes the next 25%, etc).
    //
    // Why `stopLoss: { triggerPrice }` and not `stopLossPrice`:
    // ccxt's bitget adapter treats the flat `stopLossPrice` param as a
    // *standalone* trigger order (planType=pos_loss) and reverse-infers
    // holdSide from `side` — for `side=buy` it sets holdSide=sell, which
    // makes Bitget validate the SL as a SHORT position's stop and reject
    // with code 45122 "Short position stop loss price please > mark
    // price". The structured `stopLoss: { triggerPrice }` form maps to
    // Bitget's `presetStopLossPrice`, attached to the main order, with
    // direction inferred from the order's own side — no misclassification.
    //
    // Why TPs are NOT folded into `takeProfit`/`takeProfitPrice`: those
    // params have no size argument, so brokers default to "close 100%
    // of the position" when triggered. Sized reduce-only limits give
    // precise control over multi-TP ladder distributions.
    const params: Record<string, unknown> = {}
    if (spec.stopLoss?.price) {
      params['stopLoss'] = { triggerPrice: Number(spec.stopLoss.price) }
    }

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

    // ── TP ladder ────────────────────────────────────────────────────
    // Place one reduce-only limit per TP level, sized per the configured
    // distribution. Best-effort: if individual TP orders fail (e.g. price
    // too far from market on a tiny altcoin), log and continue — the SL
    // is already attached so the position is at least bounded.
    //
    // Filter out TPs that the live price has already crossed (long: TP
    // below live; short: TP above live). Such reduce-only limit orders
    // would fill instantly upon position open — turning the meant-to-be
    // multi-TP ladder into "open and immediately close half the position
    // for whatever the current market gives." Filter computed earlier
    // (step 4) is reused here so live and dry-run see the same set.
    const closeSide = this.closeSide(spec)
    const tpOrderIds: string[] = []
    if (validTps.length > 0) {
      const tpAmounts = distributeTpAmounts(amount, validTps.length, riskCfg.tpDistribution)
      for (let i = 0; i < validTps.length; i++) {
        const tp = validTps[i]
        const perTpAmount = tpAmounts[i]
        try {
          const order = await this.deps.broker.placeOrder({
            symbol: spec.symbol,
            side: closeSide,
            type: 'limit',
            amount: perTpAmount,
            price: Number(tp.price),
            params: { reduceOnly: true },
          })
          if (order.id) tpOrderIds.push(order.id)
        } catch (err) {
          logger.warn(
            { err, opId: op.id, tpLevel: tp.level, tpPrice: tp.price },
            'OrderExecutor: TP order failed — main position still has SL attached',
          )
        }
      }
    }

    return {
      mainOrderId,
      slAttachedToMain: spec.stopLoss != null,
      tpAttachedToMain: false,  // TPs are now standalone reduce-only orders, never on main
      extraTpOrderIds: tpOrderIds,  // legacy field name preserved; carries ALL TP orders now
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
