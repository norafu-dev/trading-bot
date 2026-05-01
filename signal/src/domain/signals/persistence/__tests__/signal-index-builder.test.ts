import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Signal, PositionUpdate } from '../../../../../../shared/types.js'
import { SignalIndex } from '../../linking/signal-index.js'
import { SignalStore } from '../signal-store.js'
import { SignalIndexBuilder } from '../signal-index-builder.js'

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'idx-builder-'))
  path = join(dir, 'signals.jsonl')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function makeSignal(over: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-' + Math.random().toString(36).slice(2, 8),
    source: 'discord',
    channelId: 'ch-1',
    messageId: 'fwdmsg-' + Math.random().toString(36).slice(2, 8),
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

function makeUpdate(
  updateType: PositionUpdate['updateType'],
  over: Partial<PositionUpdate> = {},
): PositionUpdate {
  return {
    id: 'upd-' + Math.random().toString(36).slice(2, 8),
    kolId: 'kol-1',
    receivedAt: '2026-04-20T10:05:00.000Z',
    source: 'discord',
    channelId: 'ch-1',
    bundleId: 'bundle-' + Math.random().toString(36).slice(2, 8),
    parserType: 'llm_text',
    updateType,
    confidence: 0.88,
    ...over,
  }
}

describe('SignalIndexBuilder', () => {
  it('rebuilds an index with all open signals after replay', async () => {
    const store = new SignalStore(path)
    const sig1 = makeSignal({ id: 'sig-1' })
    const sig2 = makeSignal({ id: 'sig-2', symbol: 'ETH' })
    await store.appendSignal(sig1)
    await store.appendSignal(sig2)

    const index = new SignalIndex()
    const stats = await new SignalIndexBuilder(store, index).rebuild()

    expect(stats).toEqual({ replayed: 2, opened: 2, closed: 0 })
    expect(index.findByExternalId(sig1.messageId)).toEqual(sig1)
    expect(index.findByExternalId(sig2.messageId)).toEqual(sig2)
  })

  it('closes signals on sl_hit / full_close / breakeven_hit / manual_close', async () => {
    const store = new SignalStore(path)
    const sig1 = makeSignal({ id: 'sig-sl' })
    const sig2 = makeSignal({ id: 'sig-full' })
    const sig3 = makeSignal({ id: 'sig-be' })
    const sig4 = makeSignal({ id: 'sig-manual' })
    const sig5 = makeSignal({ id: 'sig-still-open' })
    await store.appendSignal(sig1)
    await store.appendSignal(sig2)
    await store.appendSignal(sig3)
    await store.appendSignal(sig4)
    await store.appendSignal(sig5)
    await store.appendUpdate(makeUpdate('sl_hit', { externalMessageId: sig1.messageId }))
    await store.appendUpdate(makeUpdate('full_close', { externalMessageId: sig2.messageId }))
    await store.appendUpdate(makeUpdate('breakeven_hit', { externalMessageId: sig3.messageId }))
    await store.appendUpdate(makeUpdate('manual_close', { externalMessageId: sig4.messageId }))

    const index = new SignalIndex()
    const stats = await new SignalIndexBuilder(store, index).rebuild()

    expect(stats).toEqual({ replayed: 9, opened: 5, closed: 4 })
    expect(index.findByExternalId(sig1.messageId)).toBeNull()
    expect(index.findByExternalId(sig2.messageId)).toBeNull()
    expect(index.findByExternalId(sig3.messageId)).toBeNull()
    expect(index.findByExternalId(sig4.messageId)).toBeNull()
    expect(index.findByExternalId(sig5.messageId)).toEqual(sig5)
  })

  it('does NOT close on partial-close or stop-adjust updates', async () => {
    const store = new SignalStore(path)
    const sig = makeSignal({ id: 'sig-partial' })
    await store.appendSignal(sig)
    await store.appendUpdate(makeUpdate('tp_hit', { externalMessageId: sig.messageId }))
    await store.appendUpdate(makeUpdate('runner_close', { externalMessageId: sig.messageId }))
    await store.appendUpdate(makeUpdate('stop_modified', { externalMessageId: sig.messageId }))
    await store.appendUpdate(makeUpdate('breakeven_move', { externalMessageId: sig.messageId }))
    await store.appendUpdate(makeUpdate('limit_filled', { externalMessageId: sig.messageId }))

    const index = new SignalIndex()
    const stats = await new SignalIndexBuilder(store, index).rebuild()

    expect(stats.closed).toBe(0)
    expect(index.findByExternalId(sig.messageId)).toEqual(sig)
  })

  it('uses linkedExternalMessageId (DEC-016) when present, before externalMessageId', async () => {
    const store = new SignalStore(path)
    // Bot KOL signal: messageId = forwarded msg, linkedExternalMessageId = source msg
    const sig = makeSignal({
      id: 'sig-bot',
      messageId: 'forwarded-msg-id',
      linkedExternalMessageId: 'source-msg-id',
    })
    await store.appendSignal(sig)
    // Update from bot points at the source msg via linkedExternalMessageId,
    // NOT at forwarded msg
    await store.appendUpdate(makeUpdate('sl_hit', {
      linkedExternalMessageId: 'source-msg-id',
      externalMessageId: 'irrelevant-update-msg',
    }))

    const index = new SignalIndex()
    const stats = await new SignalIndexBuilder(store, index).rebuild()

    expect(stats.closed).toBe(1)
    expect(index.findByExternalId('forwarded-msg-id')).toBeNull()
    expect(index.findByLinkedExternalId('source-msg-id')).toBeNull()
  })

  it('skips closing updates that cannot be resolved to any open signal', async () => {
    const store = new SignalStore(path)
    const sig = makeSignal({ id: 'sig-survives' })
    await store.appendSignal(sig)
    // Closing update referencing a non-existent message id
    await store.appendUpdate(makeUpdate('sl_hit', { externalMessageId: 'nonexistent-msg' }))

    const index = new SignalIndex()
    const stats = await new SignalIndexBuilder(store, index).rebuild()

    expect(stats.closed).toBe(0)
    expect(index.findByExternalId(sig.messageId)).toEqual(sig)
  })

  it('handles an empty / fresh-install store', async () => {
    const store = new SignalStore(path)
    const index = new SignalIndex()
    const stats = await new SignalIndexBuilder(store, index).rebuild()
    expect(stats).toEqual({ replayed: 0, opened: 0, closed: 0 })
    expect(index.size()).toBe(0)
  })

  it('chronological order matters: signal → close → re-open with same kol+symbol', async () => {
    // Demonstrates that a closed signal is gone from the index even if a new
    // signal for the same kol+symbol is added later. Replay must apply
    // close BEFORE the second add so the second signal lives on its own.
    const store = new SignalStore(path)
    const first = makeSignal({ id: 'sig-first', messageId: 'm1' })
    const second = makeSignal({ id: 'sig-second', messageId: 'm2' })
    await store.appendSignal(first)
    await store.appendUpdate(makeUpdate('full_close', { externalMessageId: 'm1' }))
    await store.appendSignal(second)

    const index = new SignalIndex()
    const stats = await new SignalIndexBuilder(store, index).rebuild()

    expect(stats).toEqual({ replayed: 3, opened: 2, closed: 1 })
    expect(index.findByExternalId('m1')).toBeNull()
    expect(index.findByExternalId('m2')).toEqual(second)
  })
})
