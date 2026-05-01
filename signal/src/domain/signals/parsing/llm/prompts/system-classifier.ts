import type { KolConfig } from '../../../../../../../shared/types.js'

/**
 * Builds the system prompt for the classifier stage.
 *
 * The classifier's sole job is to assign one coarse label to a bundle
 * without extracting any fields. It must not hallucinate trade intent
 * from ambiguous text — when uncertain it should report low confidence.
 */
export function buildClassifierSystemPrompt(kol: KolConfig): string {
  const sections: string[] = []

  sections.push(`\
You are a classifier for trading signals posted in a private Discord group.
Your only task is to assign exactly one label from the list below to the given message.
Do NOT extract trade parameters — that is a separate step.

## Labels

new_signal       — A new entry intent: opening or adding to a position (long/short, spot/perp).
position_update  — An update to an EXISTING open position: TP hit, SL hit, stop moved, manual close, limit filled, etc.
chitchat         — Casual conversation, reactions, greetings, memes, off-topic.
advertisement    — Affiliate links, promo codes, referral invitations, exchange promotions.
education        — Market theory, trading tutorials, chart-reading lessons.
stream_notice    — Live-stream announcements, reminders, or countdowns.
re_entry_hint    — An informal suggestion to re-enter a trade; no concrete entry/SL/TP fields given.
macro_analysis   — Broad market outlook, macro commentary, no specific trade call.
recap            — Performance summary, win/loss recap, portfolio review.

## Rules

1. Classify based on CONTENT ONLY — ignore who the author is.
2. If the message could be either new_signal or position_update, prefer position_update when it references an existing trade.
3. If the message is primarily a new entry but also mentions closing a prior position, label it new_signal.
4. Return low confidence (<0.6) when genuinely ambiguous rather than guessing.
5. Chain-of-thought reasoning is required — think step by step before committing to a label.`)

  // Inject per-KOL style hint if present
  if (kol.parsingHints?.style) {
    sections.push(`## KOL Style Note\n\n${kol.parsingHints.style}`)
  }

  // Inject vocabulary map so the classifier can normalise KOL-specific terms
  const vocab = kol.parsingHints?.vocabulary
  if (vocab && Object.keys(vocab).length > 0) {
    const lines = Object.entries(vocab).map(([k, v]) => `  "${k}" → ${v}`)
    sections.push(`## KOL Vocabulary\n\n${lines.join('\n')}`)
  }

  return sections.join('\n\n')
}
