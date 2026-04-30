import type { RawMessage } from '../../types.js'
import type { FilterContext, FilterResult, IMessageFilter } from '../types.js'

/**
 * Drops messages whose author is not a trusted, enabled KOL.
 *
 * A message passes when the authorId appears in the registry AND
 * the corresponding KolConfig has `enabled: true`.
 */
export class AuthorFilter implements IMessageFilter {
  readonly name = 'AuthorFilter'

  apply(message: RawMessage, ctx: FilterContext): FilterResult {
    const kol = ctx.kolRegistry.get(message.authorId)
    if (kol === null || !kol.enabled) {
      return { pass: false, reason: 'author_not_trusted' }
    }
    return { pass: true }
  }
}
