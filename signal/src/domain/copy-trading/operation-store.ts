import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { logger } from '../../core/logger.js'
import type { Operation } from '../../../../shared/types.js'

/**
 * Append-only JSONL store for `Operation` records.
 *
 * Design follows the SignalStore pattern (Batch 6):
 *   - one line per record
 *   - chronological insertion order = reliable replay
 *   - never delete or rewrite existing lines
 *
 * Status changes (pending → approved → executed) will be appended as
 * NEW records rather than mutating the original — Phase 5 / 6 will add
 * a `kind: 'status-change'` event variant. For now we only emit
 * `kind: 'operation'` records.
 */

export interface OperationStoreRecord {
  kind: 'operation'
  record: Operation
}

export interface IOperationStore {
  append(operation: Operation): Promise<void>
  /**
   * Replay everything in insertion (chronological) order. Used by the
   * read-only `/api/operations` route and (in Phase 5) by the engine
   * to rebuild the in-memory pending set on boot.
   */
  replay(): AsyncIterable<OperationStoreRecord>
  /**
   * Convenience: read all into an array. Tests + small read-paths use
   * this; production hot paths should use `replay()`.
   */
  readAll(): Promise<OperationStoreRecord[]>
}

export class OperationStore implements IOperationStore {
  constructor(private readonly path: string) {}

  async append(operation: Operation): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true })
      const line = JSON.stringify({ kind: 'operation', record: operation } satisfies OperationStoreRecord)
      await appendFile(this.path, line + '\n', 'utf-8')
    } catch (err) {
      logger.error(
        { err, path: this.path, operationId: operation.id, kolId: operation.kolId },
        'OperationStore.append failed — record was NOT persisted',
      )
      throw err
    }
  }

  async *replay(): AsyncIterable<OperationStoreRecord> {
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
        const parsed = JSON.parse(text) as OperationStoreRecord
        if (parsed.kind !== 'operation') {
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

  async readAll(): Promise<OperationStoreRecord[]> {
    const out: OperationStoreRecord[] = []
    for await (const r of this.replay()) out.push(r)
    return out
  }
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
