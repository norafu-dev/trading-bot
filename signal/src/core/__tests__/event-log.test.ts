import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createEventLog } from '../event-log.js'

let testDir: string

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'trading-bot-test-evtlog-'))
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('createEventLog', () => {
  it('appends entries and increments seq', async () => {
    const log = await createEventLog({ logPath: join(testDir, 'events.jsonl') })
    const e1 = await log.append('test.event', { x: 1 })
    const e2 = await log.append('test.event', { x: 2 })
    expect(e1.seq).toBe(1)
    expect(e2.seq).toBe(2)
    await log.close()
  })

  it('reads entries from disk', async () => {
    const logPath = join(testDir, 'events.jsonl')
    const log = await createEventLog({ logPath })
    await log.append('a', 1)
    await log.append('b', 2)
    await log.append('a', 3)
    const all = await log.read()
    expect(all).toHaveLength(3)
    const typed = await log.read({ type: 'a' })
    expect(typed).toHaveLength(2)
    const limited = await log.read({ limit: 1 })
    expect(limited).toHaveLength(1)
    await log.close()
  })

  it('recent() queries from in-memory buffer without disk I/O', async () => {
    const log = await createEventLog({ logPath: join(testDir, 'events.jsonl') })
    await log.append('x', 'payload')
    const entries = log.recent()
    expect(entries).toHaveLength(1)
    expect(entries[0].payload).toBe('payload')
    await log.close()
  })

  it('recovers seq and buffer from existing file on reopen', async () => {
    const logPath = join(testDir, 'events.jsonl')
    const log1 = await createEventLog({ logPath })
    await log1.append('ev', 'a')
    await log1.append('ev', 'b')
    expect(log1.lastSeq()).toBe(2)
    await log1.close()

    const log2 = await createEventLog({ logPath })
    expect(log2.lastSeq()).toBe(2)
    const e3 = await log2.append('ev', 'c')
    expect(e3.seq).toBe(3)
    await log2.close()
  })

  it('query() returns paginated results newest-first', async () => {
    const log = await createEventLog({ logPath: join(testDir, 'events.jsonl') })
    for (let i = 0; i < 5; i++) await log.append('item', i)
    const page = await log.query({ page: 1, pageSize: 3 })
    expect(page.total).toBe(5)
    expect(page.entries).toHaveLength(3)
    expect(page.entries[0].payload).toBe(4)
    await log.close()
  })

  it('subscribe() fires on new appends and unsubscribe stops it', async () => {
    const log = await createEventLog({ logPath: join(testDir, 'events.jsonl') })
    const received: unknown[] = []
    const unsub = log.subscribe((e) => received.push(e.payload))
    await log.append('t', 'hello')
    unsub()
    await log.append('t', 'world')
    expect(received).toEqual(['hello'])
    await log.close()
  })

  it('subscribeType() only fires for the matching type', async () => {
    const log = await createEventLog({ logPath: join(testDir, 'events.jsonl') })
    const hits: unknown[] = []
    log.subscribeType('signal.received', (e) => hits.push(e.payload))
    await log.append('signal.received', 'A')
    await log.append('other.event', 'B')
    expect(hits).toEqual(['A'])
    await log.close()
  })
})
