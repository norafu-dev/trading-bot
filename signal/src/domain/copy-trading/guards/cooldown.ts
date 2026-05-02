import type { OperationGuard, GuardContext } from './types.js'

/**
 * Adapted from `reference/OpenAlice/src/domain/trading/guards/cooldown.ts`
 *
 * Differences:
 *   - Per-(kolId, symbol) instead of per-symbol. Two different KOLs both
 *     calling BTC long don't compete for the same cooldown slot.
 *   - Stateful map can be persisted by the caller via `getState()` /
 *     `setState()`. The engine wires this into `data/operations/
 *     cooldown.json` so a restart doesn't reset cooldowns.
 *   - Synchronous `check` — persistence is the engine's responsibility,
 *     not the guard's.
 *   - Records the timestamp on a PASS only (rejecting attempt should
 *     not extend the window).
 */

export interface CooldownState {
  /** Map keyed by `kolId:symbol`, value is ms timestamp of last passed check. */
  lastPassed: Record<string, number>
}

export class CooldownGuard implements OperationGuard {
  readonly name = 'cooldown'
  private readonly minIntervalMs: number
  private state = new Map<string, number>()

  constructor(options: Record<string, unknown>) {
    const minutes = typeof options['minIntervalMinutes'] === 'number'
      ? (options['minIntervalMinutes'] as number)
      : 5
    this.minIntervalMs = minutes * 60_000
  }

  /** Restore from persisted state on boot. */
  loadState(state: CooldownState): void {
    this.state = new Map(Object.entries(state.lastPassed))
  }

  /** Snapshot for persistence after each pass. */
  getState(): CooldownState {
    return { lastPassed: Object.fromEntries(this.state) }
  }

  check(ctx: GuardContext): string | null {
    if (ctx.operation.spec.action !== 'placeOrder') return null

    const key = `${ctx.kol.id}:${ctx.operation.spec.symbol}`
    const last = this.state.get(key)
    const nowMs = ctx.now.getTime()

    if (last !== undefined) {
      const elapsedMs = nowMs - last
      if (elapsedMs < this.minIntervalMs) {
        const remainingSec = Math.ceil((this.minIntervalMs - elapsedMs) / 1000)
        return `cooldown active for ${ctx.kol.id} on ${ctx.operation.spec.symbol}: ${remainingSec}s remaining`
      }
    }

    // Pass — record the time
    this.state.set(key, nowMs)
    return null
  }
}
