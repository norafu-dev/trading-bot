import type { OperationGuard, GuardContext } from './types.js'

/**
 * Reject when the price-check layer flagged a unit-magnitude mismatch
 * between the extracted entry/SL/TP and the live market price.
 *
 * This usually means either the LLM mis-extracted (KOL wrote "7.67"
 * meaning 76700 but the LLM kept "7.67"), or the KOL genuinely typed
 * the wrong magnitude. Either way, executing such an operation is
 * dangerous — a 1000× off entry on a market order would size 1/1000
 * the intended position; on a limit order it'd never fill.
 *
 * Forwarding for human review is the right call. The dashboard shows
 * the priceCheck bar so the operator can spot the mismatch in one glance.
 */
export class UnitMismatchGuard implements OperationGuard {
  readonly name = 'unit-mismatch'

  check(ctx: GuardContext): string | null {
    const pc = ctx.signal.priceCheck
    if (!pc?.unitMismatch) return null
    return `priceCheck flagged unit mismatch: ${pc.note ?? 'magnitude differs from live market'}`
  }
}
