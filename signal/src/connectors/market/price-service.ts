import ccxt from 'ccxt'
import { logger } from '../../core/logger.js'
import { normalizeSymbol } from './symbol-normalize.js'
import type { IPriceService, PriceQuote } from './types.js'

/**
 * Default cache TTL — short enough that a stop-loss-at-current-price decision
 * isn't using a 5-minute-old quote, long enough that bursty inject / retest
 * cycles don't hammer the public ticker endpoint.
 */
const DEFAULT_CACHE_TTL_MS = 30_000

/**
 * CCXT-backed price service. Uses the public `fetchTicker` endpoint —
 * **no authentication needed**, so we can run this on any deploy regardless
 * of whether the user has an API key for the exchange.
 *
 * Falls through gracefully on error: a failed `fetchTicker` returns null
 * instead of throwing, so a downstream price-check that can't resolve a
 * symbol simply skips the unit-anomaly / staleness checks rather than
 * blocking the whole signal.
 */
export class CcxtPriceService implements IPriceService {
  private readonly exchange: { fetchTicker: (symbol: string) => Promise<{ last?: number; close?: number; info?: unknown }> }
  private readonly source: string
  private readonly cacheTtlMs: number
  private readonly cache = new Map<string, { quote: PriceQuote; expiresAt: number }>()

  constructor(opts: {
    exchangeName?: string
    cacheTtlMs?: number
    /**
     * Test-seam: inject a pre-built CCXT instance instead of constructing one.
     * Production callers should use `exchangeName` only.
     */
    instance?: { fetchTicker: (symbol: string) => Promise<{ last?: number; close?: number; info?: unknown }> }
  } = {}) {
    this.source = opts.exchangeName ?? 'binance'
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS

    if (opts.instance) {
      this.exchange = opts.instance
    } else {
      const exchanges = ccxt as unknown as Record<
        string,
        new (params?: Record<string, unknown>) => { fetchTicker: (symbol: string) => Promise<{ last?: number; close?: number; info?: unknown }> }
      >
      const ExchangeClass = exchanges[this.source]
      if (!ExchangeClass) {
        throw new Error(`PriceService: unknown exchange "${this.source}"`)
      }
      this.exchange = new ExchangeClass({ enableRateLimit: true })
    }
  }

  async getPrice(
    rawSymbol: string,
    contractType?: 'spot' | 'perpetual',
  ): Promise<PriceQuote | null> {
    const normalized = normalizeSymbol(rawSymbol, { contractType })
    if (!normalized) return null

    const cacheKey = normalized.ccxtSymbol
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.quote, fromCache: true }
    }

    let ticker
    try {
      ticker = await this.exchange.fetchTicker(normalized.ccxtSymbol)
    } catch (err) {
      // Common failures: symbol not listed on this exchange (BadSymbol),
      // network timeout, rate-limit. Each one is acceptable to surface as
      // null — the price-check just skips. Log at debug so the user can
      // diagnose if they expect a price but never see one.
      logger.debug(
        {
          err: err instanceof Error ? err.message : String(err),
          rawSymbol,
          ccxtSymbol: normalized.ccxtSymbol,
          source: this.source,
        },
        'PriceService: fetchTicker failed, returning null',
      )
      return null
    }

    const last = ticker.last ?? ticker.close
    if (typeof last !== 'number' || !Number.isFinite(last) || last <= 0) {
      return null
    }

    const quote: PriceQuote = {
      ccxtSymbol: normalized.ccxtSymbol,
      base: normalized.base,
      quote: normalized.quote,
      price: String(last),
      source: this.source,
      fetchedAt: new Date().toISOString(),
      fromCache: false,
    }
    this.cache.set(cacheKey, {
      quote: { ...quote, fromCache: false },
      expiresAt: Date.now() + this.cacheTtlMs,
    })
    return quote
  }
}
