/**
 * Compute the per-TP base-currency amount for a multi-TP order.
 *
 * Pure, no I/O. Lives in its own file so the policy can be unit-tested
 * without ccxt — the executor just calls this and forwards the numbers
 * to broker.placeOrder.
 *
 * Inputs:
 *   - totalAmount: the position's full base-currency size (e.g. 0.001 BTC)
 *   - tpCount: how many TPs we're actually executing (already capped by
 *              maxTakeProfits at the call site)
 *   - distribution: see RiskConfig.tpDistribution. Either a named preset
 *                   ('even' / 'front-heavy' / 'back-heavy') or a custom
 *                   number[] of weights.
 *
 * Output: number[] of length `tpCount`, summing to `totalAmount`. The
 * last element absorbs any rounding crumbs so the position closes cleanly.
 */

import type { RiskConfig } from '../../../../../shared/types.js'

export function distributeTpAmounts(
  totalAmount: number,
  tpCount: number,
  distribution: RiskConfig['tpDistribution'],
): number[] {
  if (tpCount <= 0) return []
  if (tpCount === 1) return [totalAmount]

  const weights = resolveWeights(distribution, tpCount)
  // Normalise to fractions of 1
  const total = weights.reduce((s, w) => s + w, 0)
  if (total <= 0) {
    // Pathological config — fall back to even split.
    return evenSplit(totalAmount, tpCount)
  }
  const fractions = weights.map((w) => w / total)

  // Allocate amounts. Keep the last bucket as the residual so the sum
  // matches `totalAmount` exactly (avoids "we placed 0.000999 instead of
  // 0.001 because of float rounding" off-by-pennies).
  const out: number[] = new Array(tpCount)
  let allocated = 0
  for (let i = 0; i < tpCount - 1; i++) {
    out[i] = totalAmount * fractions[i]
    allocated += out[i]
  }
  out[tpCount - 1] = totalAmount - allocated
  return out
}

// ── Internals ──────────────────────────────────────────────────────────

function resolveWeights(
  distribution: RiskConfig['tpDistribution'],
  tpCount: number,
): number[] {
  if (Array.isArray(distribution)) {
    // Custom weights. Length normalisation rules:
    //   - shorter than tpCount: pad the tail with the average of the
    //     existing entries so the user's intent ("first 3 are 50/30/20")
    //     applies and remaining TPs get sensible weights
    //   - longer than tpCount:  truncate
    if (distribution.length === tpCount) return [...distribution]
    if (distribution.length > tpCount) return distribution.slice(0, tpCount)
    const avg = distribution.reduce((s, w) => s + w, 0) / distribution.length
    const padded = [...distribution]
    while (padded.length < tpCount) padded.push(avg)
    return padded
  }

  switch (distribution) {
    case 'even':
      return new Array(tpCount).fill(1)

    case 'front-heavy': {
      // Linear taper: largest weight on TP1, smallest on the last.
      // For N=4 → [4,3,2,1] which normalises to 40/30/20/10.
      // For N=2 → [2,1] = 67/33.
      // For N=5 → [5,4,3,2,1] = 33/27/20/13/7.
      const out: number[] = []
      for (let i = 0; i < tpCount; i++) out.push(tpCount - i)
      return out
    }

    case 'back-heavy': {
      // Reverse of front-heavy — smallest on TP1, largest on the last.
      // For N=4 → [1,2,3,4] = 10/20/30/40.
      const out: number[] = []
      for (let i = 0; i < tpCount; i++) out.push(i + 1)
      return out
    }

    default: {
      // Exhaustiveness check — TS will complain at compile time if a new
      // preset is added but not handled.
      const _exhaustive: never = distribution
      void _exhaustive
      return new Array(tpCount).fill(1)
    }
  }
}

function evenSplit(totalAmount: number, n: number): number[] {
  const each = totalAmount / n
  const out = new Array(n).fill(each)
  // Fix rounding so the sum matches exactly
  out[n - 1] = totalAmount - each * (n - 1)
  return out
}
