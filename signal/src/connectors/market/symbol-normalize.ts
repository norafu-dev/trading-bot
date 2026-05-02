/**
 * Symbol normalisation for price-service lookups.
 *
 * KOL messages quote symbols in many shapes — bare ("BTC"), Chinese
 * ("比特币"), CCXT-style ("BTC/USDT"), exchange-style ("BTCUSDT"), or
 * decorated ("$HYPE"). The price service needs a single canonical form
 * so the cache hits reliably and CCXT's `fetchTicker` finds the market.
 *
 * Output shape:
 *   spot       → "BASE/QUOTE"           e.g. "BTC/USDT"
 *   perpetual  → "BASE/QUOTE:QUOTE"     e.g. "BTC/USDT:USDT"
 *
 * `null` is returned when we cannot identify a base symbol — the caller
 * must treat that as "no price available" and skip price-check entirely.
 */

const CHINESE_TO_BASE: Record<string, string> = {
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

const DEFAULT_QUOTE = 'USDT'

export interface NormalizeResult {
  /** Base asset, uppercase: "BTC". */
  base: string
  /** Quote asset, uppercase: "USDT". */
  quote: string
  /** "BTC/USDT" for spot, "BTC/USDT:USDT" for perpetual. */
  ccxtSymbol: string
}

export function normalizeSymbol(
  raw: string,
  opts: { contractType?: 'spot' | 'perpetual'; defaultQuote?: string } = {},
): NormalizeResult | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  const contractType = opts.contractType ?? 'perpetual'
  const fallbackQuote = (opts.defaultQuote ?? DEFAULT_QUOTE).toUpperCase()

  // 1. Already CCXT shape: "BTC/USDT" or "BTC/USDT:USDT"
  const ccxtMatch = trimmed.match(/^([A-Za-z0-9]+)\/([A-Za-z0-9]+)(?::([A-Za-z0-9]+))?$/)
  if (ccxtMatch) {
    const base = ccxtMatch[1].toUpperCase()
    const quote = ccxtMatch[2].toUpperCase()
    const settle = ccxtMatch[3]?.toUpperCase()
    if (settle) {
      return { base, quote, ccxtSymbol: `${base}/${quote}:${settle}` }
    }
    return {
      base,
      quote,
      ccxtSymbol:
        contractType === 'perpetual' ? `${base}/${quote}:${quote}` : `${base}/${quote}`,
    }
  }

  // 2. Chinese name
  const cn = CHINESE_TO_BASE[trimmed]
  if (cn) {
    return buildResult(cn, fallbackQuote, contractType)
  }

  // 3. Strip decorations: "$BTC", "#BTC", whitespace
  const stripped = trimmed.replace(/^[$#]/, '').toUpperCase()

  // 4. Exchange-flat shape: "BTCUSDT", "ETHUSDT"
  const flatMatch = stripped.match(/^([A-Z0-9]+?)(USDT|USDC|USD|BTC|ETH|BNB)$/)
  if (flatMatch && flatMatch[1].length >= 2) {
    const base = flatMatch[1]
    const quote = flatMatch[2]
    return buildResult(base, quote, contractType)
  }

  // 5. Bare base symbol: "BTC", "HYPE", "GENIUS"
  if (/^[A-Z0-9]{1,15}$/.test(stripped)) {
    return buildResult(stripped, fallbackQuote, contractType)
  }

  return null
}

function buildResult(
  base: string,
  quote: string,
  contractType: 'spot' | 'perpetual',
): NormalizeResult {
  return {
    base,
    quote,
    ccxtSymbol:
      contractType === 'perpetual' ? `${base}/${quote}:${quote}` : `${base}/${quote}`,
  }
}
