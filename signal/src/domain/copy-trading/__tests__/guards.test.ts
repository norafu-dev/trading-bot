import { describe, expect, it } from 'vitest'
import { CooldownGuard } from '../guards/cooldown.js'
import { GuardPipeline } from '../guards/guard-pipeline.js'
import { LowConfidenceGuard } from '../guards/low-confidence.js'
import { MaxPositionsPerKolGuard } from '../guards/max-positions-per-kol.js'
import { resolveGuards } from '../guards/registry.js'
import { StaleSignalGuard } from '../guards/stale-signal.js'
import { SymbolWhitelistGuard } from '../guards/symbol-whitelist.js'
import { UnitMismatchGuard } from '../guards/unit-mismatch.js'
import { makeCtx, makeKol, makeOperation, makeSignal } from './helpers.js'

describe('LowConfidenceGuard', () => {
  it('passes when confidence ≥ threshold', () => {
    const g = new LowConfidenceGuard({ minConfidence: 0.7 })
    expect(g.check(makeCtx({ signal: makeSignal({ confidence: 0.85 }) }))).toBeNull()
  })
  it('rejects when below threshold', () => {
    const g = new LowConfidenceGuard({ minConfidence: 0.7 })
    expect(g.check(makeCtx({ signal: makeSignal({ confidence: 0.5 }) }))).toMatch(/below operation threshold/)
  })
  it('uses default threshold (0.7) when none given', () => {
    const g = new LowConfidenceGuard({})
    expect(g.check(makeCtx({ signal: makeSignal({ confidence: 0.6 }) }))).not.toBeNull()
    expect(g.check(makeCtx({ signal: makeSignal({ confidence: 0.8 }) }))).toBeNull()
  })
})

describe('StaleSignalGuard', () => {
  const g = new StaleSignalGuard()
  // makeOperation defaults to a limit order, which the guard now exempts;
  // build a market-order op for the tests that need to verify rejection.
  const marketOp = makeOperation({
    spec: {
      action: 'placeOrder',
      symbol: 'BTC',
      side: 'long',
      contractType: 'perpetual',
      orderType: 'market',
      size: { unit: 'absolute', value: '90' },
      leverage: 10,
    },
  })

  it('passes when no priceCheck', () => {
    expect(g.check(makeCtx({ signal: makeSignal({ priceCheck: undefined }) }))).toBeNull()
  })
  it('passes when priceCheck not stale', () => {
    expect(g.check(makeCtx({
      signal: makeSignal({ priceCheck: { currentPrice: '76500', source: 'binance', fetchedAt: 'x', stale: false } }),
    }))).toBeNull()
  })
  it('rejects a market order when stale, includes distance in reason', () => {
    const r = g.check(makeCtx({
      operation: marketOp,
      signal: makeSignal({
        priceCheck: { currentPrice: '78000', source: 'binance', fetchedAt: 'x', stale: true, entryDistancePercent: '-2.5' },
      }),
    }))
    expect(r).toMatch(/stale/)
    expect(r).toContain('-2.5%')
  })
  // Limit orders intentionally sit on the "wrong" side of the live price
  // waiting for a pullback. They should never trip the stale guard even
  // when priceCheck.stale is true (e.g. TAO short 411.84 with live 310.94 —
  // the order will simply not fill until price rebounds).
  // Limit orders are exempt from the stale auto-reject. Even an entry
  // 32% above current price (Trader Cash TAO short-bounce setup) is
  // legitimate "wait for the market to come back" semantics. priceCheck
  // still surfaces the stale flag for dashboard display, but the guard
  // lets the operator decide.
  it('passes a stale-flagged LIMIT order — limits cost nothing while unfilled', () => {
    const r = g.check(makeCtx({
      // makeCtx default operation is already limit (see helpers)
      signal: makeSignal({
        priceCheck: { currentPrice: '310.94', source: 'binance', fetchedAt: 'x', stale: true, entryDistancePercent: '32.45' },
      }),
    }))
    expect(r).toBeNull()
  })
})

describe('UnitMismatchGuard', () => {
  const g = new UnitMismatchGuard()
  it('passes when no priceCheck', () => {
    expect(g.check(makeCtx({ signal: makeSignal({ priceCheck: undefined }) }))).toBeNull()
  })
  it('rejects when unitMismatch flagged', () => {
    expect(g.check(makeCtx({
      signal: makeSignal({
        priceCheck: { currentPrice: '78000', source: 'binance', fetchedAt: 'x', unitMismatch: true, note: 'live 78000 · entry 7.67' },
      }),
    }))).toMatch(/unit mismatch/)
  })
})

describe('MaxPositionsPerKolGuard', () => {
  const g = new MaxPositionsPerKolGuard()
  it('passes when no max set', () => {
    expect(g.check(makeCtx({ kol: makeKol({ maxOpenPositions: 0 }) }))).toBeNull()
  })
  it('passes when pending count below max', () => {
    expect(g.check(makeCtx({
      kol: makeKol({ maxOpenPositions: 3 }),
      pendingForSameKol: [makeOperation()],
    }))).toBeNull()
  })
  it('rejects when pending count reaches max', () => {
    const r = g.check(makeCtx({
      kol: makeKol({ maxOpenPositions: 2 }),
      pendingForSameKol: [makeOperation(), makeOperation()],
    }))
    expect(r).toMatch(/already has 2 pending/)
  })
})

describe('SymbolWhitelistGuard', () => {
  it('passes when whitelist is empty (default)', () => {
    const g = new SymbolWhitelistGuard({ symbols: [] })
    expect(g.check(makeCtx())).toBeNull()
  })
  it('passes for symbol on whitelist', () => {
    const g = new SymbolWhitelistGuard({ symbols: ['BTC', 'ETH'] })
    expect(g.check(makeCtx())).toBeNull()  // op symbol = BTC
  })
  it('rejects symbol not on whitelist', () => {
    const g = new SymbolWhitelistGuard({ symbols: ['ETH', 'SOL'] })
    expect(g.check(makeCtx())).toMatch(/not in the whitelist/)
  })
  it('matches normalised base — BTC/USDT vs BTCUSDT vs BTC', () => {
    const g = new SymbolWhitelistGuard({ symbols: ['BTC'] })
    expect(g.check(makeCtx({ operation: makeOperation({ spec: {
      ...makeOperation().spec, symbol: 'BTC/USDT',
    } as never }) }))).toBeNull()
    expect(g.check(makeCtx({ operation: makeOperation({ spec: {
      ...makeOperation().spec, symbol: 'BTCUSDT',
    } as never }) }))).toBeNull()
    expect(g.check(makeCtx({ operation: makeOperation({ spec: {
      ...makeOperation().spec, symbol: 'BTC/USDT:USDT',
    } as never }) }))).toBeNull()
  })
})

describe('CooldownGuard', () => {
  it('passes the first time', () => {
    const g = new CooldownGuard({ minIntervalMinutes: 5 })
    expect(g.check(makeCtx())).toBeNull()
  })
  it('rejects within cooldown window', () => {
    const g = new CooldownGuard({ minIntervalMinutes: 5 })
    g.check(makeCtx({ now: new Date('2026-05-02T10:00:00Z') }))
    const r = g.check(makeCtx({ now: new Date('2026-05-02T10:02:00Z') }))
    expect(r).toMatch(/cooldown active/)
  })
  it('passes again after window elapses', () => {
    const g = new CooldownGuard({ minIntervalMinutes: 5 })
    g.check(makeCtx({ now: new Date('2026-05-02T10:00:00Z') }))
    expect(g.check(makeCtx({ now: new Date('2026-05-02T10:06:00Z') }))).toBeNull()
  })
  it('per (kol, symbol) — different KOL same symbol does not share cooldown', () => {
    const g = new CooldownGuard({ minIntervalMinutes: 5 })
    g.check(makeCtx({ kol: makeKol({ id: 'kol-A' }), now: new Date('2026-05-02T10:00:00Z') }))
    expect(g.check(makeCtx({
      kol: makeKol({ id: 'kol-B' }),
      now: new Date('2026-05-02T10:01:00Z'),
    }))).toBeNull()
  })
  it('does NOT extend window when rejected', () => {
    const g = new CooldownGuard({ minIntervalMinutes: 5 })
    g.check(makeCtx({ now: new Date('2026-05-02T10:00:00Z') }))
    // Try at 10:02 (rejected) — should not push window to 10:07
    g.check(makeCtx({ now: new Date('2026-05-02T10:02:00Z') }))
    // Original 10:00 + 5 min = 10:05 should now pass
    expect(g.check(makeCtx({ now: new Date('2026-05-02T10:05:30Z') }))).toBeNull()
  })
  it('round-trip via getState / loadState', () => {
    const g1 = new CooldownGuard({ minIntervalMinutes: 5 })
    g1.check(makeCtx({ now: new Date('2026-05-02T10:00:00Z') }))
    const state = g1.getState()
    const g2 = new CooldownGuard({ minIntervalMinutes: 5 })
    g2.loadState(state)
    expect(g2.check(makeCtx({ now: new Date('2026-05-02T10:02:00Z') }))).toMatch(/cooldown active/)
  })
})

describe('GuardPipeline', () => {
  it('passes when every guard passes', () => {
    const p = new GuardPipeline([new LowConfidenceGuard({ minConfidence: 0.5 }), new UnitMismatchGuard()])
    const r = p.run(makeCtx())
    expect(r.passed).toBe(true)
    expect(r.verdicts).toHaveLength(2)
    expect(r.verdicts.every((v) => v.passed)).toBe(true)
  })

  it('short-circuits on the first rejection, recording the rejecting guard', () => {
    const p = new GuardPipeline([
      new LowConfidenceGuard({ minConfidence: 0.5 }),
      new UnitMismatchGuard(),
      new StaleSignalGuard(),
    ])
    const ctx = makeCtx({
      signal: makeSignal({
        priceCheck: { currentPrice: '78000', source: 'binance', fetchedAt: 'x', unitMismatch: true, note: 'huge gap' },
      }),
    })
    const r = p.run(ctx)
    expect(r.passed).toBe(false)
    expect(r.verdicts).toHaveLength(2)  // low-confidence ✓, unit-mismatch ✗ (short-circuited)
    expect(r.verdicts[0]?.passed).toBe(true)
    expect(r.verdicts[1]?.passed).toBe(false)
    expect(r.rejection?.guardName).toBe('unit-mismatch')
  })
})

describe('resolveGuards', () => {
  it('builds instances from declarative configs', () => {
    const guards = resolveGuards([
      { type: 'low-confidence', options: { minConfidence: 0.8 } },
      { type: 'symbol-whitelist', options: { symbols: ['BTC'] } },
      { type: 'cooldown', options: { minIntervalMinutes: 1 } },
    ])
    expect(guards.map((g) => g.name)).toEqual(['low-confidence', 'symbol-whitelist', 'cooldown'])
  })
  it('skips unknown types with a warning, doesn\'t throw', () => {
    const guards = resolveGuards([
      { type: 'unknown-guard' },
      { type: 'low-confidence' },
    ])
    expect(guards.map((g) => g.name)).toEqual(['low-confidence'])
  })
})
