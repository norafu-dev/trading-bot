/**
 * A single quote returned by the price service.
 * `price` is a Decimal-string to match the rest of the pipeline's money discipline.
 */
export interface PriceQuote {
  /** CCXT-canonical symbol that was queried, e.g. "BTC/USDT:USDT". */
  ccxtSymbol: string
  /** Base asset extracted by normalisation, e.g. "BTC". */
  base: string
  /** Quote asset, e.g. "USDT". */
  quote: string
  /** Last-traded price as a Decimal string. */
  price: string
  /** Exchange name, e.g. "binance". */
  source: string
  /** ISO-8601 timestamp the quote was fetched (or last refreshed in cache). */
  fetchedAt: string
  /** True if served from in-memory cache rather than a fresh network call. */
  fromCache: boolean
}

/**
 * Service abstraction for spot/perp price lookups.
 *
 * `null` is the explicit "we couldn't resolve this symbol" answer — distinct
 * from `throw`, which signals an actual transport / exchange error. Callers
 * use null to mean "skip price-check, this signal has no checkable symbol".
 */
export interface IPriceService {
  /**
   * Look up the last-trade price for `rawSymbol`. The string is normalised
   * via `normalizeSymbol()` first; "BTC", "比特币", and "BTC/USDT" all collapse
   * to the same cache key for `contractType: 'perpetual'`.
   */
  getPrice(
    rawSymbol: string,
    contractType?: 'spot' | 'perpetual',
  ): Promise<PriceQuote | null>
}
