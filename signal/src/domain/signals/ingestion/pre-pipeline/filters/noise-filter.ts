import type { RawMessage } from '../../types.js'
import type { FilterContext, FilterResult, IMessageFilter } from '../types.js'

// Matches lines that are pure separator decoration: 3+ of the same char (-, =, *, ~, _)
const SEPARATOR_RE = /^[-=*~_]{3,}$/

/**
 * "Edit notice" pattern — some channels run a translation/forwarding bot
 * that re-posts edited messages as new ones, prefixed with "✏️ **已编辑**".
 * These look like real new messages to Discord (event=create, has embed)
 * but they're noise for our pipeline: the original message was already
 * processed, and the re-post would bias the LLM with the *quoted* version
 * of the prior signal. We discard them outright.
 *
 * Match is case-insensitive on "已编辑" / "edited" so it covers both the
 * Chinese and English flavours of the same forwarder bots.
 */
const EDIT_NOTICE_RE = /✏️\s*\*?\*?(?:已编辑|edited)/i

/**
 * Drops messages that carry no signal-relevant content.
 *
 * Cases:
 * - `noise_empty`: after stripping whitespace, `content` is empty AND
 *   there are no embeds with non-empty description/fields AND
 *   there are no attachments.
 * - `noise_separator`: content (trimmed) is only a separator line AND
 *   no embeds or attachments are present.
 * - `noise_edit_notice`: every embed in the message looks like an
 *   "edit re-post" notification from a translation bot (and there are
 *   no attachments). The original message was already processed by the
 *   pipeline; the re-post would just confuse downstream LLM context.
 */
export class NoiseFilter implements IMessageFilter {
  readonly name = 'NoiseFilter'

  apply(message: RawMessage, _ctx: FilterContext): FilterResult {
    const hasAttachments = message.attachments.length > 0
    const embedsWithBody = message.embeds.filter(
      (e) =>
        (e.description !== undefined && e.description.trim().length > 0) ||
        e.fields.length > 0,
    )
    const hasEmbeds = embedsWithBody.length > 0

    // Edit-notice check: only when there are embeds AND every one of them
    // is an edit notice. A normal signal embed should never match this.
    if (
      !hasAttachments &&
      hasEmbeds &&
      embedsWithBody.every((e) => EDIT_NOTICE_RE.test(e.description ?? ''))
    ) {
      return { pass: false, reason: 'noise_edit_notice' }
    }

    if (hasAttachments || hasEmbeds) {
      return { pass: true }
    }

    const trimmed = message.content.trim()

    if (trimmed.length === 0) {
      return { pass: false, reason: 'noise_empty' }
    }

    if (SEPARATOR_RE.test(trimmed)) {
      return { pass: false, reason: 'noise_separator' }
    }

    return { pass: true }
  }
}
