import { logger } from '../../../core/logger.js'
import type { ISignalIndex } from '../linking/types.js'
import type { ISignalStore } from './signal-store.js'

/**
 * Update types that mark a position as fully closed and therefore remove
 * the underlying Signal from the live index. See decision G in the Batch 6
 * design doc for the rationale.
 *
 * Partial closes (`tp_hit`, `runner_close`) and stop adjustments
 * (`stop_modified`, `breakeven_move`, `limit_filled`) leave the signal open.
 */
const CLOSING_UPDATE_TYPES = new Set([
  'sl_hit',
  'full_close',
  'breakeven_hit',
  'manual_close',
])

/**
 * Replays a `SignalStore` into an `ISignalIndex` to restore the live set of
 * open signals after a process restart.
 *
 * Algorithm:
 *   1. Walk records in chronological insertion order.
 *   2. On `signal` → `index.add(signal)`.
 *   3. On `update` whose updateType marks a full close → look up the
 *      originating signal (preferring DEC-016 `linkedExternalMessageId`,
 *      falling back to `externalMessageId`) and `markClosed`.
 *
 * Updates that cannot be linked during replay are logged and skipped — they
 * may have referenced signals that were already closed by a prior update or
 * never existed (e.g. an update arrived before its parent signal during a
 * partial-write crash). Either way, no exception is raised.
 */
export class SignalIndexBuilder {
  constructor(
    private readonly store: ISignalStore,
    private readonly index: ISignalIndex,
  ) {}

  async rebuild(): Promise<{ replayed: number; opened: number; closed: number }> {
    let replayed = 0
    let opened = 0
    let closed = 0

    for await (const record of this.store.replay()) {
      replayed++
      if (record.kind === 'signal') {
        this.index.add(record.record)
        opened++
        continue
      }

      // record.kind === 'update'
      const update = record.record
      if (!CLOSING_UPDATE_TYPES.has(update.updateType)) continue

      const signal =
        (update.linkedExternalMessageId
          ? this.index.findByLinkedExternalId(update.linkedExternalMessageId)
          : null) ??
        (update.externalMessageId
          ? this.index.findByExternalId(update.externalMessageId)
          : null) ??
        (update.linkedSignalId
          ? findById(this.index, update.linkedSignalId)
          : null)

      if (!signal) {
        logger.debug(
          {
            updateId: update.id,
            updateType: update.updateType,
            linkedExternalMessageId: update.linkedExternalMessageId,
            externalMessageId: update.externalMessageId,
            linkedSignalId: update.linkedSignalId,
          },
          'SignalIndexBuilder: closing update has no resolvable signal in current open set, skipping',
        )
        continue
      }

      this.index.markClosed(signal.id)
      closed++
    }

    logger.info(
      { replayed, opened, closed, openNow: opened - closed },
      'SignalIndexBuilder: replay complete',
    )

    return { replayed, opened, closed }
  }
}

/**
 * `ISignalIndex` does not expose `findById` directly. We reach it via
 * `findByExternalId` for the open set; if a stored update carries
 * `linkedSignalId` (set by UpdateLinker after a successful link in a prior
 * run), we still need a way to look up the signal during replay. Since the
 * authoritative `bySignalId` map is private, we settle for a no-op fallback
 * here — `linkedSignalId` is informational on disk and not strictly needed
 * for replay correctness because every update was linked through the
 * external-id paths the index supports anyway.
 */
function findById(_index: ISignalIndex, _signalId: string): null {
  return null
}
