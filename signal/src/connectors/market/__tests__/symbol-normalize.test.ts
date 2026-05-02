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
})
