import { z } from 'zod'

/**
 * The closed set of values the extractor can emit for `updateType`.
 *
 * Most values map 1:1 to `PositionUpdate.updateType` in shared/types.ts.
 * Two values are extractor-internal sentinels — the parser implementation
 * intercepts them and converts to a DiscardReason before assembling a
 * PositionUpdate:
 *
 *   're_entry_hint' → DiscardReason 're_entry_hint'
 *   'other'         → DiscardReason 'update_unclassifiable'
 *
 * Neither sentinel ever reaches the output PositionUpdate.updateType.
 */
export const updateTypeSchema = z.enum([
  'limit_filled',    // A limit order was filled/activated
  'tp_hit',          // A take-profit level was triggered
  'sl_hit',          // Stop loss was triggered (position closed at a loss)
  'breakeven_move',  // Stop loss moved to entry price (protecting capital)
  'breakeven_hit',   // The breakeven stop was subsequently hit
  'manual_close',    // KOL is closing the position manually (e.g. "Taking TP here")
  'full_close',      // Entire position closed (profit or loss), explicit announcement
  'runner_close',    // Only the trailing runner portion was closed
  'stop_modified',   // Stop price changed to a non-breakeven value
  // ── extractor-internal sentinels (intercepted by parser; never in PositionUpdate) ──
  're_entry_hint',   // Informal re-entry suggestion; no executable fields → discard
  'other',           // Could not classify → discard
])

export type UpdateType = z.infer<typeof updateTypeSchema>

/**
 * Zod schema for the fields an extractor (LLM or regex) can populate for a
 * position update message.
 *
 * Pipeline metadata added AFTER extraction (id, kolId, bundleId, receivedAt,
 * source, channelId, parserType, rawBundle) is NOT in this schema.
 *
 * All price / percentage values are Decimal strings.
 */
export const positionUpdateExtractSchema = z.object({
  /**
   * Discord messageId of the update message itself.
   * Used as a stable external identifier for this update event.
   */
  externalMessageId: z.string().optional(),

  /**
   * Discord messageId of the original signal this update refers to.
   * Extracted from the hyperlink embedded in bot-format update messages
   * (e.g., the URL inside `[**BTC**](https://discord.com/channels/…/msgId)`).
   * Used by the `by_external_id` LinkStrategy to associate this update with
   * the original Signal.
   */
  linkedExternalMessageId: z.string().optional(),

  updateType: updateTypeSchema,

  /**
   * Which TP level was hit.
   * Only meaningful when `updateType === 'tp_hit'`.
   * 1 = TP1, 2 = TP2, etc.
   */
  level: z.number().int().min(1).optional(),

  /**
   * Percentage of the position that was closed in this update.
   * Decimal string (e.g., "50" means 50%).
   * Meaningful for 'tp_hit', 'manual_close', 'full_close', 'runner_close'.
   */
  closedPercent: z.string().optional(),

  /**
   * Percentage of the position still open after this update.
   * Decimal string (e.g., "50" means 50% remaining).
   */
  remainingPercent: z.string().optional(),

  /**
   * New stop-loss price after a 'stop_modified' or 'breakeven_move' update.
   * Decimal string. Only set when `updateType` involves a stop change.
   */
  newStopLoss: z.string().optional(),

  /**
   * Price at which the KOL reports closing (for manual/TP closes).
   * Example: "0.13754" from "Taking TP2 on HUSDT here at 0.13754".
   * Decimal string.
   */
  realizedPriceRef: z.string().optional(),

  /**
   * Realised risk/reward ratio reported by the KOL or bot.
   * Signed Decimal string: "1.89" for a profit, "-1.00" for a full stop.
   */
  realizedRR: z.string().optional(),

  /**
   * LLM's self-assessed confidence in this extraction [0, 1].
   * RegexParser always sets 1.0.
   */
  confidence: z.number().min(0).max(1),

  // NOTE: `extractedFrom` is intentionally NOT in this schema — see
  // signal-schema.ts for the rationale.

  /**
   * LLM chain-of-thought reasoning.
   * Stored for prompt-engineering audits only; never displayed to end users.
   * Min 20 chars to keep audit logs useful for prompt iteration.
   */
  reasoning: z.string().min(20).optional(),
})

/** TypeScript type inferred from `positionUpdateExtractSchema`. */
export type PositionUpdateExtract = z.infer<typeof positionUpdateExtractSchema>
