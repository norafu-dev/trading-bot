import { Hono } from 'hono'
import type { IPriceService } from '../connectors/market/types.js'

/**
 * `GET /api/market/price?symbol=BTC&contractType=perpetual`
 *
 * Returns a `PriceQuote` or `{ resolved: false }` when normalisation /
 * exchange lookup fails. Powers the dashboard's live-price widget and
 * gives operators a quick sanity check that the underlying CCXT path is
 * actually reachable.
 */
export function createMarketRoutes(priceService: IPriceService) {
  return new Hono().get('/price', async (c) => {
    const symbol = c.req.query('symbol')
    const contractType = c.req.query('contractType') as 'spot' | 'perpetual' | undefined
    if (!symbol) {
      return c.json({ error: 'Missing query param: symbol' }, 400)
    }
    const quote = await priceService.getPrice(symbol, contractType)
    if (!quote) {
      return c.json({ resolved: false, symbol, contractType: contractType ?? 'perpetual' })
    }
    return c.json({ resolved: true, ...quote })
  })
}
