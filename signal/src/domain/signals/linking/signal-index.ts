import type { Signal } from '../../../../../shared/types.js'
import { normalizeSymbol } from '../../../connectors/market/symbol-normalize.js'
import type { ISignalIndex } from './types.js'

/**
 * Reduce a raw symbol string to a comparable key. Normalising both the
 * signal's and the update's symbol means "BIO" (what Neil typed in the
 * open) and "BIOUSDT" (what the LLM read off the BloFin TP receipt
 * card) collapse to the same key "BIO" and link successfully.
 *
 * Falls back to a trimmed-uppercase form so unknown shapes still get a
 * deterministic key (better than throwing or returning null when the
 * normaliser doesn't recognise the format).
 */
function symbolKey(raw: string): string {
  const norm = normalizeSymbol(raw)
  return norm?.base ?? raw.trim().toUpperCase()
}

/**
 * In-memory index of still-open signals, rebuilt from disk on startup.
 *
 * Three look-up paths:
 * - `findByExternalId`:       O(1) by `Signal.messageId` (forwarded message snowflake)
 * - `findByLinkedExternalId`: O(1) by `Signal.linkedExternalMessageId` (DEC-016 bot KOL path)
 * - `findOpenByKolAndSymbol`: O(n) over the open set for a (kolId, symbol) pair
 *
 * Signals are added when the parser emits a Signal, and removed when the
 * position is fully closed (all units exited). Closed signals are no longer
 * findable, preventing stale linkage after re-entry on the same symbol.
 */
export class SignalIndex implements ISignalIndex {
  // keyed by Signal.messageId (forwarded message snowflake)
  private readonly byExternalId = new Map<string, Signal>()
  // keyed by Signal.linkedExternalMessageId (original source message snowflake, bot KOL path)
  private readonly byLinkedExternalId = new Map<string, Signal>()
  // keyed by Signal.id (ULID) — the authoritative store
  private readonly bySignalId = new Map<string, Signal>()

  findByExternalId(messageId: string): Signal | null {
    return this.byExternalId.get(messageId) ?? null
  }

  findByLinkedExternalId(messageId: string): Signal | null {
    return this.byLinkedExternalId.get(messageId) ?? null
  }

  findOpenByKolAndSymbol(
    kolId: string,
    symbol: string,
    before: Date,
  ): Signal[] {
    const targetKey = symbolKey(symbol)
    const results: Signal[] = []
    for (const signal of this.bySignalId.values()) {
      if (
        signal.kolId === kolId &&
        symbolKey(signal.symbol) === targetKey &&
        new Date(signal.parsedAt) <= before
      ) {
        results.push(signal)
      }
    }
    // Most recent first
    results.sort((a, b) => b.parsedAt.localeCompare(a.parsedAt))
    return results
  }

  add(signal: Signal): void {
    this.bySignalId.set(signal.id, signal)
    this.byExternalId.set(signal.messageId, signal)
    if (signal.linkedExternalMessageId) {
      this.byLinkedExternalId.set(signal.linkedExternalMessageId, signal)
    }
  }

  markClosed(signalId: string): void {
    const signal = this.bySignalId.get(signalId)
    if (!signal) return
    this.bySignalId.delete(signalId)
    this.byExternalId.delete(signal.messageId)
    if (signal.linkedExternalMessageId) {
      this.byLinkedExternalId.delete(signal.linkedExternalMessageId)
    }
  }

  /** Current count of open signals (for diagnostics). */
  size(): number {
    return this.bySignalId.size
  }
}
