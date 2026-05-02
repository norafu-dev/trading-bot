/**
 * Pre-extraction symbol detection.
 *
 * The Extractor needs to fetch a live market price BEFORE the LLM call,
 * so the LLM can use the price as a unit-normalisation reference. But the
 * symbol is itself one of the fields the LLM is meant to extract — chicken
 * and egg.
 *
 * This module solves the egg side: a cheap regex / dictionary scan over
 * the bundle text that finds the most likely symbol(s) good enough to
 * fetch a price hint. False positives (a non-symbol token slipping through)
 * are tolerated — the worst outcome is the price service returns null and
 * we proceed without a hint, identical to the pre-Layer-2 behaviour.
 *
 * What we DON'T do here:
 *   - We don't try to be exhaustive. The LLM still has the final say.
 *   - We don't cover obscure / brand-new tokens that aren't on Binance —
 *     those will cause `priceService.getPrice` to return null, and that's
 *     fine.
 */

const CHINESE_NAMES: Record<string, string> = {
  比特币: 'BTC',
  以太坊: 'ETH',
  以太: 'ETH',
  索拉纳: 'SOL',
  莱特币: 'LTC',
  狗狗币: 'DOGE',
  瑞波币: 'XRP',
  瑞波: 'XRP',
  邦币: 'BNB',
  币安币: 'BNB',
  雪崩: 'AVAX',
  波场: 'TRX',
  柚子币: 'EOS',
}

/**
 * Tokens that look like symbols but aren't. Without this list, regex would
 * pick up "TP1", "SL", "BTC" mixed with random noise. Includes English /
 * Chinese command words and timeframe markers.
 */
const STOPWORDS = new Set([
  // Trading vocabulary
  'TP', 'SL', 'TPS', 'SLS', 'PNL', 'ROI', 'CMP', 'BE',
  'LONG', 'SHORT', 'BUY', 'SELL', 'OPEN', 'CLOSE',
  'STOP', 'LOSS', 'PROFIT', 'TARGET', 'ENTRY', 'EXIT',
  'LIMIT', 'MARKET', 'STOPLOSS',
  'SPOT', 'PERP', 'PERPS', 'FUTURES',
  'USD', 'USDT', 'USDC', 'BUSD', 'DAI',
  // Common false positives
  'OK', 'NO', 'YES', 'AKA', 'AT', 'ON', 'IN', 'IT', 'IS', 'BE', 'TO',
  'JUST', 'WAS', 'WHEN', 'NOW', 'NEW', 'OLD',
  'LMT', 'MKT', 'BID', 'ASK',
  // Timeframes / candle ids
  'H', 'M', 'D', 'W',
  'AM', 'PM', 'EST', 'UTC',
  // KOL slang
  'GM', 'GN', 'WAGMI', 'NGMI',
])

export interface SymbolCandidate {
  /** The raw symbol token, uppercased: "BTC", "HYPE". */
  symbol: string
  /** Heuristic score: higher = more confident this is a real ticker. */
  confidence: 'high' | 'medium' | 'low'
  /** Where in the text the candidate came from — useful for debugging. */
  source: 'chinese' | 'discord-link' | 'caps-token' | 'flat-pair' | 'ccxt-shape'
}

/**
 * Scan `text` for likely symbol tokens. Returns up to `max` candidates
 * ordered by confidence. Returns an empty array when nothing plausible
 * appears — the caller should treat that as "no price hint available".
 */
export function detectSymbols(text: string, max = 3): SymbolCandidate[] {
  if (!text) return []

  const found = new Map<string, SymbolCandidate>()

  // 1. Chinese names — high confidence (dictionary match)
  for (const [cn, base] of Object.entries(CHINESE_NAMES)) {
    if (text.includes(cn) && !found.has(base)) {
      found.set(base, { symbol: base, confidence: 'high', source: 'chinese' })
    }
  }

  // 2. Discord-link bot format: `[BTC](https://...)` or `[**BTC**](...)`
  //    High confidence — bot KOLs put the canonical symbol in the link text.
  for (const m of text.matchAll(/\[\*?\*?([A-Z][A-Z0-9]{1,9})\*?\*?\]\(/g)) {
    const sym = m[1]
    if (STOPWORDS.has(sym)) continue
    if (!found.has(sym)) {
      found.set(sym, { symbol: sym, confidence: 'high', source: 'discord-link' })
    }
  }

  // 3. CCXT-shape: "BTC/USDT" or "BTC/USDT:USDT"
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9]{1,9})\/(USDT|USDC|USD|BUSD|BTC|ETH)\b/g)) {
    const sym = m[1]
    if (STOPWORDS.has(sym)) continue
    if (!found.has(sym)) {
      found.set(sym, { symbol: sym, confidence: 'high', source: 'ccxt-shape' })
    }
  }

  // 4. Exchange-flat: "BTCUSDT", "ETHUSDT"
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9]{1,9})(USDT|USDC|BUSD)\b/g)) {
    const base = m[1]
    if (STOPWORDS.has(base)) continue
    if (base.length < 2) continue
    if (!found.has(base)) {
      found.set(base, { symbol: base, confidence: 'medium', source: 'flat-pair' })
    }
  }

  // 5. Bare ALL-CAPS tokens — last-resort. Filtered by stopword + length.
  //    Medium-low confidence; a $-prefix bumps it to medium.
  for (const m of text.matchAll(/(?<=^|[\s,(（[$#])\$?([A-Z][A-Z0-9]{2,9})(?=$|[\s,!?。.,)）\]])/gm)) {
    const raw = m[0]
    const sym = m[1]
    if (STOPWORDS.has(sym)) continue
    // TP1 / SL2 / TP4 etc. — trading vocab + ordinal
    if (/^(TP|SL|RR)\d+$/.test(sym)) continue
    if (found.has(sym)) continue
    const conf = raw.startsWith('$') ? 'medium' : 'low'
    found.set(sym, { symbol: sym, confidence: conf, source: 'caps-token' })
  }

  // Ordering: high → medium → low; within tier preserve insertion order.
  const order: SymbolCandidate['confidence'][] = ['high', 'medium', 'low']
  const sorted = Array.from(found.values()).sort(
    (a, b) => order.indexOf(a.confidence) - order.indexOf(b.confidence),
  )
  return sorted.slice(0, max)
}
