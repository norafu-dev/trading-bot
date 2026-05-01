import { describe, expect, it } from 'vitest'
import type { PositionUpdate, Signal } from '../../../../../../shared/types.js'
import { SignalIndex } from '../signal-index.js'
import { ByKolSymbolStrategy } from '../strategies/by-kol-symbol.js'

function makeSignal(over: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-' + Math.random().toString(36).slice(2, 8),
    source: 'discord',
    channelId: 'ch-1',
    messageId: 'msg-' + Math.random().toString(36).slice(2, 8),
    bundleId: 'bundle-' + Math.random().toString(36).slice(2, 8),
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
    symbol: 'BTC',
    ...over,
  }
}

describe('ByKolSymbolStrategy', () => {
  it('links to a single open (kol, symbol) match with exact confidence', () => {
    const index = new SignalIndex()
    const sig = makeSignal({ id: 'sig-only', kolId: 'kol-1', symbol: 'BTC' })
    index.add(sig)

    const result = new ByKolSymbolStrategy().tryLink(makeUpdate({ kolId: 'kol-1', symbol: 'BTC' }), index)
    expect(result).toEqual({ linked: true, signalId: 'sig-only', confidence: 'exact' })
  })

  it('picks the most recent and reports inferred when multiple open signals match', () => {
    const index = new SignalIndex()
    const older = makeSignal({
      id: 'sig-older',
      symbol: 'BTC',
      parsedAt: '2026-04-20T08:00:00.000Z',
    })
    const newer = makeSignal({
      id: 'sig-newer',
      symbol: 'BTC',
      parsedAt: '2026-04-20T09:30:00.000Z',
    })
    index.add(older)
    index.add(newer)

    const update = makeUpdate({ symbol: 'BTC', receivedAt: '2026-04-20T10:00:00.000Z' })
    const result = new ByKolSymbolStrategy().tryLink(update, index)

    expect(result).toEqual({ linked: true, signalId: 'sig-newer', confidence: 'inferred' })
  })

  it('does not link to signals parsed AFTER the update receivedAt (out-of-order replay)', () => {
    const index = new SignalIndex()
    // Signal parsed at 11:00, update received at 10:00 — update predates signal
    index.add(makeSignal({ id: 'sig-future', symbol: 'BTC', parsedAt: '2026-04-20T11:00:00.000Z' }))

    const result = new ByKolSymbolStrategy().tryLink(
      makeUpdate({ symbol: 'BTC', receivedAt: '2026-04-20T10:00:00.000Z' }),
      index,
    )
    expect(result.linked).toBe(false)
  })

  it('returns linked:false when update has no symbol', () => {
    const index = new SignalIndex()
    index.add(makeSignal({ symbol: 'BTC' }))

    const result = new ByKolSymbolStrategy().tryLink(makeUpdate({ symbol: undefined }), index)
    expect(result.linked).toBe(false)
    if (!result.linked) expect(result.reason).toContain('no symbol')
  })

  it('returns linked:false when no matching kol+symbol signal is open', () => {
    const index = new SignalIndex()
    index.add(makeSignal({ kolId: 'kol-1', symbol: 'ETH' })) // wrong symbol
    index.add(makeSignal({ kolId: 'kol-2', symbol: 'BTC' })) // wrong kol

    const result = new ByKolSymbolStrategy().tryLink(makeUpdate({ kolId: 'kol-1', symbol: 'BTC' }), index)
    expect(result.linked).toBe(false)
  })

  it('skips closed signals', () => {
    const index = new SignalIndex()
    const closed = makeSignal({ id: 'sig-closed', symbol: 'BTC' })
    index.add(closed)
    index.markClosed(closed.id)

    const result = new ByKolSymbolStrategy().tryLink(makeUpdate({ symbol: 'BTC' }), index)
    expect(result.linked).toBe(false)
  })
})
