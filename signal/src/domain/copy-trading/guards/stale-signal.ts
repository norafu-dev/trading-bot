import type { OperationGuard, GuardContext } from './types.js'

/**
 * Reject when the price-check layer flagged the signal as stale —
 * the live market has moved past the entry far enough that the trade
 * thesis is suspect. Trading after the move usually means worse R/R
 * and a higher chance of being stopped out.
 *
 * Threshold differs by order type and is resolved up in
 * `computePriceCheck` (1% for market, 5% for limit), so by the time
 * the guard sees `priceCheck.stale === true` the distance has already
 * been judged egregious for that order type. The guard's only job is
 * to convert that flag into a rejection.
 *
 * Earlier versions exempted limit orders entirely — the rationale
 * was "a limit just sits unfilled, no risk taken." But that ignored
 * the case where the KOL's entry range is already so far behind the
 * market that fills are unlikely to happen within the operator's
 * timeframe, AND if they do happen the multiple TPs will already be
 * crossed. The order-type-aware threshold in price-check now lets
 * normal "limit waiting for 1-2% pullback" setups through while
 * catching the egregious "8% past entry" cases.
 *
 * If `signal.priceCheck` is absent (price service couldn't resolve
 * the symbol, or the signal pre-dates Layer 1), the guard passes —
 * better to forward to a human than reject for a missing field.
 */
export class StaleSignalGuard implements OperationGuard {
  readonly name = 'stale-signal'

  check(ctx: GuardContext): string | null {
    const pc = ctx.signal.priceCheck
    if (!pc?.stale) return null
    const detail = pc.entryDistancePercent !== undefined
      ? ` (entry ${pc.entryDistancePercent}% from live ${pc.currentPrice})`
      : ''
    return `live market has passed entry${detail}; signal is stale`
  }
}
