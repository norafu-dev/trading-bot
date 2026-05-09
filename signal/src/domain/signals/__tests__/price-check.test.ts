import { describe, expect, it, vi } from 'vitest'
import type { Signal } from '../../../../../shared/types.js'
import type { IPriceService, PriceQuote } from '../../../connectors/market/types.js'
import { computePriceCheck } from '../price-check.js'

function makeService(quote: PriceQuote | null): IPriceService {
  return {
    getPrice: vi.fn().mockResolvedValue(quote),
  }
}

const baseQuote: PriceQuote = {
  ccxtSymbol: 'BTC/USDT:USDT',
  base: 'BTC',
  quote: 'USDT',
  price: '76521',
  source: 'binance',
  fetchedAt: '2026-05-02T08:00:00.000Z',
  fromCache: false,
}

function makeSignal(over: Partial<Signal> = {}): Pick<
  Signal,
  'symbol' | 'side' | 'contractType' | 'entry' | 'stopLoss' | 'takeProfits'
> {
  return {
    symbol: 'BTC',
    side: 'long',
    contractType: 'perpetual',
    entry: { type: 'limit', price: '76500' },
    stopLoss: { price: '75500' },
    takeProfits: [{ level: 1, price: '78000' }],
    ...over,
  }
}

describe('computePriceCheck', () => {
  it('returns null when the price service cannot resolve the symbol', async () => {
    const svc = makeService(null)
    expect(await computePriceCheck(makeSignal({ symbol: '???' }), svc)).toBeNull()
  })

  it('attaches currentPrice and entry distance for a fresh long', async () => {
    const r = await computePriceCheck(
      makeSignal({ side: 'long', entry: { type: 'limit', price: '76500' } }),
      makeService(baseQuote),
    )
    expect(r).not.toBeNull()
    expect(r?.currentPrice).toBe('76521')
    expect(r?.source).toBe('binance')
    // entry 76500 vs live 76521 → -0.027% (entry below live)
    expect(Number(r?.entryDistancePercent)).toBeLessThan(0)
    expect(Number(r?.entryDistancePercent)).toBeGreaterThan(-1)
    expect(r?.stale).toBeUndefined()
    expect(r?.unitMismatch).toBeUndefined()
  })

  it('flags a long as stale when the market has run far above entry', async () => {
    const r = await computePriceCheck(
      // long, entry 70000; live 76521 → market already up 9% from entry
      makeSignal({ side: 'long', entry: { type: 'limit', price: '70000' } }),
      makeService(baseQuote),
    )
    expect(r?.stale).toBe(true)
    expect(r?.note).toContain('past entry')
  })

  it('flags a short as stale when the market has dropped far below entry', async () => {
    const r = await computePriceCheck(
      // short, entry 90000 (limit threshold 5%); live 76521 → -15% past entry
      makeSignal({ side: 'short', entry: { type: 'limit', price: '90000' } }),
      makeService(baseQuote),
    )
    expect(r?.stale).toBe(true)
  })

  it('does NOT flag stale when the market is still on the right side of entry', async () => {
    const r = await computePriceCheck(
      // long, entry 78000; live 76521 → entry is still above live, fresh
      makeSignal({ side: 'long', entry: { type: 'limit', price: '78000' } }),
      makeService(baseQuote),
    )
    expect(r?.stale).toBeUndefined()
  })

  // ── Order-type-aware threshold ──────────────────────────────────
  // Market orders fill instantly, so even small drift is bad → 1% threshold.
  // Limit orders wait for pullback, normal entries sit 1-2% past current →
  // wider 5% threshold avoids falsely staling normal pullback setups.

  it('LIMIT long: 4% past entry is NOT stale (within 5% tolerance)', async () => {
    // long, entry 73500; live 76521 → 4.1% drift
    const r = await computePriceCheck(
      makeSignal({ side: 'long', entry: { type: 'limit', price: '73500' } }),
      makeService(baseQuote),
    )
    expect(r?.stale).toBeUndefined()
  })

  it('LIMIT long: 6% past entry IS stale', async () => {
    // long, entry 72000; live 76521 → 6.3% drift
    const r = await computePriceCheck(
      makeSignal({ side: 'long', entry: { type: 'limit', price: '72000' } }),
      makeService(baseQuote),
    )
    expect(r?.stale).toBe(true)
  })

  it('MARKET long: 2% past entry IS stale (1% threshold)', async () => {
    // long market, entry 75000; live 76521 → 2.0% drift
    const r = await computePriceCheck(
      makeSignal({ side: 'long', entry: { type: 'market', price: '75000' } }),
      makeService(baseQuote),
    )
    expect(r?.stale).toBe(true)
  })

  it('MARKET long: 0.5% past entry is NOT stale', async () => {
    // long market, entry 76140; live 76521 → 0.5% drift
    const r = await computePriceCheck(
      makeSignal({ side: 'long', entry: { type: 'market', price: '76140' } }),
      makeService(baseQuote),
    )
    expect(r?.stale).toBeUndefined()
  })

  it('flags unit mismatch when entry is ~10000× off from live', async () => {
    // KOL writes 7.66 meaning 76600 — entry 7.66, live 76521, ratio ~10000
    const r = await computePriceCheck(
      makeSignal({ side: 'long', entry: { type: 'limit', price: '7.66' } }),
      makeService(baseQuote),
    )
    expect(r?.unitMismatch).toBe(true)
  })

  it('flags unit mismatch when SL/TP is wildly off even if entry is fine', async () => {
    const r = await computePriceCheck(
      makeSignal({
        entry: { type: 'limit', price: '76500' },
        stopLoss: { price: '0.755' },  // off by ~100000×
      }),
      makeService(baseQuote),
    )
    expect(r?.unitMismatch).toBe(true)
  })

  it('uses entry range midpoint when no single price is given', async () => {
    const r = await computePriceCheck(
      makeSignal({
        entry: {
          type: 'limit',
          priceRangeLow: '76400',
          priceRangeHigh: '76600',  // midpoint = 76500
        },
      }),
      makeService(baseQuote),
    )
    // midpoint 76500 vs live 76521 → ~ -0.027%
    expect(r?.entryDistancePercent).toBeDefined()
    expect(Math.abs(Number(r?.entryDistancePercent))).toBeLessThan(0.5)
  })

  it('omits entryDistancePercent when entry is absent', async () => {
    const r = await computePriceCheck(
      makeSignal({ entry: undefined }),
      makeService(baseQuote),
    )
    expect(r?.entryDistancePercent).toBeUndefined()
    expect(r?.stale).toBeUndefined()
    expect(r?.currentPrice).toBe('76521')
  })

  it('returns null when live price is malformed', async () => {
    const bad: PriceQuote = { ...baseQuote, price: '0' }
    expect(await computePriceCheck(makeSignal(), makeService(bad))).toBeNull()
  })
})
