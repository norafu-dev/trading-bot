import { describe, it, expect, beforeEach } from 'vitest'
import type { Signal } from '../../../../../../shared/types.js'
import { SignalIndex } from '../signal-index.js'

let seq = 0
function makeSignal(overrides: Partial<Signal> = {}): Signal {
  seq++
  return {
    id: `sig-${seq}`,
    source: 'discord',
    channelId: 'ch-test',
    messageId: `msg-${seq}`,
    bundleId: `bundle-${seq}`,
    kolId: 'kol-alpha',
    rawText: 'LONG BTC 94000',
    parsedAt: new Date().toISOString(),
    parserType: 'llm_text',
    action: 'open',
    side: 'long',
    symbol: 'BTC',
    confidence: 0.95,
    ...overrides,
  }
}

beforeEach(() => { seq = 0 })

describe('SignalIndex.findByLinkedExternalId() — DEC-016 bot KOL path', () => {
  it('finds a signal by linkedExternalMessageId after add()', () => {
    const index = new SignalIndex()
    const signal = makeSignal({
      messageId: 'forwarded-msg-123',
      linkedExternalMessageId: 'original-wgbot-msg-456',
    })
    index.add(signal)

    expect(index.findByLinkedExternalId('original-wgbot-msg-456')).not.toBeNull()
    expect(index.findByLinkedExternalId('original-wgbot-msg-456')!.id).toBe(signal.id)
  })

  it('returns null for an unknown linkedExternalMessageId', () => {
    const index = new SignalIndex()
    index.add(makeSignal({ linkedExternalMessageId: 'wgbot-abc' }))
    expect(index.findByLinkedExternalId('nonexistent')).toBeNull()
  })

  it('returns null when the signal has no linkedExternalMessageId', () => {
    const index = new SignalIndex()
    index.add(makeSignal({ messageId: 'direct-msg-no-link' }))
    expect(index.findByLinkedExternalId('direct-msg-no-link')).toBeNull()
  })

  it('removes from findByLinkedExternalId after markClosed()', () => {
    const index = new SignalIndex()
    const signal = makeSignal({ linkedExternalMessageId: 'wgbot-to-close' })
    index.add(signal)
    index.markClosed(signal.id)
    expect(index.findByLinkedExternalId('wgbot-to-close')).toBeNull()
  })

  it('does not pollute byExternalId — forwarded and linked IDs are independent', () => {
    const index = new SignalIndex()
    const signal = makeSignal({
      messageId: 'forwarded-111',
      linkedExternalMessageId: 'original-222',
    })
    index.add(signal)

    // findByExternalId only sees Signal.messageId
    expect(index.findByExternalId('forwarded-111')).not.toBeNull()
    expect(index.findByExternalId('original-222')).toBeNull()

    // findByLinkedExternalId only sees Signal.linkedExternalMessageId
    expect(index.findByLinkedExternalId('original-222')).not.toBeNull()
    expect(index.findByLinkedExternalId('forwarded-111')).toBeNull()
  })
})

describe('SignalIndex.add() and findByExternalId()', () => {
  it('finds a signal by its Discord messageId after add()', () => {
    const index = new SignalIndex()
    const signal = makeSignal({ messageId: 'discord-msg-abc' })
    index.add(signal)

    const found = index.findByExternalId('discord-msg-abc')
    expect(found).not.toBeNull()
    expect(found!.id).toBe(signal.id)
  })

  it('returns null for an unknown messageId', () => {
    const index = new SignalIndex()
    expect(index.findByExternalId('nonexistent')).toBeNull()
  })
})

describe('SignalIndex.findOpenByKolAndSymbol()', () => {
  it('returns open signals for matching (kolId, symbol)', () => {
    const index = new SignalIndex()
    const btcSignal = makeSignal({ kolId: 'kol-a', symbol: 'BTC' })
    const ethSignal = makeSignal({ kolId: 'kol-a', symbol: 'ETH' })
    index.add(btcSignal)
    index.add(ethSignal)

    const results = index.findOpenByKolAndSymbol('kol-a', 'BTC', new Date())
    expect(results).toHaveLength(1)
    expect(results[0].symbol).toBe('BTC')
  })

  it('excludes signals from a different KOL', () => {
    const index = new SignalIndex()
    index.add(makeSignal({ kolId: 'kol-a', symbol: 'BTC' }))
    index.add(makeSignal({ kolId: 'kol-b', symbol: 'BTC' }))

    const results = index.findOpenByKolAndSymbol('kol-a', 'BTC', new Date())
    expect(results).toHaveLength(1)
    expect(results[0].kolId).toBe('kol-a')
  })

  it('excludes signals parsed after the `before` cutoff', () => {
    const index = new SignalIndex()
    const past = new Date(Date.now() - 10_000).toISOString()
    const future = new Date(Date.now() + 10_000).toISOString()

    index.add(makeSignal({ kolId: 'kol-a', symbol: 'BTC', parsedAt: past }))
    index.add(makeSignal({ kolId: 'kol-a', symbol: 'BTC', parsedAt: future }))

    // Query with `before` = now — should only return the past signal
    const results = index.findOpenByKolAndSymbol('kol-a', 'BTC', new Date())
    expect(results).toHaveLength(1)
    expect(results[0].parsedAt).toBe(past)
  })

  it('returns most recent first when multiple signals match', () => {
    const index = new SignalIndex()
    const older = makeSignal({
      kolId: 'kol-a',
      symbol: 'BTC',
      parsedAt: new Date(Date.now() - 5000).toISOString(),
    })
    const newer = makeSignal({
      kolId: 'kol-a',
      symbol: 'BTC',
      parsedAt: new Date(Date.now() - 1000).toISOString(),
    })
    index.add(older)
    index.add(newer)

    const results = index.findOpenByKolAndSymbol('kol-a', 'BTC', new Date())
    expect(results[0].id).toBe(newer.id)
    expect(results[1].id).toBe(older.id)
  })
})

describe('SignalIndex.markClosed()', () => {
  it('removes a signal from findByExternalId after markClosed()', () => {
    const index = new SignalIndex()
    const signal = makeSignal({ messageId: 'msg-to-close' })
    index.add(signal)

    index.markClosed(signal.id)

    expect(index.findByExternalId('msg-to-close')).toBeNull()
  })

  it('removes a signal from findOpenByKolAndSymbol after markClosed()', () => {
    const index = new SignalIndex()
    const signal = makeSignal({ kolId: 'kol-a', symbol: 'BTC' })
    index.add(signal)

    index.markClosed(signal.id)

    const results = index.findOpenByKolAndSymbol('kol-a', 'BTC', new Date())
    expect(results).toHaveLength(0)
  })

  it('is a no-op for an unknown signalId', () => {
    const index = new SignalIndex()
    // Should not throw
    index.markClosed('nonexistent-id')
    expect(index.size()).toBe(0)
  })
})

describe('SignalIndex.size()', () => {
  it('tracks open signal count correctly across add and markClosed', () => {
    const index = new SignalIndex()
    const s1 = makeSignal()
    const s2 = makeSignal()

    index.add(s1)
    index.add(s2)
    expect(index.size()).toBe(2)

    index.markClosed(s1.id)
    expect(index.size()).toBe(1)

    index.markClosed(s2.id)
    expect(index.size()).toBe(0)
  })
})
