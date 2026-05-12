import type { OperationGuard, GuardContext } from './types.js'

/**
 * Reject MARKET orders flagged as stale — the live market has moved
 * past the KOL's stated entry far enough that filling immediately
 * means a meaningfully worse fill than the KOL intended.
 *
 * Limit orders are exempt. A limit sits unfilled until the market
 * comes back to entry; even an egregiously-far-away entry doesn't
 * cost the operator anything (no risk taken, just an order ticket
 * occupying a slot). Whether the KOL's setup will actually trigger
 * is the operator's judgement call — for example:
 *   - KOL喊 "short BTC at 80k" with live 75k → reasonable bounce
 *     setup, operator may approve and wait
 *   - KOL喊 "long ETH at 3500" with live 2800 → maybe a swing
 *     setup the KOL believes in; not our place to refuse
 *
 * The dashboard still surfaces priceCheck.stale (with its different
 * threshold for limit vs market) as a warning callout, so the
 * operator sees the distance flagged at decision time. We just
 * don't auto-reject.
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

    // Limit orders intentionally wait for price to come back; an
    // unfilled limit costs nothing. Operator decides whether to keep
    // it open or cancel.
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
