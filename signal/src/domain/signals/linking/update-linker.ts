import type { PositionUpdate } from '../../../../../shared/types.js'
import type { ILinkStrategy, ISignalIndex, LinkResult } from './types.js'

/**
 * Orchestrates link strategies in priority order until one returns a hit.
 *
 * Default ordering for the production wiring:
 *   1. `by_external_id` — deterministic snowflake match (bot KOLs always
 *      hit here because of DEC-016).
 *   2. `by_kol_symbol` — heuristic fallback for human KOLs.
 *
 * The linker is stateless and pure: it never throws, never mutates the
 * passed `update`, and returns the first successful `LinkResult` (or a
 * `linked: false` summary describing each attempt).
 */
export class UpdateLinker {
  constructor(private readonly strategies: ILinkStrategy[]) {
    if (strategies.length === 0) {
      throw new Error('UpdateLinker requires at least one strategy')
    }
  }

  link(update: PositionUpdate, index: ISignalIndex): LinkResult {
    const reasons: string[] = []

    for (const strat of this.strategies) {
      const result = strat.tryLink(update, index)
      if (result.linked) return result
      reasons.push(`${strat.name}: ${result.reason}`)
    }

    return {
      linked: false,
      reason: reasons.join(' | '),
    }
  }
}
