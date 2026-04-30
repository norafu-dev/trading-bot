import { describe, it, expect, beforeEach } from 'vitest'
import type { IKolRegistry } from '../../kol/types.js'
import type { FilterContext } from '../pre-pipeline/types.js'
import { MessagePrePipeline } from '../pre-pipeline/index.js'
import { EventTypeFilter } from '../pre-pipeline/filters/event-type-filter.js'
import { AuthorFilter } from '../pre-pipeline/filters/author-filter.js'
import { DuplicateFilter } from '../pre-pipeline/filters/duplicate-filter.js'
import { NoiseFilter } from '../pre-pipeline/filters/noise-filter.js'
import { makeKolConfig, makeMessage, resetSeq } from './helpers.js'

// ── Minimal stub KolRegistry ──────────────────────────────────────────────────

function makeRegistry(enabled: Record<string, boolean>): IKolRegistry {
  return {
    get: (id: string) => {
      if (id in enabled) {
        return makeKolConfig({ id, enabled: enabled[id] })
      }
      return null
    },
    list: () => [],
    onChange: () => {},
    onReloadFailed: () => {},
    watch: () => {},
    close: () => {},
    load: async () => {},
  }
}

function makeCtx(
  registry: IKolRegistry,
  seenIds: string[] = [],
): FilterContext {
  return {
    kolRegistry: registry,
    recentMessageIds: new Set(seenIds),
    now: new Date(),
  }
}

beforeEach(() => resetSeq())

// ── EventTypeFilter ───────────────────────────────────────────────────────────

describe('EventTypeFilter', () => {
  const filter = new EventTypeFilter()
  const ctx = makeCtx(makeRegistry({}))

  it('passes create events', () => {
    const result = filter.apply(makeMessage({ eventType: 'create' }), ctx)
    expect(result.pass).toBe(true)
  })

  it('drops update events', () => {
    const result = filter.apply(makeMessage({ eventType: 'update' }), ctx)
    expect(result.pass).toBe(false)
    if (!result.pass) expect(result.reason).toBe('not_a_create_event')
  })
})

// ── AuthorFilter ──────────────────────────────────────────────────────────────

describe('AuthorFilter', () => {
  const filter = new AuthorFilter()

  it('passes a trusted, enabled KOL', () => {
    const ctx = makeCtx(makeRegistry({ 'kol-alpha': true }))
    const result = filter.apply(makeMessage({ authorId: 'kol-alpha' }), ctx)
    expect(result.pass).toBe(true)
  })

  it('drops an unknown author', () => {
    const ctx = makeCtx(makeRegistry({}))
    const result = filter.apply(makeMessage({ authorId: 'unknown' }), ctx)
    expect(result.pass).toBe(false)
    if (!result.pass) expect(result.reason).toBe('author_not_trusted')
  })

  it('drops a disabled KOL', () => {
    const ctx = makeCtx(makeRegistry({ 'kol-beta': false }))
    const result = filter.apply(makeMessage({ authorId: 'kol-beta' }), ctx)
    expect(result.pass).toBe(false)
    if (!result.pass) expect(result.reason).toBe('author_not_trusted')
  })
})

// ── DuplicateFilter ───────────────────────────────────────────────────────────

describe('DuplicateFilter', () => {
  const filter = new DuplicateFilter()

  it('passes a new message ID', () => {
    const ctx = makeCtx(makeRegistry({}), [])
    const result = filter.apply(makeMessage({ messageId: 'msg-fresh' }), ctx)
    expect(result.pass).toBe(true)
  })

  it('drops a duplicate message ID', () => {
    const ctx = makeCtx(makeRegistry({}), ['msg-seen'])
    const result = filter.apply(makeMessage({ messageId: 'msg-seen' }), ctx)
    expect(result.pass).toBe(false)
    if (!result.pass) expect(result.reason).toBe('duplicate_message_id')
  })
})

// ── NoiseFilter ───────────────────────────────────────────────────────────────

describe('NoiseFilter', () => {
  const filter = new NoiseFilter()
  const ctx = makeCtx(makeRegistry({}))

  it('passes a message with real content', () => {
    const result = filter.apply(makeMessage({ content: 'LONG BTC 94000' }), ctx)
    expect(result.pass).toBe(true)
  })

  it('drops a fully empty message with no embeds or attachments', () => {
    const result = filter.apply(makeMessage({ content: '   ', embeds: [], attachments: [] }), ctx)
    expect(result.pass).toBe(false)
    if (!result.pass) expect(result.reason).toBe('noise_empty')
  })

  it('drops a separator-only message', () => {
    for (const sep of ['---', '===', '***', '~~~~']) {
      const result = filter.apply(makeMessage({ content: sep }), ctx)
      expect(result.pass).toBe(false)
      if (!result.pass) expect(result.reason).toBe('noise_separator')
    }
  })

  it('passes a separator-only message that also has embeds', () => {
    const result = filter.apply(
      makeMessage({
        content: '---',
        embeds: [{ fields: [{ name: 'Entry', value: '94000' }] }],
      }),
      ctx,
    )
    expect(result.pass).toBe(true)
  })

  it('passes an image-only message (no content, has attachments)', () => {
    const result = filter.apply(
      makeMessage({
        content: '',
        embeds: [],
        attachments: [{ url: 'https://cdn.discordapp.com/chart.png', name: 'chart.png', contentType: 'image/png' }],
      }),
      ctx,
    )
    expect(result.pass).toBe(true)
  })
})

// ── MessagePrePipeline (integrated) ──────────────────────────────────────────

describe('MessagePrePipeline', () => {
  const pipeline = new MessagePrePipeline([
    new EventTypeFilter(),
    new AuthorFilter(),
    new DuplicateFilter(),
    new NoiseFilter(),
  ])

  it('passes a valid message through all filters', async () => {
    const ctx = makeCtx(makeRegistry({ 'kol-alpha': true }))
    const result = await pipeline.process(makeMessage(), ctx)
    expect(result.pass).toBe(true)
  })

  it('short-circuits on the first failing filter', async () => {
    const ctx = makeCtx(makeRegistry({ 'kol-alpha': true }))
    // event-type check comes first
    const result = await pipeline.process(makeMessage({ eventType: 'update' }), ctx)
    expect(result.pass).toBe(false)
    if (!result.pass) expect(result.reason).toBe('not_a_create_event')
  })

  it('drops noise even when author and event type are valid', async () => {
    const ctx = makeCtx(makeRegistry({ 'kol-alpha': true }))
    const result = await pipeline.process(makeMessage({ content: '---' }), ctx)
    expect(result.pass).toBe(false)
    if (!result.pass) expect(result.reason).toBe('noise_separator')
  })
})
