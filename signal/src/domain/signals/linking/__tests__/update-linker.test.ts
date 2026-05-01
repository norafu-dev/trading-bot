import { describe, expect, it, vi } from 'vitest'
import type { PositionUpdate } from '../../../../../../shared/types.js'
import type { ILinkStrategy, ISignalIndex, LinkResult, LinkStrategy } from '../types.js'
import { UpdateLinker } from '../update-linker.js'

function fakeStrategy(name: LinkStrategy, result: LinkResult): ILinkStrategy {
  return {
    name,
    tryLink: vi.fn(() => result),
  }
}

const dummyUpdate: PositionUpdate = {
  id: 'upd-1',
  kolId: 'kol-1',
  receivedAt: '2026-04-20T10:00:00.000Z',
  source: 'discord',
  channelId: 'ch-1',
  bundleId: 'bundle-1',
  parserType: 'llm_text',
  updateType: 'tp_hit',
  confidence: 0.9,
}

const dummyIndex = {} as ISignalIndex

describe('UpdateLinker', () => {
  it('returns the first strategy that links and stops trying', () => {
    const s1 = fakeStrategy('by_external_id', { linked: true, signalId: 'sig-A', confidence: 'exact' })
    const s2 = fakeStrategy('by_kol_symbol', { linked: false, reason: 'not asked' })
    const linker = new UpdateLinker([s1, s2])

    const result = linker.link(dummyUpdate, dummyIndex)

    expect(result).toEqual({ linked: true, signalId: 'sig-A', confidence: 'exact' })
    expect(s1.tryLink).toHaveBeenCalledOnce()
    expect(s2.tryLink).not.toHaveBeenCalled()
  })

  it('falls through to the next strategy when the first returns linked:false', () => {
    const s1 = fakeStrategy('by_external_id', { linked: false, reason: 'no id match' })
    const s2 = fakeStrategy('by_kol_symbol', { linked: true, signalId: 'sig-B', confidence: 'inferred' })
    const linker = new UpdateLinker([s1, s2])

    const result = linker.link(dummyUpdate, dummyIndex)

    expect(result).toEqual({ linked: true, signalId: 'sig-B', confidence: 'inferred' })
    expect(s1.tryLink).toHaveBeenCalledOnce()
    expect(s2.tryLink).toHaveBeenCalledOnce()
  })

  it('aggregates failure reasons when no strategy matches', () => {
    const s1 = fakeStrategy('by_external_id', { linked: false, reason: 'no id match' })
    const s2 = fakeStrategy('by_kol_symbol', { linked: false, reason: 'no symbol' })
    const linker = new UpdateLinker([s1, s2])

    const result = linker.link(dummyUpdate, dummyIndex)

    expect(result.linked).toBe(false)
    if (!result.linked) {
      expect(result.reason).toContain('by_external_id')
      expect(result.reason).toContain('no id match')
      expect(result.reason).toContain('by_kol_symbol')
      expect(result.reason).toContain('no symbol')
    }
  })

  it('throws when constructed with zero strategies', () => {
    expect(() => new UpdateLinker([])).toThrow('at least one strategy')
  })
})
