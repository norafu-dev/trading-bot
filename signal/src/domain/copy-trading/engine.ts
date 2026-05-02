import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Operation, Signal, TradingAccountConfig } from '../../../../shared/types.js'
import type { EventLog } from '../../core/event-log.js'
import { logger } from '../../core/logger.js'
import { loadRiskConfig } from '../../core/risk-config.js'
import {
  CooldownGuard,
  GuardPipeline,
  type CooldownState,
  type OperationGuard,
} from './guards/index.js'
import { OperationStore } from './operation-store.js'
import { PositionSizer } from './position-sizer.js'
import type { ISnapshotService } from './snapshot-service.js'

/**
 * Orchestrator that turns a `Signal` into an `Operation`.
 *
 * One end-to-end call is `process(signal)`:
 *
 *   1. Pick the trading account this signal lands on (current heuristic:
 *      first enabled CCXT account; future: per-KOL routing field).
 *   2. Fetch a snapshot from `SnapshotService` (in-memory cache, no
 *      hot-path I/O).
 *   3. `PositionSizer.size(...)` to produce a draft `Operation`.
 *   4. Build a `GuardContext` and run the `GuardPipeline`.
 *   5. Mark the operation `pending` (passed) or `rejected` (any guard
 *      blocked) and persist.
 *   6. Emit an event so the dashboard / future audit consumers can see it.
 *
 * Failures of any single signal never throw out of `process()` — the
 * caller (ResultRouter) treats this as fire-and-forget on the signal
 * pipeline's hot path.
 *
 * State on disk:
 *   data/operations/operations.jsonl    — every Operation produced
 *   data/operations/guard-state.json    — CooldownGuard's state map
 *
 * The guard-state file is loaded once at construction and rewritten
 * after every passed-through operation. This keeps cooldowns honoured
 * across restarts.
 */

export interface EngineDeps {
  /** Yields the current set of registered trading accounts. Called per-signal so a config change takes effect immediately. */
  listAccounts: () => Promise<TradingAccountConfig[]>
  snapshots: ISnapshotService
  store: OperationStore
  events: EventLog
  guards: OperationGuard[]
  /** Path to persist stateful guard state (currently just CooldownGuard). */
  guardStateFile: string
}

export class CopyTradingEngine {
  private readonly sizer = new PositionSizer()
  private readonly pipeline: GuardPipeline
  private readonly cooldownGuard: CooldownGuard | null

  constructor(private readonly deps: EngineDeps) {
    this.pipeline = new GuardPipeline(deps.guards)
    // The pipeline holds OperationGuard, but only CooldownGuard has
    // persistent state. Pull it out so we can save/restore.
    this.cooldownGuard = (deps.guards.find((g): g is CooldownGuard => g instanceof CooldownGuard)) ?? null
  }

  /** Restore CooldownGuard state from disk. Called once at boot. */
  async loadGuardState(): Promise<void> {
    if (!this.cooldownGuard) return
    try {
      const raw = await readFile(this.deps.guardStateFile, 'utf-8')
      const parsed = JSON.parse(raw) as { cooldown?: CooldownState }
      if (parsed.cooldown) this.cooldownGuard.loadState(parsed.cooldown)
    } catch (err) {
      // ENOENT on first boot is fine — no state to restore.
      if (!isENOENT(err)) {
        logger.warn({ err, path: this.deps.guardStateFile }, 'engine.loadGuardState: failed, starting fresh')
      }
    }
  }

  private async saveGuardState(): Promise<void> {
    if (!this.cooldownGuard) return
    try {
      await mkdir(dirname(this.deps.guardStateFile), { recursive: true })
      await writeFile(
        this.deps.guardStateFile,
        JSON.stringify({ cooldown: this.cooldownGuard.getState() }, null, 2),
        'utf-8',
      )
    } catch (err) {
      logger.warn({ err }, 'engine.saveGuardState: write failed')
    }
  }

  /**
   * Main hook from ResultRouter. Returns the Operation it produced (so
   * tests / sync callers can inspect), or null when no account is
   * available to route to.
   */
  async process(signal: Signal, kol: import('../../../../shared/types.js').KolConfig): Promise<Operation | null> {
    const accounts = await this.deps.listAccounts()
    const account = accounts.find((a) => a.enabled && a.type === 'ccxt')
    if (!account) {
      logger.info(
        { signalId: signal.id, kolId: signal.kolId },
        'CopyTradingEngine: no enabled CCXT account; skipping operation creation',
      )
      return null
    }

    const snap = this.deps.snapshots.get(account.id)
    if (!snap) {
      logger.warn(
        { signalId: signal.id, accountId: account.id },
        'CopyTradingEngine: no account snapshot available yet; skipping (will retry on next signal once SnapshotService warms up)',
      )
      return null
    }

    const riskConfig = await loadRiskConfig()
    const operation = this.sizer.size({
      signal,
      kol,
      account: snap.balance,
      riskConfig,
      now: new Date().toISOString(),
    })

    // Pending operations on the same account belonging to the same KOL.
    // Best-effort — readAll loads the whole JSONL into memory; fine at
    // current volume (hundreds of records). Phase 5 will add an index.
    const pendingForSameKol = await this.collectPendingForKol(operation.kolId, account.id)

    const ctx = {
      operation,
      signal,
      kol,
      account: snap.balance,
      positions: snap.positions,
      pendingForSameKol,
      now: new Date(),
    }

    const result = this.pipeline.run(ctx)
    operation.guardResults = result.verdicts

    if (!result.passed && result.rejection) {
      operation.status = 'rejected'
      operation.guardRejection = result.rejection
    }

    await this.deps.store.append(operation)
    await this.saveGuardState()

    await this.deps.events.append('operation.created', {
      operationId: operation.id,
      signalId: operation.signalId,
      kolId: operation.kolId,
      accountId: operation.accountId,
      status: operation.status,
      symbol: operation.spec.action === 'placeOrder' ? operation.spec.symbol : '(other)',
      rejection: operation.guardRejection,
    })

    return operation
  }

  private async collectPendingForKol(kolId: string, accountId: string): Promise<Operation[]> {
    const all = await this.deps.store.readAllOperations()
    return all.filter(
      (op) =>
        op.kolId === kolId &&
        op.accountId === accountId &&
        op.status === 'pending',
    )
  }
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
