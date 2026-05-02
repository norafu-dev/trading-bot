import type { Signal } from '../../../../../shared/types.js'
import type { EventLog } from '../../../core/event-log.js'
import { logger } from '../../../core/logger.js'
import type { ISignalIndex } from '../linking/types.js'
import type { UpdateLinker } from '../linking/update-linker.js'
import type { ISignalStore } from '../persistence/signal-store.js'
import type { ParseResult } from '../parsing/types.js'

/**
 * Update types whose semantics close out a position. Mirrors the set used
 * by `SignalIndexBuilder` so persisted state and live state stay in sync.
 */
const CLOSING_UPDATE_TYPES = new Set([
  'sl_hit',
  'full_close',
  'breakeven_hit',
  'manual_close',
])

// ── Event payload shapes (loose; emitted to events.jsonl for downstream UIs) ──

export interface SignalParsedEvent {
  signalId: string
  kolId: string
  bundleId: string
  symbol: string
  parserType: string
  confidence: number
}

export interface UpdateLinkedEvent {
  updateId: string
  signalId: string
  bundleId: string
  kolId: string
  updateType: string
  linkConfidence: 'exact' | 'inferred'
  closedSignal: boolean
}

export interface UpdateUnlinkedEvent {
  updateId: string
  bundleId: string
  kolId: string
  updateType: string
  reason: string
}

export interface ParseDiscardedEvent {
  bundleId: string
  kolId: string
  reason: string
}

export interface ParseFailedEvent {
  bundleId: string
  kolId: string
  errorCode: string
  message: string
  retriable: boolean
}

/**
 * Routes `ParseResult` outputs into persistence + the live signal index
 * + the event log. Pure plumbing — no business decisions live here. The
 * router is the **only** place that calls `SignalStore.append*` and
 * `SignalIndex.add` / `markClosed` for live (non-replay) traffic.
 *
 * Same set of close-triggering updateTypes as `SignalIndexBuilder` so a
 * crash-replay produces an index identical to the one held in memory at
 * crash time.
 */
/**
 * Optional copy-trading hook called after a Signal is persisted +
 * indexed. ResultRouter doesn't depend on the engine's full surface —
 * just a single async fn — so the trading layer can be wired in or
 * left out (tests, dev mode without a CCXT account) without touching
 * this file.
 */
export type CopyTradingHook = (signal: Signal) => Promise<void>

export class ResultRouter {
  constructor(
    private readonly store: ISignalStore,
    private readonly linker: UpdateLinker,
    private readonly index: ISignalIndex,
    private readonly events: EventLog,
    private readonly copyTradingHook?: CopyTradingHook,
  ) {}

  async route(result: ParseResult): Promise<void> {
    if (result.kind === 'signal') {
      await this.handleSignal(result)
      return
    }
    if (result.kind === 'update') {
      await this.handleUpdate(result)
      return
    }
    if (result.kind === 'discarded') {
      await this.events.append<ParseDiscardedEvent>('parse.discarded', {
        bundleId: result.meta.bundleId,
        kolId: result.meta.kolId,
        reason: result.reason,
      })
      return
    }
    // result.kind === 'failed'
    await this.events.append<ParseFailedEvent>('parse.failed', {
      bundleId: result.meta.bundleId,
      kolId: result.meta.kolId,
      errorCode: result.error.code,
      message: result.error.message,
      retriable: result.error.retriable,
    })
  }

  private async handleSignal(result: Extract<ParseResult, { kind: 'signal' }>): Promise<void> {
    const signal = result.signal
    await this.store.appendSignal(signal)
    this.index.add(signal)
    await this.events.append<SignalParsedEvent>('signal.parsed', {
      signalId: signal.id,
      kolId: signal.kolId,
      bundleId: signal.bundleId,
      symbol: signal.symbol,
      parserType: signal.parserType,
      confidence: signal.confidence,
    })

    // Hand off to copy-trading engine. Failures here must NEVER block
    // the signal pipeline — a sizing error is downstream from "we
    // successfully parsed this signal".
    if (this.copyTradingHook) {
      try {
        await this.copyTradingHook(signal)
      } catch (err) {
        logger.error(
          { err, signalId: signal.id, kolId: signal.kolId },
          'ResultRouter: copy-trading hook threw — signal still persisted',
        )
      }
    }
  }

  private async handleUpdate(result: Extract<ParseResult, { kind: 'update' }>): Promise<void> {
    const update = result.update
    const linkResult = this.linker.link(update, this.index)

    if (linkResult.linked) {
      // Mutate the update in-place to record the link before persisting.
      // This is the only mutation of the parser output; downstream code
      // (storage, events, index) sees a consistent record.
      update.linkedSignalId = linkResult.signalId

      // Decide whether this update fully closes the position
      const isClose = CLOSING_UPDATE_TYPES.has(update.updateType)
      if (isClose) this.index.markClosed(linkResult.signalId)

      await this.store.appendUpdate(update)
      await this.events.append<UpdateLinkedEvent>('update.linked', {
        updateId: update.id,
        signalId: linkResult.signalId,
        bundleId: update.bundleId,
        kolId: update.kolId,
        updateType: update.updateType,
        linkConfidence: linkResult.confidence,
        closedSignal: isClose,
      })
      return
    }

    // Unlinked: still persist (audit trail) but emit a distinct event so
    // operators can spot the orphan. No trade action will be triggered.
    logger.warn(
      {
        updateId: update.id,
        bundleId: update.bundleId,
        kolId: update.kolId,
        symbol: update.symbol,
        updateType: update.updateType,
        reason: linkResult.reason,
      },
      'ResultRouter: position update could not be linked to any open signal',
    )
    await this.store.appendUpdate(update)
    await this.events.append<UpdateUnlinkedEvent>('update.unlinked', {
      updateId: update.id,
      bundleId: update.bundleId,
      kolId: update.kolId,
      updateType: update.updateType,
      reason: linkResult.reason,
    })
  }
}
