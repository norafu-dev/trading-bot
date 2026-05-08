import type { RawMessage } from '../../types.js'
import type { FilterContext, FilterResult, IMessageFilter } from '../types.js'

// Matches lines that are pure separator decoration: 3+ of the same char (-, =, *, ~, _)
const SEPARATOR_RE = /^[-=*~_]{3,}$/

/**
 * "Edit notice" pattern — some channels run a translation/forwarding bot
 * that re-posts edited messages as new ones, prefixed with "✏️ **已编辑**"
 * followed by a quoted excerpt of the original. These look like real new
 * messages to Discord (event=create, has embed) but they're noise for
 * our pipeline.
 *
 * IMPORTANT: a previous regex did substring-match on the whole embed,
 * which dropped LEGITIMATE re-posts of edited signals where the
 * forwarder bot kept the full updated body after the "已编辑" header.
 * `isPureEditNotice` now requires the embed to start with the marker
 * AND have nothing of substance after the leading quote block — that
 * narrows discards to true notice-only re-posts.
 */
const EDIT_NOTICE_PREFIX_RE = /^\s*✏️\s*\*{0,2}\s*(?:已编辑|edited)/i

function isPureEditNotice(description: string): boolean {
  if (!EDIT_NOTICE_PREFIX_RE.test(description)) return false
  // Strip the marker line plus any contiguous Discord quote lines (`> ...`)
  // that immediately follow it. What's left should be the message body.
  const lines = description.split('\n')
  let i = 0
  // Drop the leading marker line(s)
  while (i < lines.length && (EDIT_NOTICE_PREFIX_RE.test(lines[i]) || lines[i].trim() === '')) i++
  // Drop the quoted-original block
  while (i < lines.length && (/^\s*>/.test(lines[i]) || lines[i].trim() === '')) i++
  const remainder = lines.slice(i).join('\n').trim()
  // If <30 chars of body remain, treat as pure notice. A real edited
  // signal re-post will have hundreds of characters here.
  return remainder.length < 30
}

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

    // Edit-notice check: drop when every embed is a PURE edit notice
    // (marker + quoted excerpt only). Embeds that start with the
    // ✏️ marker but contain a full re-posted signal body are kept —
    // see isPureEditNotice for the exact heuristic.
    if (
      !hasAttachments &&
      hasEmbeds &&
      embedsWithBody.every((e) => isPureEditNotice(e.description ?? ''))
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
