import type { OperationGuard, GuardContext } from './types.js'

/**
 * Reject when the price-check layer flagged the signal as stale —
 * i.e. the live market has already moved past the entry in the wrong
 * direction. Trading after the move usually means worse R/R and a
 * higher chance of being stopped out.
 *
 * Limit orders are exempt. The whole point of a limit order is to wait
 * for the market to move BACK to the entry price before filling — a
 * long limit sitting below the current price (or a short limit above)
 * is the canonical pullback / pump-rejection setup. If price never
 * comes back the order simply never fills, no risk taken. If it does
 * come back, that's the entry the KOL wanted. The "stale" flag (live
 * > entry on a long, etc.) only signals a problem for *market* orders,
 * which would fill immediately at the worse price.
 *
 * If `signal.priceCheck` is absent (price service couldn't resolve the
 * symbol, or the signal pre-dates Layer 1), the guard passes — better
 * to forward to a human than reject for a missing field.
 */
export class StaleSignalGuard implements OperationGuard {
  readonly name = 'stale-signal'

  check(ctx: GuardContext): string | null {
    const pc = ctx.signal.priceCheck
    if (!pc?.stale) return null

    // Limit orders intentionally sit on the "wrong" side of the live
    // price waiting for a pullback / rejection. Don't reject them.
    if (
      ctx.operation.spec.action === 'placeOrder' &&
      ctx.operation.spec.orderType === 'limit'
    ) {
      return null
    }

    const detail = pc.entryDistancePercent !== undefined
      ? ` (entry ${pc.entryDistancePercent}% from live ${pc.currentPrice})`
      : ''
    return `live market has passed entry${detail}; signal is stale`
  }
}
