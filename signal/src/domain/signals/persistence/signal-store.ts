import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { logger } from '../../../core/logger.js'
import type { Signal, PositionUpdate } from '../../../../../shared/types.js'

/**
 * Append-only JSONL store for parsed Signals and PositionUpdates.
 *
 * One file: `data/signals/signals.jsonl`. Mixed records (signals + updates)
 * are interleaved in the order they were parsed. Each line is a discriminated
 * record: `{ kind: 'signal' | 'update', record: Signal | PositionUpdate }`.
 *
 * Why mixed instead of separate files: replay order matters for crash
 * recovery — the index builder must process records strictly in time order
 * so that a `markClosed`-triggering update applied at time T+1 doesn't
 * mistakenly find a still-open signal in the file. A single chronological
 * file makes that guarantee trivial.
 *
 * Why no rotation in this batch: single file is fine at current message
 * volume (~hundreds/day). When this becomes hot we can introduce per-day
 * files; the consumer side already iterates record-by-record.
 */

// ── On-disk record shape ─────────────────────────────────────────────────────

export type StoredRecord =
  | { kind: 'signal'; record: Signal }
  | { kind: 'update'; record: PositionUpdate }

// ── Interface ────────────────────────────────────────────────────────────────

export interface ISignalStore {
  appendSignal(signal: Signal): Promise<void>
  appendUpdate(update: PositionUpdate): Promise<void>
  /**
   * Replay all records in chronological insertion order.
   * Async iterator so callers can stop early or stream into an index without
   * loading the entire file into memory.
   */
  replay(): AsyncIterable<StoredRecord>
}

// ── Implementation ───────────────────────────────────────────────────────────

export class SignalStore implements ISignalStore {
  constructor(private readonly path: string) {}

  async appendSignal(signal: Signal): Promise<void> {
    await this.write({ kind: 'signal', record: signal })
  }

  async appendUpdate(update: PositionUpdate): Promise<void> {
    await this.write({ kind: 'update', record: update })
  }

  async *replay(): AsyncIterable<StoredRecord> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf-8')
    } catch (err) {
      if (isENOENT(err)) return
      throw err
    }

    let lineNumber = 0
    for (const line of raw.split('\n')) {
      lineNumber++
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as StoredRecord
        // Cheap shape-guard: malformed entries are logged and skipped, not
        // fatal — the store is append-only and a corrupt line should not
        // block recovery of all the well-formed ones.
        if (parsed.kind !== 'signal' && parsed.kind !== 'update') {
          logger.warn(
            { path: this.path, lineNumber, kind: (parsed as { kind?: unknown }).kind },
            'SignalStore.replay: unknown record kind, skipping',
          )
          continue
        }
        yield parsed
      } catch (err) {
        logger.warn(
          { err, path: this.path, lineNumber },
          'SignalStore.replay: malformed JSON line, skipping',
        )
      }
    }
  }

  private async write(record: StoredRecord): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, JSON.stringify(record) + '\n', 'utf-8')
    } catch (err) {
      logger.error(
        {
          err,
          path: this.path,
          kind: record.kind,
          recordId: record.record.id,
        },
        'SignalStore write failed — record was NOT persisted',
      )
      throw err
    }
  }
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
