import { normalizeSymbol } from '../../connectors/market/symbol-normalize.js'
import type {
  AccountBalance,
  KolConfig,
  Operation,
  OperationSpec,
  RiskConfig,
  Signal,
} from '../../../../shared/types.js'
import { newUlid } from '../../core/ids.js'

/**
 * Turns a `Signal` plus a fresh account snapshot into an `Operation`
 * draft (status 'pending'). Pure function over its inputs — no I/O,
 * no clock dependency apart from the explicit `now`.
 *
 * Sizing math:
 *   raw % = baseRiskPercent × kol.riskMultiplier × signal.confidence
 *   capped % = min(raw %, maxOperationSizePercent)
 *   notional = equity × capped % / 100
 *
 * The output `OperationSpec.size` is always emitted in `'absolute'` units
 * (quote-currency notional) so subsequent equity drift between sizing
 * and execution doesn't change the trade size — the human approver
 * sees and signs off on a fixed dollar amount.
 *
 * Out of scope here:
 *   - Validating that the entry/SL/TP make sense — that's the LLM's job
 *     and the guards' job (StaleSignalGuard, UnitMismatchGuard).
 *   - Rejecting tiny signals — also a guard concern (LowConfidenceGuard).
 *   - Turning the operation into a real broker order — Phase 5.
 */

export interface PositionSizerInput {
  signal: Signal
  kol: KolConfig
  account: AccountBalance
  riskConfig: RiskConfig
  /** ISO 8601 — used for `Operation.createdAt`. Injected for testability. */
  now?: string
}

export class PositionSizer {
  /**
   * Produces an `Operation` from a signal. Always returns an operation —
   * never throws — because every signal deserves at least a pending
   * record (so the dashboard can show "we considered this signal but it
   * was rejected by guard X" instead of silently dropping).
   */
  size(input: PositionSizerInput): Operation {
    const { signal, kol, account, riskConfig } = input
    const now = input.now ?? new Date().toISOString()

    // Sizing math — Numbers are fine here: only one division (×%/100),
    // no compounding, no representation-of-cents concern (output is
    // formatted with toFixed before persistence).
    const equity = Number(account.netLiquidation)
    const baseRisk = riskConfig.baseRiskPercent
    const kolMult = kol.riskMultiplier ?? 1
    const conviction = signal.confidence ?? 1

    const rawPercent = baseRisk * kolMult * conviction
    const cappedPercent = Math.min(rawPercent, riskConfig.maxOperationSizePercent)
    const notional = (equity * cappedPercent) / 100

    // Normalise the symbol to broker-ready CCXT form. `signal.symbol` is
    // whatever the KOL wrote ("比特币", "$HYPE", "BTC/USDT") and would 404
    // at the exchange. If the normaliser can't resolve it, fall back to
    // the raw value — a guard / broker error downstream will make this
    // operation visible (rejected, not silently dropped).
    const contractType = signal.contractType ?? 'perpetual'
    const normalised = normalizeSymbol(signal.symbol, {
      contractType,
      defaultQuote: kol.defaultSymbolQuote,
    })

    // Truncate to the configured max TPs. KOLs sometimes specify 5-7 TP
    // levels, of which the last few rarely get hit and just clutter the
    // exchange's open-orders list with reduce-only orders that occupy
    // margin slots forever.
    const truncatedTps =
      signal.takeProfits && signal.takeProfits.length > 0
        ? signal.takeProfits.slice(0, Math.max(1, riskConfig.maxTakeProfits))
        : undefined

    // Resolve entry price: prefer explicit `price`, else collapse a range
    // to a single edge based on side. Long signals enter on pullbacks →
    // we take the LOW edge (best fill, hardest to reach). Short signals
    // enter on rallies → take the HIGH edge. Without this, range-only
    // entries (e.g. KOL writes "Entry: 0.10 - 0.1064") fall through to
    // limit orders with no price, which the broker rejects.
    const entryPrice = resolveEntryPrice(signal.entry, signal.side ?? 'long')

    const spec: OperationSpec = {
      action: 'placeOrder',
      symbol: normalised?.ccxtSymbol ?? signal.symbol,
      side: (signal.side ?? 'long') as 'long' | 'short',
      contractType,
      orderType: signal.entry?.type ?? 'market',
      ...(entryPrice !== undefined && { price: entryPrice }),
      size: { unit: 'absolute', value: notional.toFixed(2) },
      ...(signal.leverage !== undefined && { leverage: signal.leverage }),
      ...(signal.stopLoss?.price !== undefined && { stopLoss: { price: signal.stopLoss.price } }),
      ...(truncatedTps && truncatedTps.length > 0 && { takeProfits: truncatedTps }),
    }

    return {
      id: newUlid(),
      signalId: signal.id,
      kolId: signal.kolId,
      accountId: account.accountId,
      status: 'pending',
      createdAt: now,
      guardResults: [], // populated by GuardPipeline
      spec,
      sizingContext: {
        equity: equity.toFixed(2),
        effectiveRiskPercent: cappedPercent.toFixed(4),
      },
      // Forward the Layer-1 price-check snapshot to the operation so the
      // approval card can render "live X · 距 TP1 +A% · 距 SL -B%" without
      // re-querying the price service. Stale by the time the card shows
      // (typically 5-30s old) but plenty good for human eyeballing R/R.
      ...(signal.priceCheck && {
        priceCheck: {
          currentPrice: signal.priceCheck.currentPrice,
          source: signal.priceCheck.source,
          fetchedAt: signal.priceCheck.fetchedAt,
        },
      }),
    }
  }
}

/**
 * Convert a Signal.entry (which may be a single price, a range, or
 * neither) into a single broker-ready limit price.
 *
 * Side-aware range collapse:
 *   - long  → priceRangeLow  (we want the cheapest fill; the limit will
 *                              wait for a deeper pullback)
 *   - short → priceRangeHigh (we want the most expensive fill; the limit
 *                              will wait for a higher rally)
 * If only one edge of the range is given, use it. If neither edge is
 * given but `price` is, use that. Otherwise return undefined and the
 * caller's spec.price stays absent (broker will reject a limit order
 * with no price — which is actually correct: we shouldn't fabricate a
 * price the KOL didn't authorise).
 */
function resolveEntryPrice(
  entry: { price?: string; priceRangeLow?: string; priceRangeHigh?: string } | undefined,
  side: 'long' | 'short',
): string | undefined {
  if (!entry) return undefined
  if (entry.price !== undefined) return entry.price
  const low = entry.priceRangeLow
  const high = entry.priceRangeHigh
  if (side === 'long') {
    // Prefer low (deeper pullback), fall back to high if low is missing.
    if (low !== undefined) return low
    if (high !== undefined) return high
  } else {
    if (high !== undefined) return high
    if (low !== undefined) return low
  }
  return undefined
}
