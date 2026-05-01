import type { PositionUpdate } from '../../../../../../shared/types.js'
import type { ILinkStrategy, ISignalIndex, LinkResult, LinkStrategy } from '../types.js'

/**
 * `by_kol_symbol` — heuristic link via (kolId, symbol).
 *
 * Used when no external-id reference exists in the update — typical of
 * human KOLs who write natural-language updates ("ETH TP1 hit, take 30%").
 *
 * Algorithm:
 *   1. Require `update.symbol` to be present. Without it we cannot disambiguate
 *      between this KOL's open positions; refuse rather than guess.
 *   2. Look up open signals for (kolId, symbol) at-or-before
 *      `update.receivedAt`. The temporal bound prevents linking an update to
 *      a signal that was parsed AFTER the update (out-of-order replay).
 *   3. If exactly one open signal matches → exact-confidence link.
 *   4. If multiple open signals match → pick the most recent and report
 *      `'inferred'` confidence. The KOL is most likely managing their newest
 *      position; downstream guards can demand manual approval based on the
 *      lower confidence. (Decision B in the Batch 6 design doc.)
 *   5. If zero matches → unlinked.
 */
export class ByKolSymbolStrategy implements ILinkStrategy {
  readonly name: LinkStrategy = 'by_kol_symbol'

  tryLink(update: PositionUpdate, index: ISignalIndex): LinkResult {
    if (!update.symbol) {
      return { linked: false, reason: 'update has no symbol field' }
    }

    const before = new Date(update.receivedAt)
    const candidates = index.findOpenByKolAndSymbol(update.kolId, update.symbol, before)

    if (candidates.length === 0) {
      return {
        linked: false,
        reason: `no open ${update.symbol} signal for kol ${update.kolId}`,
      }
    }

    // Most recent first (per ISignalIndex.findOpenByKolAndSymbol contract)
    const target = candidates[0]
    const confidence: 'exact' | 'inferred' = candidates.length === 1 ? 'exact' : 'inferred'
    return { linked: true, signalId: target.id, confidence }
  }
}
