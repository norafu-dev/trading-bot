import type { Signal, PositionUpdate } from '../../../../../shared/types.js'

/**
 * The strategy used to associate a `PositionUpdate` with its originating `Signal`.
 *
 * Two strategies exist because KOLs embed the link differently:
 * - Bot KOLs embed the original Discord message URL directly in the update text.
 * - Human KOLs use natural language ("TP hit on BTC") with no explicit back-link.
 */
export type LinkStrategy = 'by_external_id' | 'by_kol_symbol'

/**
 * Result of an attempt to link a `PositionUpdate` to a `Signal`.
 *
 * `linked: false` is a legitimate outcome — the update is recorded as an
 * event (signal.unlinked_update) but triggers NO trade action.
 * It must never be silently dropped or randomly matched.
 */
export type LinkResult =
  | {
      linked: true
      signalId: string
      /**
       * How confident we are in the association:
       * - 'exact'    → found by Discord messageId (deterministic, always correct)
       * - 'inferred' → found by KOL + symbol heuristic (may be ambiguous)
       */
      confidence: 'exact' | 'inferred'
    }
  | {
      linked: false
      /** Human-readable reason why no link was established. */
      reason: string
    }

/**
 * A single link strategy implementation.
 * Strategies are tried in priority order by `UpdateLinker`.
 */
export interface ILinkStrategy {
  readonly name: LinkStrategy

  /**
   * Attempt to find a matching Signal for the given update.
   * Must not throw — return `{ linked: false }` on any error.
   */
  tryLink(update: PositionUpdate, index: ISignalIndex): LinkResult
}

/**
 * In-memory index of still-open signals.
 *
 * Persistence: the index is rebuilt from `data/signals/signals.jsonl` on
 * process startup, so crash recovery does not lose linkability.
 * Signals are removed from the index only when explicitly marked closed.
 *
 * Why a separate index rather than querying the JSONL directly?
 * Hot-path performance: update messages can arrive multiple times per minute
 * and each needs an O(1) lookup — sequential file scan is not acceptable.
 */
export interface ISignalIndex {
  /**
   * Look up a signal by the Discord messageId of the message that
   * originated the signal (stored in `Signal.messageId`).
   *
   * Used by the `by_external_id` strategy as the fallback lookup path.
   * Returns null when no signal with that externalId is currently open.
   */
  findByExternalId(messageId: string): Signal | null

  /**
   * Look up a signal by `Signal.linkedExternalMessageId` — the Discord
   * message ID embedded in bot-format signal URLs. This is the primary lookup
   * path for bot KOLs (DEC-016): updates reference the original source message
   * ID, not the forwarded message that `Signal.messageId` records.
   *
   * Returns null when no open signal has that linkedExternalMessageId.
   */
  findByLinkedExternalId(messageId: string): Signal | null

  /**
   * Find all currently open signals from a specific KOL for a specific symbol.
   * Results are ordered by `parsedAt` descending (most recent first).
   *
   * Used by the `by_kol_symbol` strategy.
   * Returns an empty array when no matching open signals exist.
   * The caller is responsible for disambiguation when multiple signals match.
   */
  findOpenByKolAndSymbol(
    kolId: string,
    symbol: string,
    /** Only consider signals parsed at or before this timestamp. */
    before: Date,
  ): Signal[]

  /**
   * Register a new signal in the index.
   * Called by the result router immediately after a successful parse.
   */
  add(signal: Signal): void

  /**
   * Remove a signal from the open set.
   * Called when a position is fully closed (all units exited).
   * Closed signals are no longer findable by `findByExternalId`,
   * `findByLinkedExternalId`, or `findOpenByKolAndSymbol` — preventing
   * stale linkage after re-entry.
   */
  markClosed(signalId: string): void
}
