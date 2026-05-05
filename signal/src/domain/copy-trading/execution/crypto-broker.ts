/**
 * Thin wrapper over a ccxt Exchange — exposes only the calls the
 * order-executor needs and gives them a typed shape, so the executor
 * can be tested with a fake without pulling all of ccxt.
 *
 * Intentionally NOT an IBroker abstraction (à la OpenAlice). We have
 * one exchange family (crypto perps via ccxt); the abstraction would
 * be ceremony without payoff. If a second broker family ever shows up
 * (Alpaca / IBKR), introduce the abstraction then.
 *
 * What this layer DOES NOT do:
 *   - decide quantity from notional (caller does that with fetchTicker)
 *   - decide whether to set leverage (caller does that based on
 *     ExecutionConfig.setLeverage)
 *   - retry network errors (caller's job, classified via error-classifier)
 *   - emit events / persist anything (executor's job)
 */

import type { Order as CcxtOrder, Ticker } from 'ccxt'
import type { CcxtExchange } from '../../trading/ccxt-pool.js'

export type OrderSide = 'buy' | 'sell'
export type OrderType = 'market' | 'limit'

export interface PlaceOrderInput {
  symbol: string
  side: OrderSide
  type: OrderType
  /** Base-currency amount (e.g. BTC). Caller pre-converts from notional. */
  amount: number
  /** Required for limit; ignored for market. */
  price?: number
  /**
   * Pass-through to ccxt.createOrder({ ...params }). Used for:
   *   - { stopLossPrice, takeProfitPrice }       unified SL/TP
   *   - { reduceOnly: true }                     close-position orders
   *   - exchange-specific overrides (rare)
   */
  params?: Record<string, unknown>
}

export interface ICryptoBroker {
  fetchTicker(symbol: string): Promise<Ticker>
  setLeverage(leverage: number, symbol: string, marginMode?: 'isolated' | 'cross'): Promise<void>
  placeOrder(input: PlaceOrderInput): Promise<CcxtOrder>
  cancelOrder(orderId: string, symbol: string): Promise<void>
}

export class CcxtCryptoBroker implements ICryptoBroker {
  constructor(private readonly exchange: CcxtExchange) {}

  async fetchTicker(symbol: string): Promise<Ticker> {
    return this.exchange.fetchTicker(symbol)
  }

  async setLeverage(
    leverage: number,
    symbol: string,
    marginMode?: 'isolated' | 'cross',
  ): Promise<void> {
    // Set margin mode FIRST (Bitget rejects setLeverage if mode mismatch).
    // Many exchanges throw "no change" when the mode is already correct;
    // those errors are safe to swallow here. Real auth / param errors
    // will resurface on createOrder anyway.
    if (marginMode) {
      try {
        await this.exchange.setMarginMode(marginMode, symbol)
      } catch (err) {
        if (!isNoChangeError(err)) throw err
      }
    }
    try {
      await this.exchange.setLeverage(leverage, symbol)
    } catch (err) {
      if (!isNoChangeError(err)) throw err
    }
  }

  async placeOrder(input: PlaceOrderInput): Promise<CcxtOrder> {
    const { symbol, type, side, amount, price, params } = input
    return this.exchange.createOrder(symbol, type, side, amount, price, params ?? {})
  }

  async cancelOrder(orderId: string, symbol: string): Promise<void> {
    await this.exchange.cancelOrder(orderId, symbol)
  }
}

/**
 * "no change" detection — exchanges return errors like:
 *   Bitget: "leverage not modified"
 *   Binance: "margin mode is the same"
 * We treat these as success because the desired end state is reached.
 */
function isNoChangeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
  return (
    msg.includes('not modified') ||
    msg.includes('not changed') ||
    msg.includes('is the same') ||
    msg.includes('no need to change')
  )
}
