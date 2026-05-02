/**
 * Guard contracts for the copy-trading pipeline.
 *
 * Adapted from `reference/OpenAlice/src/domain/trading/guards/types.ts`:
 *   - Same `OperationGuard` shape (`name` + `check(ctx)` returns string|null)
 *   - Same `GuardRegistryEntry` factory pattern
 *   - Extended `GuardContext` with `signal` + `kol` so guards can use the
 *     KOL's risk policy (maxOpenPositions) and the signal's price-check
 *     metadata (stale, unitMismatch). OpenAlice has no concept of a
 *     source signal — its operations come straight from an LLM trader,
 *     not from a third-party KOL.
 *
 * Guards stay stateless except for the persistent cooldown guard, which
 * keeps a small per-(kol,symbol) timestamp map serialised to disk.
 */

import type {
  AccountBalance,
  KolConfig,
  Operation,
  Signal,
  TradePosition,
} from '../../../../../shared/types.js'

/** Read-only context assembled by the engine, consumed by every guard. */
export interface GuardContext {
  readonly operation: Operation
  /** The originating signal — gives guards access to confidence + priceCheck. */
  readonly signal: Signal
  /** The KOL — gives guards access to maxOpenPositions, riskMultiplier, etc. */
  readonly kol: KolConfig
  /** Snapshot of the broker account this operation will land on. */
  readonly account: AccountBalance
  /** Live positions on that account. */
  readonly positions: readonly TradePosition[]
  /**
   * Pending operations from the same KOL on this account that haven't
   * been approved/rejected yet. Used by `MaxPositionsPerKolGuard` to
   * enforce the KOL's per-account ceiling.
   */
  readonly pendingForSameKol: readonly Operation[]
  /**
   * Wall-clock at decision time. Injected so guards can be tested
   * deterministically (and so the same `now` flows into the operation
   * record for audit consistency).
   */
  readonly now: Date
}

/**
 * Returns null to allow the operation, or a string explaining why it
 * should be rejected. Sync — guards must not do I/O on the hot path.
 * (Cooldown writes its persistence file but does it inside its own
 * sync check by side-effecting; the file write is async-fire-and-forget.)
 */
export interface OperationGuard {
  readonly name: string
  check(ctx: GuardContext): string | null
}

/** Registry entry — type tag + factory accepting plain options. */
export interface GuardRegistryEntry {
  type: string
  create(options: Record<string, unknown>): OperationGuard
}
