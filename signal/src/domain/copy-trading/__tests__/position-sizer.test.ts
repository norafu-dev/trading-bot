import { describe, expect, it } from 'vitest'
import type { RiskConfig } from '../../../../../shared/types.js'
import { PositionSizer } from '../position-sizer.js'
import { makeAccount, makeKol, makeSignal } from './helpers.js'

const DEFAULT_RISK: RiskConfig = {
  baseRiskPercent: 1,
  maxOperationSizePercent: 5,
  symbolWhitelist: [],
  cooldownMinutes: 5,
  maxTakeProfits: 10,        // tests pass 0..3 TPs, never need truncation
  tpDistribution: 'even',
}

describe('PositionSizer', () => {
  const sizer = new PositionSizer()

  it('produces a placeOrder operation in pending status', () => {
    const op = sizer.size({
      signal: makeSignal(),
      kol: makeKol(),
      account: makeAccount(),
      riskConfig: DEFAULT_RISK,
    })
    expect(op.status).toBe('pending')
    expect(op.signalId).toBe('sig-1')
    expect(op.kolId).toBe('kol-A')
    expect(op.spec.action).toBe('placeOrder')
  })

  it('sizes 1% of equity baseline (10000 × 1% × 1 × 0.9 confidence)', () => {
    const op = sizer.size({
      signal: makeSignal({ confidence: 0.9 }),
      kol: makeKol({ riskMultiplier: 1 }),
      account: makeAccount({ netLiquidation: '10000' }),
      riskConfig: DEFAULT_RISK,
    })
    if (op.spec.action !== 'placeOrder') throw new Error('expected placeOrder')
    // 10000 * 1% * 1 * 0.9 = 90
    expect(op.spec.size).toEqual({ unit: 'absolute', value: '90.00' })
    expect(op.sizingContext?.equity).toBe('10000.00')
    expect(op.sizingContext?.effectiveRiskPercent).toBe('0.9000')
  })

  it("scales by KOL's riskMultiplier", () => {
    const op = sizer.size({
      signal: makeSignal({ confidence: 1 }),
      kol: makeKol({ riskMultiplier: 1.5 }),
      account: makeAccount({ netLiquidation: '10000' }),
      riskConfig: DEFAULT_RISK,
    })
    if (op.spec.action !== 'placeOrder') throw new Error()
    // 10000 * 1% * 1.5 * 1 = 150
    expect(op.spec.size.value).toBe('150.00')
  })

  it('caps at maxOperationSizePercent', () => {
    const op = sizer.size({
      // KOL riskMultiplier 10 + confidence 1 + base 1% = 10% raw, capped at 5%
      signal: makeSignal({ confidence: 1 }),
      kol: makeKol({ riskMultiplier: 10 }),
      account: makeAccount({ netLiquidation: '10000' }),
      riskConfig: { ...DEFAULT_RISK, maxOperationSizePercent: 5 },
    })
    if (op.spec.action !== 'placeOrder') throw new Error()
    expect(op.spec.size.value).toBe('500.00')
    expect(op.sizingContext?.effectiveRiskPercent).toBe('5.0000')
  })

  it('preserves entry / stopLoss / takeProfits / leverage from signal', () => {
    const op = sizer.size({
      signal: makeSignal({
        entry: { type: 'limit', price: '76500' },
        stopLoss: { price: '75500' },
        takeProfits: [{ level: 1, price: '78000' }, { level: 2, price: '80000' }],
        leverage: 20,
      }),
      kol: makeKol(),
      account: makeAccount(),
      riskConfig: DEFAULT_RISK,
    })
    if (op.spec.action !== 'placeOrder') throw new Error()
    expect(op.spec.orderType).toBe('limit')
    expect(op.spec.price).toBe('76500')
    expect(op.spec.stopLoss).toEqual({ price: '75500' })
    expect(op.spec.takeProfits).toHaveLength(2)
    expect(op.spec.leverage).toBe(20)
  })

  it('defaults orderType to market when entry has no type', () => {
    const op = sizer.size({
      signal: makeSignal({ entry: undefined }),
      kol: makeKol(),
      account: makeAccount(),
      riskConfig: DEFAULT_RISK,
    })
    if (op.spec.action !== 'placeOrder') throw new Error()
    expect(op.spec.orderType).toBe('market')
    expect(op.spec.price).toBeUndefined()
  })

  it('handles zero confidence — produces zero-size pending op (guards will reject)', () => {
    const op = sizer.size({
      signal: makeSignal({ confidence: 0 }),
      kol: makeKol(),
      account: makeAccount(),
      riskConfig: DEFAULT_RISK,
    })
    if (op.spec.action !== 'placeOrder') throw new Error()
    expect(Number(op.spec.size.value)).toBe(0)
  })

  it('uses signal.kolId for the operation kolId, not signal.bundleId', () => {
    const op = sizer.size({
      signal: makeSignal({ kolId: 'kol-X' }),
      kol: makeKol({ id: 'kol-X' }),
      account: makeAccount(),
      riskConfig: DEFAULT_RISK,
    })
    expect(op.kolId).toBe('kol-X')
  })

  it('starts with empty guardResults array', () => {
    const op = sizer.size({
      signal: makeSignal(),
      kol: makeKol(),
      account: makeAccount(),
      riskConfig: DEFAULT_RISK,
    })
    expect(op.guardResults).toEqual([])
  })

  it('normalises a Chinese symbol to the CCXT shape', () => {
    const op = sizer.size({
      signal: makeSignal({ symbol: '比特币', contractType: 'perpetual' }),
      kol: makeKol(),
      account: makeAccount(),
      riskConfig: DEFAULT_RISK,
    })
    if (op.spec.action !== 'placeOrder') throw new Error()
    expect(op.spec.symbol).toBe('BTC/USDT:USDT')
  })

  it('normalises a $-decorated bare symbol', () => {
    const op = sizer.size({
      signal: makeSignal({ symbol: '$HYPE', contractType: 'perpetual' }),
      kol: makeKol(),
      account: makeAccount(),
      riskConfig: DEFAULT_RISK,
    })
    if (op.spec.action !== 'placeOrder') throw new Error()
    expect(op.spec.symbol).toBe('HYPE/USDT:USDT')
  })

  it('uses spot suffix when signal.contractType is spot', () => {
    const op = sizer.size({
      signal: makeSignal({ symbol: 'BTC', contractType: 'spot' }),
      kol: makeKol(),
      account: makeAccount(),
      riskConfig: DEFAULT_RISK,
    })
    if (op.spec.action !== 'placeOrder') throw new Error()
    expect(op.spec.symbol).toBe('BTC/USDT')
  })

  it('keeps the raw symbol when normalisation fails', () => {
    const op = sizer.size({
      signal: makeSignal({ symbol: '???' }),
      kol: makeKol(),
      account: makeAccount(),
      riskConfig: DEFAULT_RISK,
    })
    if (op.spec.action !== 'placeOrder') throw new Error()
    // Falls through to original — downstream broker error will surface
    expect(op.spec.symbol).toBe('???')
  })

  it('respects KOL.defaultSymbolQuote (e.g. USDC)', () => {
    const op = sizer.size({
      signal: makeSignal({ symbol: 'BTC', contractType: 'spot' }),
      kol: makeKol({ defaultSymbolQuote: 'USDC' }),
      account: makeAccount(),
      riskConfig: DEFAULT_RISK,
    })
    if (op.spec.action !== 'placeOrder') throw new Error()
    expect(op.spec.symbol).toBe('BTC/USDC')
  })

  // ── maxTakeProfits truncation ──────────────────────────────────────
  // KOLs sometimes sprinkle 5-7 TPs the last few of which rarely hit;
  // operator can cap how many we actually execute via riskConfig.
  it('truncates take-profits to riskConfig.maxTakeProfits', () => {
    const op = sizer.size({
      signal: makeSignal({
        takeProfits: [
          { level: 1, price: '50000' },
          { level: 2, price: '52000' },
          { level: 3, price: '54000' },
          { level: 4, price: '56000' },
          { level: 5, price: '58000' },
        ],
      }),
      kol: makeKol(),
      account: makeAccount(),
      riskConfig: { ...DEFAULT_RISK, maxTakeProfits: 3 },
    })
    if (op.spec.action !== 'placeOrder') throw new Error()
    expect(op.spec.takeProfits).toHaveLength(3)
    expect(op.spec.takeProfits!.map((tp) => tp.level)).toEqual([1, 2, 3])
  })

  it('keeps fewer TPs unchanged when below the cap', () => {
    const op = sizer.size({
      signal: makeSignal({
        takeProfits: [
          { level: 1, price: '50000' },
          { level: 2, price: '52000' },
        ],
      }),
      kol: makeKol(),
      account: makeAccount(),
      riskConfig: { ...DEFAULT_RISK, maxTakeProfits: 5 },
    })
    if (op.spec.action !== 'placeOrder') throw new Error()
    expect(op.spec.takeProfits).toHaveLength(2)
  })

  // ── Entry-range collapse ───────────────────────────────────────────
  // KOLs often write "Entry: 0.10 - 0.1064" → LLM produces a range with
  // priceRangeLow / priceRangeHigh and no `price`. Without collapse, the
  // op.spec.price stays undefined → broker rejects the limit order.
  describe('entry range collapse', () => {
    it('long: takes priceRangeLow (cheapest fill, deepest pullback)', () => {
      const op = sizer.size({
        signal: makeSignal({
          side: 'long',
          entry: { type: 'limit', priceRangeLow: '0.10', priceRangeHigh: '0.1064' },
        }),
        kol: makeKol(),
        account: makeAccount(),
        riskConfig: DEFAULT_RISK,
      })
      if (op.spec.action !== 'placeOrder') throw new Error()
      expect(op.spec.orderType).toBe('limit')
      expect(op.spec.price).toBe('0.10')
    })

    it('short: takes priceRangeHigh (most expensive fill, highest rally)', () => {
      const op = sizer.size({
        signal: makeSignal({
          side: 'short',
          entry: { type: 'limit', priceRangeLow: '76500', priceRangeHigh: '77200' },
        }),
        kol: makeKol(),
        account: makeAccount(),
        riskConfig: DEFAULT_RISK,
      })
      if (op.spec.action !== 'placeOrder') throw new Error()
      expect(op.spec.price).toBe('77200')
    })

    it('explicit price takes precedence over range', () => {
      const op = sizer.size({
        signal: makeSignal({
          side: 'long',
          entry: { type: 'limit', price: '0.105', priceRangeLow: '0.10', priceRangeHigh: '0.11' },
        }),
        kol: makeKol(),
        account: makeAccount(),
        riskConfig: DEFAULT_RISK,
      })
      if (op.spec.action !== 'placeOrder') throw new Error()
      expect(op.spec.price).toBe('0.105')
    })

    it('falls back to single-edge range when only one is given', () => {
      const op = sizer.size({
        signal: makeSignal({
          side: 'long',
          entry: { type: 'limit', priceRangeHigh: '0.1064' },  // low missing
        }),
        kol: makeKol(),
        account: makeAccount(),
        riskConfig: DEFAULT_RISK,
      })
      if (op.spec.action !== 'placeOrder') throw new Error()
      expect(op.spec.price).toBe('0.1064')
    })

    it('omits price when entry has neither price nor range (market entries)', () => {
      const op = sizer.size({
        signal: makeSignal({
          side: 'long',
          entry: { type: 'market' },
        }),
        kol: makeKol(),
        account: makeAccount(),
        riskConfig: DEFAULT_RISK,
      })
      if (op.spec.action !== 'placeOrder') throw new Error()
      expect(op.spec.orderType).toBe('market')
      expect(op.spec.price).toBeUndefined()
    })
  })

  // ── Stop-loss extraction from conditional wording ──────────────────
  // KOLs frequently write SL as a candle-close condition like
  // "4H close under 1.418 for stops" — LLM captures it as
  // stopLoss.condition with no price. Without a fallback, the operation
  // would carry no SL and the broker would open an unprotected position.
  // Sizer mines the price out of the condition text; the original
  // wording is forwarded to op.spec.stopLoss.condition for UI display.
  describe('stop-loss extraction', () => {
    it('explicit price passes through, no condition attached', () => {
      const op = sizer.size({
        signal: makeSignal({ stopLoss: { price: '75500' } }),
        kol: makeKol(),
        account: makeAccount(),
        riskConfig: DEFAULT_RISK,
      })
      if (op.spec.action !== 'placeOrder') throw new Error()
      expect(op.spec.stopLoss).toEqual({ price: '75500' })
    })

    it('explicit price wins over condition when both are given', () => {
      const op = sizer.size({
        signal: makeSignal({
          stopLoss: { price: '75500', condition: '4H close under 75000' },
        }),
        kol: makeKol(),
        account: makeAccount(),
        riskConfig: DEFAULT_RISK,
      })
      if (op.spec.action !== 'placeOrder') throw new Error()
      expect(op.spec.stopLoss).toEqual({
        price: '75500',
        condition: '4H close under 75000',
      })
    })

    it('mines decimal price out of "4H close under 1.418" (Trader Neil pattern)', () => {
      const op = sizer.size({
        signal: makeSignal({
          stopLoss: { condition: '4H close under 1.418 for stops' },
        }),
        kol: makeKol(),
        account: makeAccount(),
        riskConfig: DEFAULT_RISK,
      })
      if (op.spec.action !== 'placeOrder') throw new Error()
      expect(op.spec.stopLoss?.price).toBe('1.418')
      expect(op.spec.stopLoss?.condition).toBe('4H close under 1.418 for stops')
    })

    it('mines 3+ digit integer price out of "close below 76500"', () => {
      const op = sizer.size({
        signal: makeSignal({
          stopLoss: { condition: '1H close below 76500' },
        }),
        kol: makeKol(),
        account: makeAccount(),
        riskConfig: DEFAULT_RISK,
      })
      if (op.spec.action !== 'placeOrder') throw new Error()
      expect(op.spec.stopLoss?.price).toBe('76500')
    })

    it('ignores timeframe markers like "1H" / "4H" — picks the price, not the timeframe', () => {
      // Regex requires either a decimal or 3+ digit integer, so "4" in
      // "4H" can't be mistaken for a price.
      const op = sizer.size({
        signal: makeSignal({
          stopLoss: { condition: '4H close under 0.0256' },
        }),
        kol: makeKol(),
        account: makeAccount(),
        riskConfig: DEFAULT_RISK,
      })
      if (op.spec.action !== 'placeOrder') throw new Error()
      expect(op.spec.stopLoss?.price).toBe('0.0256')
    })

    it('omits SL when condition has no extractable price (rare)', () => {
      const op = sizer.size({
        signal: makeSignal({
          stopLoss: { condition: 'stop if macro news triggers risk-off' },
        }),
        kol: makeKol(),
        account: makeAccount(),
        riskConfig: DEFAULT_RISK,
      })
      if (op.spec.action !== 'placeOrder') throw new Error()
      expect(op.spec.stopLoss).toBeUndefined()
    })

    it('omits SL when signal has no stopLoss at all', () => {
      const op = sizer.size({
        signal: makeSignal({ stopLoss: undefined }),
        kol: makeKol(),
        account: makeAccount(),
        riskConfig: DEFAULT_RISK,
      })
      if (op.spec.action !== 'placeOrder') throw new Error()
      expect(op.spec.stopLoss).toBeUndefined()
    })
  })
})
