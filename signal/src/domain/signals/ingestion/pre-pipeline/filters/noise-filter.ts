import type { RawMessage } from '../../types.js'
import type { FilterContext, FilterResult, IMessageFilter } from '../types.js'

// Matches lines that are pure separator decoration: 3+ of the same char (-, =, *, ~, _)
const SEPARATOR_RE = /^[-=*~_]{3,}$/

/**
 * Drops messages that carry no signal-relevant content.
 *
 * Two cases:
 * - `noise_empty`: after stripping whitespace, `content` is empty AND
 *   there are no embeds with non-empty description/fields AND
 *   there are no attachments.
 * - `noise_separator`: content (trimmed) is only a separator line AND
 *   no embeds or attachments are present.
 *
 * Messages with embeds or attachments are never classified as noise —
 * bot KOLs may post image-only or embed-only messages.
 */
export class NoiseFilter implements IMessageFilter {
  readonly name = 'NoiseFilter'

  apply(message: RawMessage, _ctx: FilterContext): FilterResult {
    const hasAttachments = message.attachments.length > 0
    const hasEmbeds = message.embeds.some(
      (e) =>
        (e.description !== undefined && e.description.trim().length > 0) ||
        e.fields.length > 0,
    )

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
