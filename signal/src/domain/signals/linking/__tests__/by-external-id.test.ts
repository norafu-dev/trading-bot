import { describe, expect, it } from 'vitest'
import type { PositionUpdate, Signal } from '../../../../../../shared/types.js'
import { SignalIndex } from '../signal-index.js'
import { ByExternalIdStrategy } from '../strategies/by-external-id.js'

function makeSignal(over: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-' + Math.random().toString(36).slice(2, 8),
    source: 'discord',
    channelId: 'ch-1',
    messageId: 'fwdmsg-default',
    bundleId: 'bundle-default',
    kolId: 'kol-1',
    rawText: 'BTC long',
    parsedAt: '2026-04-20T10:00:00.000Z',
    parserType: 'llm_text',
    action: 'open',
    symbol: 'BTC',
    confidence: 0.9,
    ...over,
  }
}

function makeUpdate(over: Partial<PositionUpdate> = {}): PositionUpdate {
  return {
    id: 'upd-default',
    kolId: 'kol-1',
    receivedAt: '2026-04-20T10:05:00.000Z',
    source: 'discord',
    channelId: 'ch-1',
    bundleId: 'bundle-upd',
    parserType: 'llm_text',
    updateType: 'tp_hit',
    confidence: 0.9,
    ...over,
  }
}

describe('ByExternalIdStrategy', () => {
  it('links via linkedExternalMessageId (DEC-016 bot KOL path)', () => {
    const index = new SignalIndex()
    const sig = makeSignal({
      id: 'sig-bot',
      messageId: 'forwarded-msg',
      linkedExternalMessageId: 'source-msg',
    })
    index.add(sig)

    const strat = new ByExternalIdStrategy()
    const update = makeUpdate({ linkedExternalMessageId: 'source-msg' })
    const result = strat.tryLink(update, index)

    expect(result).toEqual({ linked: true, signalId: 'sig-bot', confidence: 'exact' })
  })

  it('falls back to externalMessageId when linkedExternalMessageId is absent', () => {
    const index = new SignalIndex()
    const sig = makeSignal({ id: 'sig-human', messageId: 'human-signal-msg' })
    index.add(sig)

    const strat = new ByExternalIdStrategy()
    const update = makeUpdate({ externalMessageId: 'human-signal-msg' })
    const result = strat.tryLink(update, index)

    expect(result).toEqual({ linked: true, signalId: 'sig-human', confidence: 'exact' })
  })

  it('prefers linkedExternalMessageId over externalMessageId when both match', () => {
    const index = new SignalIndex()
    const target = makeSignal({
      id: 'sig-target',
      messageId: 'fallback-msg',
      linkedExternalMessageId: 'primary-msg',
    })
    const decoy = makeSignal({ id: 'sig-decoy', messageId: 'primary-msg' })
    index.add(target)
    index.add(decoy)

    const strat = new ByExternalIdStrategy()
    const update = makeUpdate({
      linkedExternalMessageId: 'primary-msg',
      externalMessageId: 'fallback-msg',
    })
    const result = strat.tryLink(update, index)

    // linkedExternalMessageId is checked first; it matches `decoy.messageId`
    // via byLinkedExternalId? No — `byLinkedExternalId` is keyed by
    // `Signal.linkedExternalMessageId` (which only `target` has). So the
    // linker hits `target`, not `decoy`.
    expect(result).toEqual({ linked: true, signalId: 'sig-target', confidence: 'exact' })
  })

  it('returns linked:false when neither id resolves to an open signal', () => {
    const index = new SignalIndex()
    index.add(makeSignal({ id: 'sig-other', messageId: 'other-msg' }))

    const strat = new ByExternalIdStrategy()
    const update = makeUpdate({
      linkedExternalMessageId: 'no-such-link',
      externalMessageId: 'no-such-msg',
    })
    const result = strat.tryLink(update, index)

    expect(result.linked).toBe(false)
  })

  it('returns linked:false when update has neither id', () => {
    const index = new SignalIndex()
    index.add(makeSignal())

    const strat = new ByExternalIdStrategy()
    const result = strat.tryLink(makeUpdate({}), index)

    expect(result.linked).toBe(false)
  })

  it('does not match a signal that has been markClosed', () => {
    const index = new SignalIndex()
    const sig = makeSignal({ id: 'sig-closed', messageId: 'closed-msg' })
    index.add(sig)
    index.markClosed(sig.id)

    const strat = new ByExternalIdStrategy()
    const result = strat.tryLink(makeUpdate({ externalMessageId: 'closed-msg' }), index)

    expect(result.linked).toBe(false)
  })
})
