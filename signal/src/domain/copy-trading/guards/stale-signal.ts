import type { OperationGuard, GuardContext } from './types.js'

/**
 * Reject when the price-check layer flagged the signal as stale —
 * i.e. the live market has already moved past the entry in the wrong
 * direction. Trading after the move usually means worse R/R and a
 * higher chance of being stopped out.
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
    const detail = pc.entryDistancePercent !== undefined
      ? ` (entry ${pc.entryDistancePercent}% from live ${pc.currentPrice})`
      : ''
    return `live market has passed entry${detail}; signal is stale`
  }
}
