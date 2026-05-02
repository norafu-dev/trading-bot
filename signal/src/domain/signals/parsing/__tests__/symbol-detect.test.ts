import { describe, expect, it } from 'vitest'
import { detectSymbols } from '../common/symbol-detect.js'

describe('detectSymbols', () => {
  it('returns empty array for empty input', () => {
    expect(detectSymbols('')).toEqual([])
    expect(detectSymbols('   ')).toEqual([])
  })

  it('detects Chinese names with high confidence', () => {
    const r = detectSymbols('比特币 方向：做多 入场：7.67附近')
    expect(r[0]).toEqual({ symbol: 'BTC', confidence: 'high', source: 'chinese' })
  })

  it('detects bot Discord-link format with high confidence', () => {
    const text = '**<:Long:1397324271419785346>  [BTC](https://discord.com/channels/.../1494534655607701595)** | **入场:** 0.09680'
    const r = detectSymbols(text)
    expect(r[0]?.symbol).toBe('BTC')
    expect(r[0]?.source).toBe('discord-link')
  })

  it('handles bold-wrapped link symbol [**BTC**](url)', () => {
    const r = detectSymbols('[**ETH**](https://discord.com/channels/x/y/z): 止损平仓')
    expect(r[0]?.symbol).toBe('ETH')
    expect(r[0]?.source).toBe('discord-link')
  })

  it('detects CCXT shape (BTC/USDT)', () => {
    const r = detectSymbols('Going long ETH/USDT here')
    expect(r[0]).toMatchObject({ symbol: 'ETH', source: 'ccxt-shape', confidence: 'high' })
  })

  it('detects exchange-flat shape (BTCUSDT)', () => {
    const r = detectSymbols('SOLUSDT short')
    expect(r[0]?.symbol).toBe('SOL')
  })

  it('detects bare $-prefixed tokens with medium confidence', () => {
    const r = detectSymbols('Long $HYPE — entry 25.5')
    expect(r[0]?.symbol).toBe('HYPE')
    expect(r[0]?.confidence).toBe('medium')
  })

  it('detects bare ALL-CAPS tokens with low confidence', () => {
    const r = detectSymbols('GENIUS long here')
    expect(r.find((c) => c.symbol === 'GENIUS')?.confidence).toBe('low')
  })

  it('filters out trading-vocabulary stopwords', () => {
    const r = detectSymbols('LONG TP1 SL ENTRY MARKET')
    expect(r).toHaveLength(0)
  })

  it('filters out USD/USDT/USDC tokens', () => {
    const r = detectSymbols('USDT inflow USDC outflow')
    expect(r).toHaveLength(0)
  })

  it('does not double-count when the same symbol appears in multiple shapes', () => {
    const r = detectSymbols('BTC/USDT 多单 — 比特币入场 76500')
    const btcCount = r.filter((c) => c.symbol === 'BTC').length
    expect(btcCount).toBe(1)
    // Chinese match wins (registered first)
    expect(r[0]?.symbol).toBe('BTC')
  })

  it('orders results by confidence (high before low)', () => {
    const r = detectSymbols('GENIUS spot · 比特币 现货 · ETH/USDT')
    const confidences = r.map((c) => c.confidence)
    // sort should not put low before high
    const orderRank: Record<string, number> = { high: 0, medium: 1, low: 2 }
    for (let i = 1; i < confidences.length; i++) {
      expect(orderRank[confidences[i - 1]]).toBeLessThanOrEqual(orderRank[confidences[i]])
    }
  })

  it('respects max parameter', () => {
    const r = detectSymbols('BTC ETH SOL DOGE XRP $AVAX HYPE GENIUS', 2)
    expect(r).toHaveLength(2)
  })

  it('finds the BTC symbol from Shuqin\'s real-world signal', () => {
    const text = `<@&1459949497621942353>
比特币
方向：做多
入场：7.67附近入场
信心度：中
倍数：10倍
仓位：10%
止盈：点位1：7.77附近 点位2：7.84附近
止损：小幅跌破7.58一点。`
    const r = detectSymbols(text)
    expect(r[0]?.symbol).toBe('BTC')
    expect(r[0]?.confidence).toBe('high')
  })
})
