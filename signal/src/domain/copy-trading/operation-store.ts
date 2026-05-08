import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { logger } from '../../core/logger.js'
import type { Operation } from '../../../../shared/types.js'

/**
 * Append-only JSONL store for `Operation` records and their status changes.
 *
 * Design follows the SignalStore pattern (Batch 6):
 *   - one line per record
 *   - chronological insertion order = reliable replay
 *   - never delete or rewrite existing lines
 *
 * Status transitions (pending → approved → rejected → executed) are
 * appended as `kind: 'status-change'` events rather than mutating the
 * original `kind: 'operation'` record. The read path folds them back
 * onto the operation so callers see the latest status without knowing
 * about the event-sourcing layer underneath.
 */

export interface OperationStoreRecord {
  kind: 'operation'
  record: Operation
}

/**
 * Status-transition event. Appended every time `PUT /api/operations/:id/status`
 * (or, in the future, the broker push path) flips an operation's status.
 * `by` distinguishes dashboard / telegram / engine origin so the audit
 * trail is unambiguous.
 */
export interface OperationStatusChangeRecord {
  kind: 'status-change'
  /** Operation.id this change targets. */
  operationId: string
  /** New status — replaces the operation's current status. */
  newStatus: Operation['status']
  /** ISO 8601 — when the change happened. */
  at: string
  /** Origin of the change. 'dashboard' / 'telegram' / 'engine' / 'broker'. */
  by: 'dashboard' | 'telegram' | 'engine' | 'broker'
  /** Optional human reason — typically present on manual rejects. */
  reason?: string
}

export type StoreLine = OperationStoreRecord | OperationStatusChangeRecord

export interface IOperationStore {
  append(operation: Operation): Promise<void>
  /**
   * Persist a status transition event. The operation record itself
   * remains immutable on disk; consumers fold these events when reading.
   */
  appendStatusChange(change: Omit<OperationStatusChangeRecord, 'kind'>): Promise<void>
  /**
   * Replay everything in insertion (chronological) order. Yields a mix
   * of `kind: 'operation'` and `kind: 'status-change'` records — useful
   * when you need the full audit trail. Most consumers want
   * `readAllOperations()` instead.
   */
  replay(): AsyncIterable<StoreLine>
  /**
   * Read every operation, applying status-change events in order so
   * each returned operation reflects its CURRENT status. Pure read —
   * no rewriting, no delete.
   */
  readAllOperations(): Promise<Operation[]>
}

export class OperationStore implements IOperationStore {
  constructor(private readonly path: string) {}

  async append(operation: Operation): Promise<void> {
    await this.write({ kind: 'operation', record: operation })
  }

  async appendStatusChange(
    change: Omit<OperationStatusChangeRecord, 'kind'>,
  ): Promise<void> {
    await this.write({ kind: 'status-change', ...change })
  }

  async *replay(): AsyncIterable<StoreLine> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf-8')
    } catch (err) {
      if (isENOENT(err)) return
      throw err
    }

    let line = 0
    for (const text of raw.split('\n')) {
      line++
      if (!text.trim()) continue
      try {
        const parsed = JSON.parse(text) as StoreLine
        if (parsed.kind !== 'operation' && parsed.kind !== 'status-change') {
          logger.warn(
            { path: this.path, line, kind: (parsed as { kind?: unknown }).kind },
            'OperationStore.replay: unknown record kind, skipping',
          )
          continue
        }
        yield parsed
      } catch (err) {
        logger.warn(
          { err, path: this.path, line },
          'OperationStore.replay: malformed JSON line, skipping',
        )
      }
    }
  }

  /**
   * Fold all status-change events onto their operations and return the
   * latest view. Insertion order is preserved (creation chronology),
   * but each operation reflects its CURRENT status.
   *
   * Also attaches `lastDecision` ({by, at, reason}) from the most recent
   * status-change so the dashboard can distinguish guard rejections from
   * approval timeouts from human rejects without re-querying the event
   * log per operation.
   */
  async readAllOperations(): Promise<Operation[]> {
    const byId = new Map<string, Operation>()
    const order: string[] = []
    for await (const line of this.replay()) {
      if (line.kind === 'operation') {
        const op = line.record
        if (!byId.has(op.id)) order.push(op.id)
        byId.set(op.id, { ...op })
        continue
      }
      // status-change
      const op = byId.get(line.operationId)
      if (!op) {
        // Status change for an unknown operation — possible if the file
        // was hand-edited or partially restored. Skip rather than crash.
        continue
      }
      op.status = line.newStatus
      op.lastDecision = {
        by: line.by,
        at: line.at,
        ...(line.reason !== undefined && { reason: line.reason }),
      }
    }
    return order.map((id) => byId.get(id)!).filter(Boolean)
  }

  private async write(line: StoreLine): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, JSON.stringify(line) + '\n', 'utf-8')
    } catch (err) {
      logger.error(
        { err, path: this.path, kind: line.kind },
        'OperationStore.write failed — record was NOT persisted',
      )
      throw err
    }
  }
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
