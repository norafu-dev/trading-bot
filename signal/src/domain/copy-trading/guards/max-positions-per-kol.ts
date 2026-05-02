import type { OperationGuard, GuardContext } from './types.js'

/**
 * Cap on simultaneous KOL exposure: count this KOL's already-pending
 * operations on this account, plus already-open positions whose
 * `signalId → kolId` chain leads back here, against `kol.maxOpenPositions`.
 *
 * Where the "open positions count" comes from is tricky — `TradePosition`
 * (CCXT) only knows symbol + qty, not which KOL opened it. We use a
 * heuristic: if any of `kol.maxOpenPositions` worth of pending operations
 * already exist for this KOL, reject. Pending-only check is conservative
 * (under-counts when broker has open trades the bot didn't open) but
 * never over-counts.
 *
 * A future iteration could track open positions back to their originating
 * operation through the trading-git layer.
 */
export class MaxPositionsPerKolGuard implements OperationGuard {
  readonly name = 'max-positions-per-kol'

  check(ctx: GuardContext): string | null {
    const max = ctx.kol.maxOpenPositions
    if (typeof max !== 'number' || max <= 0) return null

    // Pending operations for this KOL on this account = approved/queued slots
    const used = ctx.pendingForSameKol.length
    if (used >= max) {
      return `KOL ${ctx.kol.id} already has ${used} pending operation(s) (max ${max})`
    }
    return null
  }
}
