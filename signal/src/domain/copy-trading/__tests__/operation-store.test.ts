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
  it('appends and reads operations in insertion order', async () => {
    await store.append(makeOperation({ id: 'op-A' }))
    await store.append(makeOperation({ id: 'op-B' }))
    await store.append(makeOperation({ id: 'op-C' }))

    const all = await store.readAllOperations()
    expect(all.map((op) => op.id)).toEqual(['op-A', 'op-B', 'op-C'])
  })

  it('returns nothing on a fresh install', async () => {
    expect(await store.readAllOperations()).toEqual([])
  })

  it('creates parent directory on first write', async () => {
    const nested = new OperationStore(join(dir, 'nested', 'deep', 'operations.jsonl'))
    await nested.append(makeOperation())
    expect((await nested.readAllOperations()).length).toBe(1)
  })

  it('skips malformed JSON lines but keeps the rest', async () => {
    await store.append(makeOperation({ id: 'op-good-1' }))
    const fs = await import('node:fs/promises')
    await fs.appendFile(path, 'not json\n', 'utf-8')
    await store.append(makeOperation({ id: 'op-good-2' }))

    const all = await store.readAllOperations()
    expect(all.map((op) => op.id)).toEqual(['op-good-1', 'op-good-2'])
  })

  it('skips records with unknown kind', async () => {
    await writeFile(
      path,
      JSON.stringify({ kind: 'mystery', record: { id: 'x' } }) + '\n' +
        JSON.stringify({ kind: 'operation', record: makeOperation({ id: 'op-real' }) }) + '\n',
      'utf-8',
    )
    const all = await store.readAllOperations()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe('op-real')
  })

  it('preserves nested guardResults + sizingContext', async () => {
    const op = makeOperation({
      id: 'op-full',
      guardResults: [
        { name: 'low-confidence', passed: true },
        { name: 'cooldown', passed: false, reason: 'cooldown active' },
      ],
      sizingContext: { equity: '10000.00', effectiveRiskPercent: '0.9000' },
    })
    await store.append(op)
    const all = await store.readAllOperations()
    expect(all[0]).toEqual(op)
  })

  describe('status-change folding', () => {
    it('applies a status-change event onto the original operation', async () => {
      await store.append(makeOperation({ id: 'op-1', status: 'pending' }))
      await store.appendStatusChange({
        operationId: 'op-1',
        newStatus: 'approved',
        at: '2026-05-02T10:00:00Z',
        by: 'dashboard',
      })

      const all = await store.readAllOperations()
      expect(all).toHaveLength(1)
      expect(all[0].status).toBe('approved')
    })

    it('applies the latest status when several events stack', async () => {
      await store.append(makeOperation({ id: 'op-1', status: 'pending' }))
      await store.appendStatusChange({ operationId: 'op-1', newStatus: 'approved', at: '2026-05-02T10:00:00Z', by: 'dashboard' })
      await store.appendStatusChange({ operationId: 'op-1', newStatus: 'executed', at: '2026-05-02T10:01:00Z', by: 'broker' })

      const all = await store.readAllOperations()
      expect(all[0].status).toBe('executed')
    })

    it('attaches lastDecision from the most recent status-change event', async () => {
      await store.append(makeOperation({ id: 'op-1', status: 'pending' }))
      await store.appendStatusChange({
        operationId: 'op-1',
        newStatus: 'rejected',
        at: '2026-05-02T10:05:00Z',
        by: 'engine',
        reason: 'approval timeout (300s)',
      })

      const all = await store.readAllOperations()
      expect(all[0].lastDecision).toEqual({
        by: 'engine',
        at: '2026-05-02T10:05:00Z',
        reason: 'approval timeout (300s)',
      })
    })

    it('lastDecision tracks the latest event when several stack', async () => {
      await store.append(makeOperation({ id: 'op-1', status: 'pending' }))
      await store.appendStatusChange({ operationId: 'op-1', newStatus: 'approved', at: '2026-05-02T10:00:00Z', by: 'dashboard' })
      await store.appendStatusChange({ operationId: 'op-1', newStatus: 'executed', at: '2026-05-02T10:01:00Z', by: 'broker', reason: 'order-abc' })

      const all = await store.readAllOperations()
      expect(all[0].lastDecision?.by).toBe('broker')
      expect(all[0].lastDecision?.reason).toBe('order-abc')
    })

    it('lastDecision is absent when the op never had a status change', async () => {
      await store.append(makeOperation({ id: 'op-1', status: 'pending' }))

      const all = await store.readAllOperations()
      expect(all[0].lastDecision).toBeUndefined()
    })

    it('skips status-change events targeting an unknown operation', async () => {
      await store.appendStatusChange({ operationId: 'orphan', newStatus: 'approved', at: '2026-05-02T10:00:00Z', by: 'dashboard' })
      // Should not throw or include any operation
      expect(await store.readAllOperations()).toEqual([])
    })

    it('does not affect other operations', async () => {
      await store.append(makeOperation({ id: 'op-A', status: 'pending' }))
      await store.append(makeOperation({ id: 'op-B', status: 'pending' }))
      await store.appendStatusChange({ operationId: 'op-A', newStatus: 'rejected', at: '2026-05-02T10:00:00Z', by: 'dashboard', reason: 'human declined' })

      const all = await store.readAllOperations()
      const a = all.find((op) => op.id === 'op-A')!
      const b = all.find((op) => op.id === 'op-B')!
      expect(a.status).toBe('rejected')
      expect(b.status).toBe('pending')
    })

    it('replay() yields both operation and status-change records in order (audit trail)', async () => {
      await store.append(makeOperation({ id: 'op-1' }))
      await store.appendStatusChange({ operationId: 'op-1', newStatus: 'approved', at: '2026-05-02T10:00:00Z', by: 'dashboard' })
      await store.append(makeOperation({ id: 'op-2' }))

      const out: { kind: string; id: string }[] = []
      for await (const r of store.replay()) {
        if (r.kind === 'operation') out.push({ kind: r.kind, id: r.record.id })
        else out.push({ kind: r.kind, id: r.operationId })
      }
      expect(out).toEqual([
        { kind: 'operation', id: 'op-1' },
        { kind: 'status-change', id: 'op-1' },
        { kind: 'operation', id: 'op-2' },
      ])
    })
  })
})
