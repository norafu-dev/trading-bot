import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PositionUpdate, Signal } from '../../../../../../shared/types.js'
import { createEventLog, type EventLog } from '../../../../core/event-log.js'
import { SignalIndex } from '../../linking/signal-index.js'
import { ByExternalIdStrategy } from '../../linking/strategies/by-external-id.js'
import { ByKolSymbolStrategy } from '../../linking/strategies/by-kol-symbol.js'
import { UpdateLinker } from '../../linking/update-linker.js'
import { SignalIndexBuilder } from '../../persistence/signal-index-builder.js'
import { SignalStore } from '../../persistence/signal-store.js'
import type { ParseResult } from '../../parsing/types.js'
import { ResultRouter } from '../result-router.js'

let dir: string
let signalsPath: string
let eventsPath: string
let events: EventLog

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crash-'))
  signalsPath = join(dir, 'signals.jsonl')
  eventsPath = join(dir, 'events.jsonl')
  events = await createEventLog({ logPath: eventsPath })
})

afterEach(async () => {
  await events.close()
  await rm(dir, { recursive: true, force: true })
})

function makeRouter(store: SignalStore, index: SignalIndex): ResultRouter {
  const linker = new UpdateLinker([new ByExternalIdStrategy(), new ByKolSymbolStrategy()])
  return new ResultRouter(store, linker, index, events)
}

function signalResult(over: Partial<Signal> = {}): Extract<ParseResult, { kind: 'signal' }> {
  const signal: Signal = {
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
  return {
    kind: 'signal',
    signal,
    meta: {
      parserName: signal.parserType,
      bundleId: signal.bundleId,
      kolId: signal.kolId,
      startedAt: signal.parsedAt,
      completedAt: signal.parsedAt,
    },
  }
}

function updateResult(over: Partial<PositionUpdate> = {}): Extract<ParseResult, { kind: 'update' }> {
  const update: PositionUpdate = {
    id: 'upd-' + Math.random().toString(36).slice(2, 8),
    kolId: 'kol-1',
    receivedAt: '2026-04-20T10:30:00.000Z',
    source: 'discord',
    channelId: 'ch-1',
    bundleId: 'bundle-' + Math.random().toString(36).slice(2, 8),
    parserType: 'llm_text',
    updateType: 'tp_hit',
    confidence: 0.88,
    ...over,
  }
  return {
    kind: 'update',
    update,
    meta: {
      parserName: update.parserType,
      bundleId: update.bundleId,
      kolId: update.kolId,
      startedAt: update.receivedAt,
      completedAt: update.receivedAt,
    },
  }
}

describe('Crash recovery — index rebuilt from disk matches live index at crash time', () => {
  it('5 signals + 1 sl_hit + 2 tp_hit → rebuilt index has 4 open', async () => {
    // ── Phase 1: live router writes to disk ──
    const store = new SignalStore(signalsPath)
    const liveIndex = new SignalIndex()
    const router = makeRouter(store, liveIndex)

    const sigA = signalResult({ id: 'sig-A', messageId: 'msg-A', symbol: 'BTC' })
    const sigB = signalResult({ id: 'sig-B', messageId: 'msg-B', symbol: 'ETH' })
    const sigC = signalResult({ id: 'sig-C', messageId: 'msg-C', symbol: 'SOL' })
    const sigD = signalResult({ id: 'sig-D', messageId: 'msg-D', symbol: 'HYPE' })
    const sigE = signalResult({ id: 'sig-E', messageId: 'msg-E', symbol: 'XRP' })

    for (const s of [sigA, sigB, sigC, sigD, sigE]) {
      await router.route(s)
    }
    await router.route(updateResult({
      externalMessageId: 'msg-A',
      updateType: 'sl_hit',
    }))
    await router.route(updateResult({
      externalMessageId: 'msg-B',
      updateType: 'tp_hit',
      level: 1,
    }))
    await router.route(updateResult({
      externalMessageId: 'msg-C',
      updateType: 'tp_hit',
      level: 2,
    }))

    expect(liveIndex.size()).toBe(4) // A closed, B/C/D/E open

    // ── Phase 2: simulate restart — fresh index, replay store ──
    const recoveredIndex = new SignalIndex()
    const stats = await new SignalIndexBuilder(store, recoveredIndex).rebuild()

    expect(stats).toEqual({ replayed: 8, opened: 5, closed: 1 })
    expect(recoveredIndex.size()).toBe(4)
    expect(recoveredIndex.findByExternalId('msg-A')).toBeNull()  // closed
    expect(recoveredIndex.findByExternalId('msg-B')?.id).toBe('sig-B')
    expect(recoveredIndex.findByExternalId('msg-C')?.id).toBe('sig-C')
    expect(recoveredIndex.findByExternalId('msg-D')?.id).toBe('sig-D')
    expect(recoveredIndex.findByExternalId('msg-E')?.id).toBe('sig-E')
  })

  it('DEC-016 bot KOL: re-entry on same symbol after close — recovered index has only the new one', async () => {
    const store = new SignalStore(signalsPath)
    const liveIndex = new SignalIndex()
    const router = makeRouter(store, liveIndex)

    // First BTC signal opens, fully closes
    const first = signalResult({
      id: 'sig-first',
      messageId: 'forwarded-1',
      linkedExternalMessageId: 'source-1',
      symbol: 'BTC',
    })
    await router.route(first)
    await router.route(updateResult({
      linkedExternalMessageId: 'source-1',
      updateType: 'full_close',
    }))

    // Re-entry: new BTC signal
    const second = signalResult({
      id: 'sig-second',
      messageId: 'forwarded-2',
      linkedExternalMessageId: 'source-2',
      symbol: 'BTC',
    })
    await router.route(second)

    expect(liveIndex.size()).toBe(1)
    expect(liveIndex.findByLinkedExternalId('source-1')).toBeNull()
    expect(liveIndex.findByLinkedExternalId('source-2')?.id).toBe('sig-second')

    // Replay
    const recovered = new SignalIndex()
    await new SignalIndexBuilder(store, recovered).rebuild()

    expect(recovered.size()).toBe(1)
    expect(recovered.findByLinkedExternalId('source-1')).toBeNull()
    expect(recovered.findByLinkedExternalId('source-2')?.id).toBe('sig-second')
  })

  it('unlinked updates in the store do not crash recovery and do not change open-set size', async () => {
    const store = new SignalStore(signalsPath)
    const liveIndex = new SignalIndex()
    const router = makeRouter(store, liveIndex)

    await router.route(signalResult({ id: 'sig-X', messageId: 'msg-X' }))
    // Orphan update — no matching signal
    await router.route(updateResult({
      externalMessageId: 'msg-orphan',
      symbol: 'NOPE',
      updateType: 'tp_hit',
    }))

    const recovered = new SignalIndex()
    const stats = await new SignalIndexBuilder(store, recovered).rebuild()

    expect(stats.replayed).toBe(2)
    expect(stats.opened).toBe(1)
    expect(stats.closed).toBe(0)
    expect(recovered.size()).toBe(1)
  })
})
