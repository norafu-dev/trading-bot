import type { OperationGuard, GuardContext } from './types.js'

/**
 * Reject signals whose extractor confidence is below a threshold.
 *
 * Note: there's already a confidence gate in `LlmParser` (drives
 * `parse.discarded` with `low_confidence`), but that gate uses the
 * KOL's `confidenceOverride` or a global default. This guard sits on
 * the operation side and applies a separate (typically higher)
 * threshold — the LLM gate keeps obvious junk out of the audit log,
 * the operation gate enforces the policy: "a marginal-quality signal
 * shouldn't trade real money".
 */
export class LowConfidenceGuard implements OperationGuard {
  readonly name = 'low-confidence'
  private readonly minConfidence: number

  constructor(options: Record<string, unknown>) {
    const raw = options['minConfidence']
    this.minConfidence = typeof raw === 'number' ? raw : 0.7
  }

  check(ctx: GuardContext): string | null {
    if (ctx.signal.confidence >= this.minConfidence) return null
    return `signal confidence ${ctx.signal.confidence.toFixed(2)} is below operation threshold ${this.minConfidence}`
  }
}
