import { logger } from '../../../core/logger.js'
import { CooldownGuard } from './cooldown.js'
import { LowConfidenceGuard } from './low-confidence.js'
import { MaxPositionsPerKolGuard } from './max-positions-per-kol.js'
import { StaleSignalGuard } from './stale-signal.js'
import { SymbolWhitelistGuard } from './symbol-whitelist.js'
import type { GuardRegistryEntry, OperationGuard } from './types.js'
import { UnitMismatchGuard } from './unit-mismatch.js'

/**
 * Adapted from `reference/OpenAlice/src/domain/trading/guards/registry.ts`.
 * Same factory + resolveGuards pattern; the built-in roster is different
 * because copy-trading has different concerns (signal-based vs LLM-driven).
 */

const builtinGuards: GuardRegistryEntry[] = [
  // Order matters — see `guard-pipeline.ts`. Cheap deterministic checks
  // first, expensive / stateful ones last.
  { type: 'low-confidence',         create: (o) => new LowConfidenceGuard(o) },
  { type: 'unit-mismatch',          create: () => new UnitMismatchGuard() },
  { type: 'stale-signal',           create: () => new StaleSignalGuard() },
  { type: 'symbol-whitelist',       create: (o) => new SymbolWhitelistGuard(o) },
  { type: 'max-positions-per-kol',  create: () => new MaxPositionsPerKolGuard() },
  { type: 'cooldown',               create: (o) => new CooldownGuard(o) },
]

const registry = new Map<string, GuardRegistryEntry['create']>(
  builtinGuards.map((g) => [g.type, g.create]),
)

/** Register a custom guard type (third-party extensions, tests). */
export function registerGuard(entry: GuardRegistryEntry): void {
  registry.set(entry.type, entry.create)
}

/**
 * Resolve declarative configs into concrete guard instances. Unknown
 * types are skipped with a warning — this is a config error worth
 * surfacing but not so fatal that a typo bricks the engine.
 */
export function resolveGuards(
  configs: Array<{ type: string; options?: Record<string, unknown> }>,
): OperationGuard[] {
  const out: OperationGuard[] = []
  for (const cfg of configs) {
    const factory = registry.get(cfg.type)
    if (!factory) {
      logger.warn({ type: cfg.type }, 'guards/registry: unknown guard type, skipped')
      continue
    }
    out.push(factory(cfg.options ?? {}))
  }
  return out
}

/** Default roster — used when no per-account guard list is configured. */
export const DEFAULT_GUARD_CONFIGS: Array<{ type: string; options?: Record<string, unknown> }> = [
  { type: 'low-confidence', options: { minConfidence: 0.7 } },
  { type: 'unit-mismatch' },
  { type: 'stale-signal' },
  { type: 'max-positions-per-kol' },
  { type: 'symbol-whitelist' },
  { type: 'cooldown', options: { minIntervalMinutes: 5 } },
]
