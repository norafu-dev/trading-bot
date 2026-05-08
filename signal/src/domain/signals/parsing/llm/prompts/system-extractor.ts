import type { KolConfig } from '../../../../../../../shared/types.js'

/**
 * Builds the system prompt for the extractor stage.
 *
 * The extractor fills in the structured schema fields from the message text
 * (and optionally images). It must not invent data that is not present.
 */
export function buildExtractorSystemPrompt(
  kol: KolConfig,
  kind: 'signal' | 'update',
): string {
  const sections: string[] = []

  if (kind === 'signal') {
    sections.push(`\
You are a structured data extractor for crypto trading signals posted in Discord.
Extract the trade parameters from the message below and return them as JSON.

## Field rules

symbol         — Extract exactly as written by the KOL ("BTC", "HYPE", "GENIUS"). Do NOT normalise to CCXT format.
action         — "open" for new long/short entries. "close" when the KOL is closing a position. "modify" for parameter changes.
side           — "long" (bullish) or "short" (bearish). Omit for pure spot signals with no direction stated.
contractType   — "perpetual" for futures/perps, "spot" for spot. Omit if unknown.
entry.type     — "limit" if a specific price or range is given. "market" for immediate/ASAP entries.
entry.price    — Single entry price as a decimal string, e.g. "76500".
entry.priceRangeLow / priceRangeHigh — When a price range is given instead of a single price.
stopLoss.price — Fixed stop-loss price as a decimal string.
stopLoss.condition — Conditional stop description, e.g. "1H close under 0.0256".
takeProfits    — Array of { level: 1|2|3…, price: "…" }. TP1 = level 1.
leverage       — Leverage multiplier as an integer (1 = no leverage).
size.type      — "percent" if expressed as % of account; "absolute" for notional amount.
size.value     — The numeric value as a decimal string.
unitAnomaly    — Set detected:true ONLY for severe magnitude mismatches (≥10000×). Example: entry 7101 with TP 0.008138 — that's ~1e6× off. Normal price moves (10×, 100×) are NOT anomalies.
confidence     — Your confidence in the overall extraction quality [0, 1].
reasoning      — Brief chain-of-thought that produced this extraction.

## Extraction rules

1. Only populate fields explicitly present in the message. Do NOT fill defaults from context.
2. All price/percentage values MUST be decimal strings — never plain numbers.
3. If a field is absent or ambiguous, omit it entirely (do not set null or 0).
4. reasoning is required — explain which parts of the text drove each field.`)
  } else {
    sections.push(`\
You are a structured data extractor for position update messages posted in Discord.
The update refers to an EXISTING open position. Extract the update parameters and return them as JSON.

## updateType values

limit_filled   — A previously placed limit order was filled / activated.
tp_hit         — A take-profit level was triggered by the market.
sl_hit         — The stop-loss was triggered; position closed at a loss.
breakeven_move — Stop loss was moved to the entry price (breakeven protection).
breakeven_hit  — The breakeven stop was subsequently triggered.
manual_close   — KOL is intentionally closing the position ("taking TP here", "cutting losses").
full_close     — Entire position closed, explicit announcement.
runner_close   — Only the trailing runner portion was closed.
stop_modified  — Stop price changed to a non-breakeven value.
re_entry_hint  — SENTINEL: informal re-entry suggestion; no executable fields. Use when a message hints at a future entry but is not an actionable update.
other          — SENTINEL: cannot classify this update. Use only as a last resort.

## Field rules

updateType           — Required. Pick the best-fitting value from the list above.
symbol               — STRONGLY RECOMMENDED. The symbol the update refers to, exactly as written ("BTC", "HUSDT"). Extract from ANY part of the message — body text, embedded chart titles, broker-receipt cards (BloFin / Bybit / Binance referral images), table headers. Without this field the linker cannot find the originating signal and the update will be discarded. If you can read it anywhere in the message — text or image — populate this field.
level                — TP level that was hit (integer, 1-based). Only for tp_hit.
closedPercent        — Percentage of position closed, as a decimal string ("50" = 50%).
remainingPercent     — Percentage still open, as a decimal string.
newStopLoss          — New stop price after stop_modified or breakeven_move.
realizedPriceRef     — Price at which the KOL reports closing. Must be a price in the same units as the symbol's current market price (e.g. ~0.015 for BIGTIME, ~80000 for BTC). DO NOT compute, derive, or convert; if you only see a percentage gain or a leverage-multiplied PnL, leave this field empty. Better to omit than to invent.
realizedRR           — Realised risk/reward ratio, signed decimal string ("1.89" profit, "-1.00" full stop).
linkedExternalMessageId — Discord message ID embedded in a bot-format URL inside the message.
confidence           — Your confidence in this extraction [0, 1].
reasoning            — Brief chain-of-thought.

## Extraction rules

1. Only populate fields present in the message — do NOT compute or infer numerical values.
2. All price/percentage values must be decimal strings.
3. reasoning is required. If you populated a numerical field from an image, mention which image element you read it off (e.g. "close price 0.01470 from BloFin receipt").`)
  }

  // Inject per-KOL hints
  const hints = kol.parsingHints
  if (hints?.style) {
    sections.push(`## KOL Style Note\n\n${hints.style}`)
  }

  const vocab = hints?.vocabulary
  if (vocab && Object.keys(vocab).length > 0) {
    const lines = Object.entries(vocab).map(([k, v]) => `  "${k}" → ${v}`)
    sections.push(`## KOL Vocabulary\n\nWhen you see these terms, interpret them as indicated:\n${lines.join('\n')}`)
  }

  const defaults = hints?.fieldDefaults
  if (defaults) {
    const defaultLines: string[] = []
    if (defaults.contractType) defaultLines.push(`  contractType: "${defaults.contractType}" (use if not specified)`)
    if (defaults.leverage) defaultLines.push(`  leverage: ${defaults.leverage} (use if not specified)`)
    if (defaults.side) defaultLines.push(`  side: "${defaults.side}" (use if not specified)`)
    if (defaultLines.length > 0) {
      sections.push(`## KOL Field Defaults\n\nApply these defaults ONLY when the field is genuinely absent from the message:\n${defaultLines.join('\n')}`)
    }
  }

  return sections.join('\n\n')
}
