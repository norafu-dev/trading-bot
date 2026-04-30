import type { RawMessage } from '../../types.js'
import type { FilterContext, FilterResult, IMessageFilter } from '../types.js'

export class EventTypeFilter implements IMessageFilter {
  readonly name = 'EventTypeFilter'

  apply(message: RawMessage, _ctx: FilterContext): FilterResult {
    if (message.eventType !== 'create') {
      return { pass: false, reason: 'not_a_create_event' }
    }
    return { pass: true }
  }
}
