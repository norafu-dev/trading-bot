import { describe, expect, it } from 'vitest'
import { normalizeSymbol } from '../symbol-normalize.js'

describe('normalizeSymbol', () => {
  it('returns null for empty / whitespace input', () => {
    expect(normalizeSymbol('')).toBeNull()
    expect(normalizeSymbol('   ')).toBeNull()
  })

  it('handles already-CCXT-shaped input', () => {
    const r = normalizeSymbol('BTC/USDT', { contractType: 'spot' })
    expect(r).toEqual({ base: 'BTC', quote: 'USDT', ccxtSymbol: 'BTC/USDT' })
  })

  it('adds settle suffix for perpetual when input is spot-shape', () => {
    expect(normalizeSymbol('BTC/USDT', { contractType: 'perpetual' })?.ccxtSymbol).toBe('BTC/USDT:USDT')
  })

  it('preserves explicit settle when input already includes one', () => {
    const r = normalizeSymbol('BTC/USDT:USDT', { contractType: 'perpetual' })
    expect(r?.ccxtSymbol).toBe('BTC/USDT:USDT')
  })

  it('maps Chinese names', () => {
    expect(normalizeSymbol('比特币')?.base).toBe('BTC')
    expect(normalizeSymbol('以太坊')?.base).toBe('ETH')
    expect(normalizeSymbol('狗狗币')?.base).toBe('DOGE')
  })

  it('strips $ / # decorations', () => {
    expect(normalizeSymbol('$HYPE')?.base).toBe('HYPE')
    expect(normalizeSymbol('#SOL')?.base).toBe('SOL')
  })

  it('splits exchange-flat shape (BTCUSDT → BTC/USDT)', () => {
    const r = normalizeSymbol('BTCUSDT', { contractType: 'spot' })
    expect(r).toEqual({ base: 'BTC', quote: 'USDT', ccxtSymbol: 'BTC/USDT' })
  })

  it('uppercases lower-case bare symbols', () => {
    expect(normalizeSymbol('btc')?.base).toBe('BTC')
  })

  it('defaults to USDT quote for bare symbols', () => {
    const r = normalizeSymbol('GENIUS', { contractType: 'spot' })
    expect(r).toEqual({ base: 'GENIUS', quote: 'USDT', ccxtSymbol: 'GENIUS/USDT' })
  })

  it('honours custom default quote', () => {
    expect(normalizeSymbol('BTC', { defaultQuote: 'USDC', contractType: 'spot' })?.ccxtSymbol).toBe('BTC/USDC')
  })

  it('rejects garbled input', () => {
    expect(normalizeSymbol('???')).toBeNull()
    expect(normalizeSymbol('  -- ')).toBeNull()
  })

  it('handles long alphanumeric tickers (e.g. ASTEROIOD)', () => {
    expect(normalizeSymbol('ASTEROIOD')?.base).toBe('ASTEROIOD')
  })

  // ── TradingView-style "BASE / QUOTE" (spaced slash, often OCR'd from
  //    chart headers like "ZRO / TetherUS"). Must collapse to canonical CCXT.
  it('handles TradingView-style "ZRO / TetherUS"', () => {
    const r = normalizeSymbol('ZRO / TetherUS', { contractType: 'perpetual' })
    expect(r).toEqual({ base: 'ZRO', quote: 'USDT', ccxtSymbol: 'ZRO/USDT:USDT' })
  })

  it('handles "BTC / Tether USD" with space inside the alias', () => {
    const r = normalizeSymbol('BTC / Tether USD', { contractType: 'perpetual' })
    expect(r?.ccxtSymbol).toBe('BTC/USDT:USDT')
  })

  it('handles TradingView spot form "ETH / USD"', () => {
    const r = normalizeSymbol('ETH / USD', { contractType: 'spot' })
    expect(r?.ccxtSymbol).toBe('ETH/USD')
    expect(r?.quote).toBe('USD')
  })

  it('handles TradingView form with USDT quote unchanged', () => {
    const r = normalizeSymbol('SOL / USDT', { contractType: 'perpetual' })
    expect(r?.ccxtSymbol).toBe('SOL/USDT:USDT')
  })

  it('still treats compact "BTC/USDT" (no spaces) as CCXT shape, not TradingView', () => {
    // Regression guard: we MUST keep step 2 reachable. The TradingView rule
    // is gated on having whitespace; without spaces this is a CCXT input.
    const r = normalizeSymbol('BTC/USDT', { contractType: 'perpetual' })
    expect(r?.ccxtSymbol).toBe('BTC/USDT:USDT')
  })
})
