import { describe, expect, it } from 'vitest'
import { distributeTpAmounts } from '../tp-distribution.js'

// Helper: sum to high precision so float drift from division doesn't trip
// strict equality tests. The function guarantees sum exactly equals total.
function sum(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0)
}

describe('distributeTpAmounts — even', () => {
  it('splits 1 BTC across 4 TPs evenly', () => {
    const r = distributeTpAmounts(1, 4, 'even')
    expect(r).toHaveLength(4)
    for (const v of r) expect(v).toBeCloseTo(0.25, 10)
    expect(sum(r)).toBe(1)
  })

  it('splits 0.001 BTC across 3 TPs without rounding crumbs', () => {
    const r = distributeTpAmounts(0.001, 3, 'even')
    expect(sum(r)).toBe(0.001)  // exact sum is the whole point of the residual scheme
  })

  it('returns a single bucket for tpCount=1', () => {
    expect(distributeTpAmounts(50, 1, 'even')).toEqual([50])
  })

  it('returns empty for tpCount=0', () => {
    expect(distributeTpAmounts(50, 0, 'even')).toEqual([])
  })
})

describe('distributeTpAmounts — front-heavy', () => {
  it('4 TPs → 40/30/20/10', () => {
    const r = distributeTpAmounts(100, 4, 'front-heavy')
    expect(r[0]).toBeCloseTo(40, 6)
    expect(r[1]).toBeCloseTo(30, 6)
    expect(r[2]).toBeCloseTo(20, 6)
    expect(r[3]).toBeCloseTo(10, 6)
    expect(sum(r)).toBe(100)
  })

  it('2 TPs → 67/33', () => {
    const r = distributeTpAmounts(100, 2, 'front-heavy')
    expect(r[0]).toBeCloseTo(66.67, 1)
    expect(r[1]).toBeCloseTo(33.33, 1)
    expect(sum(r)).toBe(100)
  })

  it('TP1 always largest', () => {
    for (const n of [2, 3, 4, 5, 6]) {
      const r = distributeTpAmounts(100, n, 'front-heavy')
      for (let i = 1; i < n; i++) expect(r[0]).toBeGreaterThan(r[i])
    }
  })
})

describe('distributeTpAmounts — back-heavy', () => {
  it('4 TPs → 10/20/30/40', () => {
    const r = distributeTpAmounts(100, 4, 'back-heavy')
    expect(r[0]).toBeCloseTo(10, 6)
    expect(r[1]).toBeCloseTo(20, 6)
    expect(r[2]).toBeCloseTo(30, 6)
    expect(r[3]).toBeCloseTo(40, 6)
    expect(sum(r)).toBe(100)
  })

  it('last TP always largest', () => {
    for (const n of [2, 3, 4, 5, 6]) {
      const r = distributeTpAmounts(100, n, 'back-heavy')
      for (let i = 0; i < n - 1; i++) expect(r[n - 1]).toBeGreaterThan(r[i])
    }
  })
})

describe('distributeTpAmounts — custom weights', () => {
  it('matches custom array exactly when length equals tpCount', () => {
    const r = distributeTpAmounts(100, 3, [50, 30, 20])
    expect(r[0]).toBeCloseTo(50, 6)
    expect(r[1]).toBeCloseTo(30, 6)
    expect(r[2]).toBeCloseTo(20, 6)
    expect(sum(r)).toBe(100)
  })

  it('normalises weights that do not sum to 100', () => {
    // [2, 1] → fractions 0.667 / 0.333
    const r = distributeTpAmounts(60, 2, [2, 1])
    expect(r[0]).toBeCloseTo(40, 6)
    expect(r[1]).toBeCloseTo(20, 6)
    expect(sum(r)).toBe(60)
  })

  it('truncates when custom array longer than tpCount', () => {
    // 4 weights provided but only 2 TPs → use first 2 = [50, 30] → norm 62.5/37.5
    const r = distributeTpAmounts(100, 2, [50, 30, 20, 10])
    expect(r[0]).toBeCloseTo(62.5, 6)
    expect(r[1]).toBeCloseTo(37.5, 6)
    expect(sum(r)).toBe(100)
  })

  it('pads with average when custom array shorter than tpCount', () => {
    // [50, 30] for 4 TPs → avg=40, padded to [50, 30, 40, 40] → 27.78/16.67/22.22/22.22 (of 100)
    const r = distributeTpAmounts(160, 4, [50, 30])
    // weights normalise to fractions 50/160, 30/160, 40/160, 40/160 = 31.25/18.75/25/25
    expect(r[0]).toBeCloseTo(50, 6)
    expect(r[1]).toBeCloseTo(30, 6)
    expect(r[2]).toBeCloseTo(40, 6)
    expect(r[3]).toBeCloseTo(40, 6)
    expect(sum(r)).toBe(160)
  })

  it('falls back to even split when all weights are zero (pathological)', () => {
    // [0, 0] would divide by zero — function falls back to even
    // (we use positive() in zod schema so this shouldn't reach prod, but
    // the runtime safety net matters)
    const r = distributeTpAmounts(100, 2, [0, 0] as unknown as number[])
    expect(r[0]).toBeCloseTo(50, 6)
    expect(r[1]).toBeCloseTo(50, 6)
  })
})
