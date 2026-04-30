import type { RawMessage } from '../../types.js'
import type { FilterContext, FilterResult, IMessageFilter } from '../types.js'

/**
 * Drops messages whose messageId is already in the rolling seen-set.
 *
 * The `recentMessageIds` set is owned and pruned by the pipeline orchestrator;
 * this filter only reads it.
 */
export class DuplicateFilter implements IMessageFilter {
  readonly name = 'DuplicateFilter'

  apply(message: RawMessage, ctx: FilterContext): FilterResult {
    if (ctx.recentMessageIds.has(message.messageId)) {
      return { pass: false, reason: 'duplicate_message_id' }
    }
    return { pass: true }
  }
}
