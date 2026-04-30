import type { RawMessage } from '../types.js'
import type { FilterContext, FilterResult, IMessageFilter, IMessagePrePipeline } from './types.js'
import { EventTypeFilter } from './filters/event-type-filter.js'
import { AuthorFilter } from './filters/author-filter.js'
import { DuplicateFilter } from './filters/duplicate-filter.js'
import { NoiseFilter } from './filters/noise-filter.js'

/**
 * Composes a fixed, ordered list of filters into a single pipeline.
 *
 * Runs each filter in registration order, short-circuiting on the first
 * failure. The caller is responsible for providing the FilterContext on each
 * call — the pipeline itself holds no per-message state.
 */
export class MessagePrePipeline implements IMessagePrePipeline {
  private readonly filters: IMessageFilter[]

  constructor(filters: IMessageFilter[]) {
    this.filters = filters
  }

  async process(message: RawMessage, ctx: FilterContext): Promise<FilterResult> {
    for (const filter of this.filters) {
      const result = await filter.apply(message, ctx)
      if (!result.pass) {
        return result
      }
    }
    return { pass: true }
  }
}

/**
 * Build the default pre-pipeline with the standard filter order:
 * event-type → author → duplicate → noise.
 *
 * Cheap O(1) checks (event-type, author, duplicate) come before
 * pattern-matching (noise) to minimise work on common drop cases.
 */
export function createDefaultPrePipeline(): MessagePrePipeline {
  return new MessagePrePipeline([
    new EventTypeFilter(),
    new AuthorFilter(),
    new DuplicateFilter(),
    new NoiseFilter(),
  ])
}
