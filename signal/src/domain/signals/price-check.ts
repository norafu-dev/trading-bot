import type { Signal } from '../../../../shared/types.js'
import type { IPriceService } from '../../connectors/market/types.js'
import { logger } from '../../core/logger.js'

/**
 * Threshold (signed %) past which a market-order signal's entry counts as
 * "already gone." A market order fills at the live price, so even a small
 * drift from the KOL's stated entry means worse fills + worse R/R.
 */
const STALE_THRESHOLD_MARKET_PERCENT = 1.0

/**
 * Threshold for limit orders. A limit waits for price to come back to the
 * entry, so the fact that price has drifted somewhat past the entry isn't
 * automatically bad — the order just stays unfilled until the market
 * cooperates. We only flag stale once the drift is large enough that
 * "coming back" is unlikely within the position's lifetime (e.g. 5%).
 *
 * This catches the egregious case (KOL喊单时 0.10, 现价 0.110, entry
 * 区间 0.10-0.1064 早已被穿过 8%+) without falsely staling the normal
 * "limit waiting for a 1-2% pullback" setup.
 */
const STALE_THRESHOLD_LIMIT_PERCENT = 5.0

/**
 * Magnitude difference (factor) above which we declare a unit mismatch.
 * 100× catches the typical "wrote 0.0766 meaning 7.66" or "7.66 meaning
 * 76600" cases without flagging the legitimate "entry 76500 / TP 78000"
 * (which is only ~2% apart).
 */
const UNIT_MISMATCH_FACTOR = 100

/**
 * Computes the price-check metadata that should be attached to a Signal
 * after extraction. Returns `null` (rather than throwing) when the symbol
 * cannot be resolved — the caller should leave `signal.priceCheck`
 * undefined in that case.
 *
 * Pure function over (signal, priceService); no event-log writes, no
 * mutation. The caller decides where the result goes (Signal.priceCheck).
 */
export async function computePriceCheck(
  signal: Pick<
    Signal,
    'symbol' | 'side' | 'contractType' | 'entry' | 'stopLoss' | 'takeProfits'
  >,
  priceService: IPriceService,
): Promise<NonNullable<Signal['priceCheck']> | null> {
  const quote = await priceService.getPrice(signal.symbol, signal.contractType)
  if (!quote) {
    logger.debug(
      { symbol: signal.symbol, contractType: signal.contractType },
      'price-check: symbol not resolvable, skipping',
    )
    return null
  }

  const live = Number(quote.price)
  if (!Number.isFinite(live) || live <= 0) return null

  const entryRef = pickEntryReference(signal.entry)
  let entryDistancePercent: string | undefined
  let stale: boolean | undefined
  let unitMismatch: boolean | undefined

  if (entryRef !== undefined) {
    const entry = Number(entryRef)
    if (Number.isFinite(entry) && entry > 0) {
      const distPct = ((entry - live) / live) * 100
      entryDistancePercent = distPct.toFixed(3)

      // "Stale": the live price has already moved past the entry in the
      // direction the trade is supposed to capture. Threshold differs by
      // order type — see constants above.
      const threshold =
        signal.entry?.type === 'limit'
          ? STALE_THRESHOLD_LIMIT_PERCENT
          : STALE_THRESHOLD_MARKET_PERCENT
      if (signal.side === 'long' && distPct < -threshold) {
        stale = true
      } else if (signal.side === 'short' && distPct > threshold) {
        stale = true
      }

      // "Unit mismatch": ratio between live and entry is far enough off that
      // we suspect a unit typo. Symmetric — entry could be too small (10×
      // smaller meaning user wrote 7.66 for 76.6) or too large.
      const ratio = entry > live ? entry / live : live / entry
      if (ratio >= UNIT_MISMATCH_FACTOR) {
        unitMismatch = true
      }
    }
  }

  // SL / TPs feed into unitMismatch too — if any of them is wildly off,
  // flag the whole signal so the operator knows to look at it.
  if (!unitMismatch) {
    const refs = [
      signal.stopLoss?.price,
      ...(signal.takeProfits?.map((tp) => tp.price) ?? []),
    ].filter((p): p is string => typeof p === 'string' && p.length > 0)
    for (const ref of refs) {
      const n = Number(ref)
      if (!Number.isFinite(n) || n <= 0) continue
      const ratio = n > live ? n / live : live / n
      if (ratio >= UNIT_MISMATCH_FACTOR) {
        unitMismatch = true
        break
      }
    }
  }

  const note = buildNote({
    live,
    entryRef,
    side: signal.side,
    stale,
    unitMismatch,
  })

  return {
    currentPrice: quote.price,
    source: quote.source,
    fetchedAt: quote.fetchedAt,
    ...(entryDistancePercent !== undefined && { entryDistancePercent }),
    ...(stale !== undefined && { stale }),
    ...(unitMismatch !== undefined && { unitMismatch }),
    note,
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Pick the most representative entry price from `signal.entry`:
 *   - Single `price` if set
 *   - Otherwise the midpoint of `priceRangeLow` / `priceRangeHigh`
 *   - Otherwise `priceRangeLow` or `priceRangeHigh` alone
 */
function pickEntryReference(entry: Signal['entry']): string | undefined {
  if (!entry) return undefined
  if (entry.price) return entry.price
  const lo = entry.priceRangeLow
  const hi = entry.priceRangeHigh
  if (lo && hi) {
    const m = (Number(lo) + Number(hi)) / 2
    return Number.isFinite(m) ? String(m) : lo
  }
  return lo ?? hi
}

function buildNote(args: {
  live: number
  entryRef: string | undefined
  side: Signal['side']
  stale: boolean | undefined
  unitMismatch: boolean | undefined
}): string {
  const parts: string[] = [`live ${args.live}`]
  if (args.entryRef !== undefined) {
    parts.push(`entry ${args.entryRef}`)
  }
  if (args.unitMismatch) {
    parts.push('unit mismatch suspected')
  } else if (args.stale) {
    parts.push(`${args.side ?? 'signal'} already past entry`)
  } else if (args.entryRef !== undefined) {
    parts.push(`${args.side ?? 'signal'} fresh`)
  }
  return parts.join(' · ')
}
