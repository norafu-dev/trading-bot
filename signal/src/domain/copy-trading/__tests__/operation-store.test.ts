import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OperationStore } from '../operation-store.js'
import { makeOperation } from './helpers.js'

let dir: string
let path: string
let store: OperationStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'op-store-'))
  path = join(dir, 'operations.jsonl')
  store = new OperationStore(path)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('OperationStore', () => {
  it('appends and replays in insertion order', async () => {
    await store.append(makeOperation({ id: 'op-A' }))
    await store.append(makeOperation({ id: 'op-B' }))
    await store.append(makeOperation({ id: 'op-C' }))

    const all = await store.readAll()
    expect(all.map((r) => r.record.id)).toEqual(['op-A', 'op-B', 'op-C'])
  })

  it('returns nothing on a fresh install', async () => {
    expect(await store.readAll()).toEqual([])
  })

  it('creates parent directory on first write', async () => {
    const nested = new OperationStore(join(dir, 'nested', 'deep', 'operations.jsonl'))
    await nested.append(makeOperation())
    expect((await nested.readAll()).length).toBe(1)
  })

  it('skips malformed JSON lines but keeps the rest', async () => {
    await store.append(makeOperation({ id: 'op-good-1' }))
    const fs = await import('node:fs/promises')
    await fs.appendFile(path, 'not json\n', 'utf-8')
    await store.append(makeOperation({ id: 'op-good-2' }))

    const all = await store.readAll()
    expect(all.map((r) => r.record.id)).toEqual(['op-good-1', 'op-good-2'])
  })

  it('skips records with unknown kind', async () => {
    await writeFile(
      path,
      JSON.stringify({ kind: 'mystery', record: { id: 'x' } }) + '\n' +
        JSON.stringify({ kind: 'operation', record: makeOperation({ id: 'op-real' }) }) + '\n',
      'utf-8',
    )
    const all = await store.readAll()
    expect(all).toHaveLength(1)
    expect(all[0].record.id).toBe('op-real')
  })

  it('preserves all operation fields, including nested guardResults + sizingContext', async () => {
    const op = makeOperation({
      id: 'op-full',
      guardResults: [
        { name: 'low-confidence', passed: true },
        { name: 'cooldown', passed: false, reason: 'cooldown active' },
      ],
      sizingContext: { equity: '10000.00', effectiveRiskPercent: '0.9000' },
    })
    await store.append(op)
    const all = await store.readAll()
    expect(all[0].record).toEqual(op)
  })
})
