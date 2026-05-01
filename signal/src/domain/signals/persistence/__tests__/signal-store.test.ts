import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Signal, PositionUpdate } from '../../../../../../shared/types.js'
import { SignalStore, type StoredRecord } from '../signal-store.js'

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'signal-store-'))
  path = join(dir, 'signals.jsonl')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function makeSignal(over: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-1',
    source: 'discord',
    channelId: 'ch-1',
    messageId: 'msg-1',
    bundleId: 'bundle-1',
    kolId: 'kol-1',
    rawText: 'BTC long 76500',
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
    id: 'upd-1',
    kolId: 'kol-1',
    receivedAt: '2026-04-20T10:05:00.000Z',
    source: 'discord',
    channelId: 'ch-1',
    bundleId: 'bundle-2',
    parserType: 'llm_text',
    updateType: 'tp_hit',
    confidence: 0.88,
    ...over,
  }
}

async function collectReplay(store: SignalStore): Promise<StoredRecord[]> {
  const out: StoredRecord[] = []
  for await (const r of store.replay()) out.push(r)
  return out
}

describe('SignalStore', () => {
  it('appends signals and updates and replays them in insertion order', async () => {
    const store = new SignalStore(path)
    await store.appendSignal(makeSignal({ id: 'sig-A' }))
    await store.appendUpdate(makeUpdate({ id: 'upd-A' }))
    await store.appendSignal(makeSignal({ id: 'sig-B' }))

    const records = await collectReplay(store)

    expect(records).toHaveLength(3)
    expect(records[0]).toEqual({ kind: 'signal', record: expect.objectContaining({ id: 'sig-A' }) })
    expect(records[1]).toEqual({ kind: 'update', record: expect.objectContaining({ id: 'upd-A' }) })
    expect(records[2]).toEqual({ kind: 'signal', record: expect.objectContaining({ id: 'sig-B' }) })
  })

  it('replay returns nothing when the file does not exist (fresh install)', async () => {
    const store = new SignalStore(path)
    const records = await collectReplay(store)
    expect(records).toHaveLength(0)
  })

  it('creates parent directory on first write', async () => {
    const nested = join(dir, 'nested', 'deeper', 'signals.jsonl')
    const store = new SignalStore(nested)
    await store.appendSignal(makeSignal())
    const records = await collectReplay(store)
    expect(records).toHaveLength(1)
  })

  it('skips malformed JSON lines but continues replaying valid ones', async () => {
    const store = new SignalStore(path)
    await store.appendSignal(makeSignal({ id: 'sig-good-1' }))
    // Corrupt the file with a malformed line
    const { appendFile } = await import('node:fs/promises')
    await appendFile(path, 'this is not json\n', 'utf-8')
    await store.appendSignal(makeSignal({ id: 'sig-good-2' }))

    const records = await collectReplay(store)
    expect(records).toHaveLength(2)
    expect(records[0].record.id).toBe('sig-good-1')
    expect(records[1].record.id).toBe('sig-good-2')
  })

  it('skips records with unknown kind', async () => {
    await writeFile(
      path,
      JSON.stringify({ kind: 'mystery', record: { id: 'x' } }) + '\n' +
        JSON.stringify({ kind: 'signal', record: makeSignal({ id: 'sig-real' }) }) + '\n',
      'utf-8',
    )
    const store = new SignalStore(path)
    const records = await collectReplay(store)
    expect(records).toHaveLength(1)
    expect(records[0].record.id).toBe('sig-real')
  })

  it('preserves all Signal fields including DEC-016 linkedExternalMessageId', async () => {
    const store = new SignalStore(path)
    const signal = makeSignal({
      id: 'sig-dec016',
      linkedExternalMessageId: '1494534655607701595',
      stopLoss: { price: '75500' },
      takeProfits: [{ level: 1, price: '78000' }],
    })
    await store.appendSignal(signal)

    const records = await collectReplay(store)
    expect(records).toHaveLength(1)
    expect(records[0]).toEqual({ kind: 'signal', record: signal })
  })
})
