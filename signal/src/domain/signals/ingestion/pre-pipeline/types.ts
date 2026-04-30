import type { RawMessage } from '../types.js'
import type { IKolRegistry } from '../../kol/types.js'

/**
 * Read-only context injected into every filter by the pipeline orchestrator.
 * Filters must not mutate this object or persist state themselves.
 */
export interface FilterContext {
  /**
   * Live KOL registry. Used by `AuthorFilter` to determine whether a message's
   * author is a trusted, enabled KOL.
   */
  kolRegistry: IKolRegistry

  /**
   * Rolling in-memory set of recently seen message IDs.
   * Used by `DuplicateFilter` to detect re-deliveries without a DB lookup.
   * The pipeline orchestrator is responsible for pruning stale entries.
   */
  recentMessageIds: ReadonlySet<string>

  now: Date
}

/**
 * Why a message was dropped by the pre-pipeline.
 *
 * Reason codes are structured (not free-form strings) so they can be
 * aggregated in metrics and displayed on the dashboard without fragile
 * string parsing.
 */
export type FilterDropReason =
  | 'author_not_trusted'    // AuthorFilter: authorId not in the enabled KOL set
  | 'duplicate_message_id'  // DuplicateFilter: messageId seen within the rolling window
  | 'noise_empty'           // NoiseFilter: text is empty after stripping whitespace
  | 'noise_separator'       // NoiseFilter: text is only a separator line ("---", "===", etc.)
  | 'url_blocklisted'       // UrlBlocklistFilter: text contains a known ad/spam domain
  | 'not_a_create_event'    // EventTypeFilter: eventType is 'update', not 'create'

/**
 * Result of applying a single filter to a message.
 *
 * `pass: true` means "proceed to the next filter".
 * `pass: false` means "drop this message" — no further filters run.
 */
export type FilterResult =
  | { pass: true }
  | { pass: false; reason: FilterDropReason }

/**
 * A single step in the message pre-pipeline.
 *
 * Filters are stateless functions over (message, context) → FilterResult.
 * They must not launch async I/O, mutate the message, or throw exceptions —
 * unexpected errors should be caught and returned as a result instead.
 *
 * Ordering matters: cheap filters (author check, duplicate check) should
 * come before expensive ones (URL pattern matching).
 */
export interface IMessageFilter {
  /** Stable identifier used in logs, metrics, and debug output. */
  readonly name: string

  apply(message: RawMessage, ctx: FilterContext): Promise<FilterResult> | FilterResult
}

/**
 * The composed pre-pipeline that runs a message through all registered
 * filters in order, short-circuiting on the first failure.
 */
export interface IMessagePrePipeline {
  /**
   * Run `message` through all filters with the given context.
   * Returns the first failing result, or `{ pass: true }` if all pass.
   * Context is passed per-call because kolRegistry and recentMessageIds
   * change over the process lifetime.
   */
  process(message: RawMessage, ctx: FilterContext): Promise<FilterResult>
}
