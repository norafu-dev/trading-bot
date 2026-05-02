import { describe, expect, it } from 'vitest'
import type { RiskConfig } from '../../../../../shared/types.js'
import { PositionSizer } from '../position-sizer.js'
import { makeAccount, makeKol, makeSignal } from './helpers.js'

const DEFAULT_RISK: RiskConfig = {
  baseRiskPercent: 1,
  maxOperationSizePercent: 5,
  symbolWhitelist: [],
  cooldownMinutes: 5,
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
})
