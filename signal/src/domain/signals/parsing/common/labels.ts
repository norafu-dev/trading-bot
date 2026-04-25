/**
 * Coarse-grained classification label assigned to a `MessageBundle` by the
 * classifier stage of the LLM pipeline.
 *
 * The classifier's only job is to route the bundle to the right path:
 * - `new_signal` / `position_update` → proceed to the extractor
 * - everything else → discard immediately
 *
 * Fine-grained classification (e.g., distinguishing `tp_hit` from `sl_move`)
 * happens in the extractor's `updateType` field — not here.
 *
 * This is a closed enum: the LLM is constrained to return exactly one of
 * these values. If uncertain, it should pick the closest match and report
 * low confidence rather than inventing a new label.
 */
export type ClassificationLabel =
  | 'new_signal'        // New entry intent (open or add to position)
  | 'position_update'   // Any update to an existing open position
  | 'chitchat'          // Casual conversation, reactions, greetings
  | 'advertisement'     // Affiliate links, promo codes, referrals
  | 'education'         // Market theory, tutorials, explanatory content
  | 'stream_notice'     // Live stream announcements or reminders
  | 're_entry_hint'     // Informal suggestion to re-enter; no actionable fields
  | 'macro_analysis'    // Broad market outlook without a specific trade call
  | 'recap'             // Win/loss recap, performance bragging
