import type { RawMessage } from '../types.js'

/**
 * Controls the sliding-window behaviour of the message aggregator.
 *
 * A window stays open as long as new messages arrive within `idleTimeoutMs`.
 * If a single KOL posts non-stop, `maxDurationMs` forces the window closed.
 * Both values can be overridden per-KOL via `perKolOverrides`.
 */
export interface AggregatorConfig {
  /**
   * Milliseconds of silence before the window closes and emits a bundle.
   * Default: 30_000 (30 seconds).
   * Bot KOLs that post one self-contained message should use ~1_000ms.
   */
  idleTimeoutMs: number

  /**
   * Hard upper bound on window duration in milliseconds.
   * Prevents a chatty KOL from holding a window open indefinitely.
   * Default: 120_000 (2 minutes).
   */
  maxDurationMs: number

  /**
   * Per-KOL overrides keyed by Discord authorId.
   * Only `idleTimeoutMs` and `maxDurationMs` can be overridden.
   */
  perKolOverrides?: Record<
    string,
    Partial<Pick<AggregatorConfig, 'idleTimeoutMs' | 'maxDurationMs'>>
  >
}

/**
 * Why an aggregator window was closed.
 * Recorded on `MessageBundle.closeReason` so operators can diagnose
 * whether bundles are closing cleanly or being forced.
 */
export type BundleCloseReason =
  | 'idle_timeout'   // Normal: no new messages arrived within idleTimeoutMs
  | 'max_duration'   // Safety net: window hit the maxDurationMs hard cap
  | 'forced_flush'   // Graceful shutdown: flushAll() was called

/**
 * A cohesive group of temporally-related messages from a single KOL in a
 * single channel, emitted by the aggregator as a unit to the parser.
 *
 * The bundle is the parser's atomic unit of work: everything needed to
 * produce a `ParseResult` is contained here.
 *
 * Bundles are never merged across channels — even if two channels belong to
 * the same KOL (via `linkedChannelIds`). Cross-channel association is the
 * responsibility of the `UpdateLinker`, not the aggregator.
 */
export interface MessageBundle {
  /** ULID — globally unique, monotonically sortable. */
  id: string

  /** Discord authorId of the KOL who sent all messages in this bundle. */
  kolId: string

  /** Discord channelId where these messages were posted. */
  channelId: string

  /** All messages in the bundle, ordered chronologically (oldest first). */
  messages: RawMessage[]

  /** ISO 8601 — when the first message arrived and the window opened. */
  openedAt: string

  /** ISO 8601 — when the window closed and this bundle was emitted. */
  closedAt: string

  closeReason: BundleCloseReason
}

/**
 * Per-KOL sliding-window message aggregator.
 *
 * Ingest individual messages and receive `MessageBundle` objects via the
 * `onBundleClosed` callback when windows close. The aggregator maintains
 * one independent window per `(kolId, channelId)` pair.
 */
export interface IMessageAggregator {
  /**
   * Accept a message. Opens a new window for the KOL if none exists,
   * or resets the idle timer on the existing window.
   */
  ingest(message: RawMessage): Promise<void>

  /**
   * Register a callback to be called each time a bundle's window closes.
   * Multiple handlers are supported; called in registration order.
   * Callbacks must not throw — wrap errors internally.
   */
  onBundleClosed(handler: (bundle: MessageBundle) => Promise<void>): void

  /**
   * Immediately close all open windows and emit their bundles.
   * Must be awaited during graceful shutdown to avoid losing in-flight data.
   */
  flushAll(): Promise<void>

  /**
   * Replace the per-KOL overrides at runtime. Used by the pipeline when
   * `data/kols/kols.json` changes (KolRegistry watcher fires) so a
   * dashboard edit takes effect on the next message without a process
   * restart. Already-open windows keep their original timers — only
   * windows opened AFTER this call use the new values.
   */
  updatePerKolOverrides(
    overrides: NonNullable<AggregatorConfig['perKolOverrides']>,
  ): void
}
