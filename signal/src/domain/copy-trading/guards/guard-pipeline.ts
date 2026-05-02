import type { Operation } from '../../../../../shared/types.js'
import type { GuardContext, OperationGuard } from './types.js'

/**
 * Runs every guard in order, recording each verdict on the operation.
 *
 * Differs from OpenAlice's `createGuardPipeline` in two ways:
 *
 *   1. Returns a result object, not a "submit-or-reject" decision —
 *      callers (engine.ts) decide what to do with rejections (typically:
 *      mark the operation rejected and persist for audit).
 *
 *   2. Records ALL guards that ran, even after the first rejection.
 *      OpenAlice short-circuits on first rejection because there's no
 *      audit value in further checks. We DO short-circuit too (saves
 *      cycles), but we still record the short-circuit point so the
 *      dashboard can show "passed cooldown ✓ → blocked at stale-signal".
 *
 * Stateful guards (e.g. CooldownGuard) decide for themselves whether
 * to update internal state on a passed check. Cooldown only touches
 * its lastTradeTime map after the operation passes — otherwise a
 * rejected attempt would still extend the cooldown window.
 */
export interface GuardPipelineResult {
  /** True iff every guard returned null. */
  passed: boolean
  /**
   * Verdict for each guard that ran. On a rejection, the rejecting
   * guard is the last entry and `passed === false`. Earlier entries
   * have `passed === true`.
   */
  verdicts: Operation['guardResults']
  /** Set when a guard rejected. Undefined when everything passed. */
  rejection?: { guardName: string; reason: string }
}

export class GuardPipeline {
  constructor(private readonly guards: readonly OperationGuard[]) {}

  run(ctx: GuardContext): GuardPipelineResult {
    const verdicts: Operation['guardResults'] = []
    for (const guard of this.guards) {
      const reason = guard.check(ctx)
      if (reason == null) {
        verdicts.push({ name: guard.name, passed: true })
        continue
      }
      verdicts.push({ name: guard.name, passed: false, reason })
      return {
        passed: false,
        verdicts,
        rejection: { guardName: guard.name, reason },
      }
    }
    return { passed: true, verdicts }
  }
}
