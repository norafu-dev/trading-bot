import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PositionUpdate, Signal } from '../../../../../../shared/types.js'
import { createEventLog, type EventLog, type EventLogEntry } from '../../../../core/event-log.js'
import { SignalIndex } from '../../linking/signal-index.js'
import { ByExternalIdStrategy } from '../../linking/strategies/by-external-id.js'
import { ByKolSymbolStrategy } from '../../linking/strategies/by-kol-symbol.js'
import { UpdateLinker } from '../../linking/update-linker.js'
import { SignalStore, type StoredRecord } from '../../persistence/signal-store.js'
import type { ParseResult } from '../../parsing/types.js'
import { ResultRouter } from '../result-router.js'

let dir: string
let signalsPath: string
let eventsPath: string
let store: SignalStore
let index: SignalIndex
let events: EventLog
let router: ResultRouter

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-'))
  signalsPath = join(dir, 'signals.jsonl')
  eventsPath = join(dir, 'events.jsonl')
  store = new SignalStore(signalsPath)
  index = new SignalIndex()
  events = await createEventLog({ logPath: eventsPath })
  const linker = new UpdateLinker([new ByExternalIdStrategy(), new ByKolSymbolStrategy()])
  router = new ResultRouter(store, linker, index, events)
})

afterEach(async () => {
  await events.close()
  await rm(dir, { recursive: true, force: true })
})

// ── Helpers ──────────────────────────────────────────────────────────────────

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
    receivedAt: '2026-04-20T10:05:00.000Z',
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

async function readEvents(): Promise<EventLogEntry[]> {
  return events.read()
}

async function readStored(): Promise<StoredRecord[]> {
  const out: StoredRecord[] = []
  for await (const r of store.replay()) out.push(r)
  return out
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ResultRouter — signal path', () => {
  it('persists signal, adds to index, emits signal.parsed event', async () => {
    const r = signalResult({ id: 'sig-1', symbol: 'BTC' })
    await router.route(r)

    expect(index.findByExternalId(r.signal.messageId)?.id).toBe('sig-1')
    const stored = await readStored()
    expect(stored).toEqual([{ kind: 'signal', record: r.signal }])
    const evts = await readEvents()
    expect(evts).toHaveLength(1)
    expect(evts[0].type).toBe('signal.parsed')
    expect(evts[0].payload).toMatchObject({ signalId: 'sig-1', symbol: 'BTC' })
  })
})

describe('ResultRouter — update path', () => {
  it('links update via by_external_id, persists with linkedSignalId set, emits update.linked', async () => {
    const sig = signalResult({ id: 'sig-target', messageId: 'parent-msg' })
    await router.route(sig)

    const upd = updateResult({ externalMessageId: 'parent-msg', updateType: 'tp_hit' })
    await router.route(upd)

    expect(upd.update.linkedSignalId).toBe('sig-target')
    const stored = await readStored()
    expect(stored[1].kind).toBe('update')
    expect((stored[1].record as PositionUpdate).linkedSignalId).toBe('sig-target')

    const evts = await readEvents()
    const linked = evts.find((e) => e.type === 'update.linked')
    expect(linked?.payload).toMatchObject({
      signalId: 'sig-target',
      linkConfidence: 'exact',
      closedSignal: false,
    })
    // partial-close update does not close the signal
    expect(index.findByExternalId('parent-msg')?.id).toBe('sig-target')
  })

  it('links via DEC-016 linkedExternalMessageId for bot KOL', async () => {
    const sig = signalResult({
      id: 'sig-bot',
      messageId: 'forwarded-msg',
      linkedExternalMessageId: 'source-msg',
    })
    await router.route(sig)

    const upd = updateResult({ linkedExternalMessageId: 'source-msg' })
    await router.route(upd)

    expect(upd.update.linkedSignalId).toBe('sig-bot')
  })

  it('links via by_kol_symbol when no external-id reference', async () => {
    const sig = signalResult({
      id: 'sig-human',
      symbol: 'ETH',
      kolId: 'kol-human',
      parsedAt: '2026-04-20T10:00:00.000Z',
    })
    await router.route(sig)

    const upd = updateResult({
      symbol: 'ETH',
      kolId: 'kol-human',
      receivedAt: '2026-04-20T10:30:00.000Z',
    })
    await router.route(upd)

    expect(upd.update.linkedSignalId).toBe('sig-human')
  })

  it('removes signal from index when update is a closing type (sl_hit)', async () => {
    const sig = signalResult({ id: 'sig-stopped', messageId: 'stopped-msg' })
    await router.route(sig)
    expect(index.size()).toBe(1)

    await router.route(updateResult({
      externalMessageId: 'stopped-msg',
      updateType: 'sl_hit',
    }))

    expect(index.size()).toBe(0)
    const evts = await readEvents()
    const linked = evts.find((e) => e.type === 'update.linked')
    expect((linked?.payload as { closedSignal: boolean }).closedSignal).toBe(true)
  })

  it('persists unlinked update with linkedSignalId undefined and emits update.unlinked', async () => {
    // No prior signal; update arrives as orphan
    const upd = updateResult({
      externalMessageId: 'no-such-msg',
      symbol: 'XRP',  // present but no open XRP signal exists
      updateType: 'tp_hit',
    })
    await router.route(upd)

    expect(upd.update.linkedSignalId).toBeUndefined()
    const stored = await readStored()
    expect(stored).toHaveLength(1)
    expect((stored[0].record as PositionUpdate).linkedSignalId).toBeUndefined()

    const evts = await readEvents()
    const unlinked = evts.find((e) => e.type === 'update.unlinked')
    expect(unlinked).toBeDefined()
    expect((unlinked!.payload as { reason: string }).reason).toContain('by_external_id')
  })
})

describe('ResultRouter — discarded / failed', () => {
  it('emits parse.discarded for discarded ParseResult', async () => {
    await router.route({
      kind: 'discarded',
      reason: 'low_confidence',
      meta: {
        parserName: 'llm_text',
        bundleId: 'bundle-x',
        kolId: 'kol-1',
        startedAt: '2026-04-20T10:00:00.000Z',
        completedAt: '2026-04-20T10:00:00.000Z',
      },
    })
    const evts = await readEvents()
    expect(evts).toHaveLength(1)
    expect(evts[0].type).toBe('parse.discarded')
    expect(evts[0].payload).toMatchObject({ bundleId: 'bundle-x', reason: 'low_confidence' })
    expect(await readStored()).toHaveLength(0)
  })

  it('emits parse.failed for failed ParseResult', async () => {
    await router.route({
      kind: 'failed',
      error: { code: 'schema_validation', message: 'missing action', retriable: false },
      meta: {
        parserName: 'llm_text',
        bundleId: 'bundle-y',
        kolId: 'kol-2',
        startedAt: '2026-04-20T10:00:00.000Z',
        completedAt: '2026-04-20T10:00:00.000Z',
      },
    })
    const evts = await readEvents()
    expect(evts).toHaveLength(1)
    expect(evts[0].type).toBe('parse.failed')
    expect(evts[0].payload).toMatchObject({
      errorCode: 'schema_validation',
      retriable: false,
    })
  })
})

describe('ResultRouter — full pipeline integration', () => {
  it('signal → tp_hit → sl_hit produces consistent disk + index state', async () => {
    // open
    const sig = signalResult({ id: 'sig-flow', messageId: 'flow-msg', symbol: 'BTC' })
    await router.route(sig)

    // partial close (TP1) — link, but signal stays open
    await router.route(updateResult({
      id: 'upd-tp',
      externalMessageId: 'flow-msg',
      updateType: 'tp_hit',
      level: 1,
    }))
    expect(index.size()).toBe(1)

    // full stop hit — signal closes
    await router.route(updateResult({
      id: 'upd-sl',
      externalMessageId: 'flow-msg',
      updateType: 'sl_hit',
    }))
    expect(index.size()).toBe(0)

    const stored = await readStored()
    expect(stored.map((r) => r.kind)).toEqual(['signal', 'update', 'update'])
    const updateRecords = stored.filter((r) => r.kind === 'update').map((r) => r.record) as PositionUpdate[]
    expect(updateRecords.every((u) => u.linkedSignalId === 'sig-flow')).toBe(true)

    const evts = await readEvents()
    const types = evts.map((e) => e.type)
    expect(types).toEqual(['signal.parsed', 'update.linked', 'update.linked'])
  })
})
