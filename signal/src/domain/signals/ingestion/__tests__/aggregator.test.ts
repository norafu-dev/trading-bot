import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { MessageAggregator } from '../aggregator/index.js'
import type { MessageBundle } from '../aggregator/types.js'
import { makeMessage, resetSeq } from './helpers.js'

beforeEach(() => {
  vi.useFakeTimers()
  resetSeq()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('MessageAggregator — idle timeout', () => {
  it('emits a bundle after idle timeout with all ingested messages', async () => {
    const agg = new MessageAggregator({ idleTimeoutMs: 500, maxDurationMs: 5000 })
    const bundles: MessageBundle[] = []
    agg.onBundleClosed(async (b) => { bundles.push(b) })

    await agg.ingest(makeMessage({ authorId: 'kol-a', channelId: 'ch-1', messageId: 'msg-1' }))
    await agg.ingest(makeMessage({ authorId: 'kol-a', channelId: 'ch-1', messageId: 'msg-2' }))

    await vi.runAllTimersAsync()

    expect(bundles).toHaveLength(1)
    expect(bundles[0].messages).toHaveLength(2)
    expect(bundles[0].kolId).toBe('kol-a')
    expect(bundles[0].channelId).toBe('ch-1')
    expect(bundles[0].closeReason).toBe('idle_timeout')
  })

  it('resets idle timer when a new message arrives', async () => {
    const agg = new MessageAggregator({ idleTimeoutMs: 200, maxDurationMs: 5000 })
    const bundles: MessageBundle[] = []
    agg.onBundleClosed(async (b) => { bundles.push(b) })

    await agg.ingest(makeMessage({ authorId: 'kol-a', channelId: 'ch-1' }))
    // advance 150ms — should NOT fire yet
    await vi.advanceTimersByTimeAsync(150)
    expect(bundles).toHaveLength(0)

    // Ingest second message, resetting idle timer
    await agg.ingest(makeMessage({ authorId: 'kol-a', channelId: 'ch-1' }))
    // advance another 150ms — still within new 200ms window
    await vi.advanceTimersByTimeAsync(150)
    expect(bundles).toHaveLength(0)

    // Now let the full idle timeout expire
    await vi.advanceTimersByTimeAsync(200)
    expect(bundles).toHaveLength(1)
    expect(bundles[0].messages).toHaveLength(2)
  })
})

describe('MessageAggregator — max duration', () => {
  it('emits a bundle when maxDurationMs is reached regardless of idle activity', async () => {
    const agg = new MessageAggregator({ idleTimeoutMs: 5000, maxDurationMs: 300 })
    const bundles: MessageBundle[] = []
    agg.onBundleClosed(async (b) => { bundles.push(b) })

    await agg.ingest(makeMessage({ authorId: 'kol-a', channelId: 'ch-1' }))
    // Keep sending messages before idle timeout fires
    await vi.advanceTimersByTimeAsync(100)
    await agg.ingest(makeMessage({ authorId: 'kol-a', channelId: 'ch-1' }))
    await vi.advanceTimersByTimeAsync(100)
    await agg.ingest(makeMessage({ authorId: 'kol-a', channelId: 'ch-1' }))

    expect(bundles).toHaveLength(0)

    // Hit max duration
    await vi.advanceTimersByTimeAsync(200)
    expect(bundles).toHaveLength(1)
    expect(bundles[0].closeReason).toBe('max_duration')
    expect(bundles[0].messages).toHaveLength(3)
  })
})

describe('MessageAggregator — independent windows', () => {
  it('maintains separate windows per (kolId, channelId)', async () => {
    const agg = new MessageAggregator({ idleTimeoutMs: 200, maxDurationMs: 5000 })
    const bundles: MessageBundle[] = []
    agg.onBundleClosed(async (b) => { bundles.push(b) })

    await agg.ingest(makeMessage({ authorId: 'kol-a', channelId: 'ch-1' }))
    await agg.ingest(makeMessage({ authorId: 'kol-b', channelId: 'ch-1' }))
    await agg.ingest(makeMessage({ authorId: 'kol-a', channelId: 'ch-2' }))

    await vi.runAllTimersAsync()

    expect(bundles).toHaveLength(3)
    const kolAch1 = bundles.find((b) => b.kolId === 'kol-a' && b.channelId === 'ch-1')
    const kolBch1 = bundles.find((b) => b.kolId === 'kol-b' && b.channelId === 'ch-1')
    const kolAch2 = bundles.find((b) => b.kolId === 'kol-a' && b.channelId === 'ch-2')
    expect(kolAch1?.messages).toHaveLength(1)
    expect(kolBch1?.messages).toHaveLength(1)
    expect(kolAch2?.messages).toHaveLength(1)
  })
})

describe('MessageAggregator — per-KOL overrides', () => {
  it('uses per-KOL idleTimeoutMs when configured', async () => {
    const agg = new MessageAggregator({
      idleTimeoutMs: 1000,
      maxDurationMs: 10000,
      perKolOverrides: { 'fast-kol': { idleTimeoutMs: 100 } },
    })
    const bundles: MessageBundle[] = []
    agg.onBundleClosed(async (b) => { bundles.push(b) })

    await agg.ingest(makeMessage({ authorId: 'fast-kol', channelId: 'ch-1' }))
    // Default would wait 1000ms, override waits 100ms
    await vi.advanceTimersByTimeAsync(150)
    expect(bundles).toHaveLength(1)
    expect(bundles[0].closeReason).toBe('idle_timeout')
  })
})

describe('MessageAggregator — flushAll', () => {
  it('emits all open windows immediately on flushAll()', async () => {
    const agg = new MessageAggregator({ idleTimeoutMs: 5000, maxDurationMs: 30000 })
    const bundles: MessageBundle[] = []
    agg.onBundleClosed(async (b) => { bundles.push(b) })

    await agg.ingest(makeMessage({ authorId: 'kol-a', channelId: 'ch-1' }))
    await agg.ingest(makeMessage({ authorId: 'kol-b', channelId: 'ch-2' }))

    expect(bundles).toHaveLength(0)
    await agg.flushAll()

    expect(bundles).toHaveLength(2)
    expect(bundles.map((b) => b.closeReason)).toEqual(['forced_flush', 'forced_flush'])
  })

  it('does not double-emit after flushAll if idle timer also fires', async () => {
    const agg = new MessageAggregator({ idleTimeoutMs: 200, maxDurationMs: 5000 })
    const bundles: MessageBundle[] = []
    agg.onBundleClosed(async (b) => { bundles.push(b) })

    await agg.ingest(makeMessage({ authorId: 'kol-a', channelId: 'ch-1' }))
    await agg.flushAll()
    // Timer would have fired — should NOT emit again
    await vi.runAllTimersAsync()

    expect(bundles).toHaveLength(1)
  })
})

describe('MessageAggregator — runtime override updates', () => {
  it('updatePerKolOverrides applies to next opened window', async () => {
    const agg = new MessageAggregator({ idleTimeoutMs: 100, maxDurationMs: 10_000 })
    const bundles: MessageBundle[] = []
    agg.onBundleClosed(async (b) => { bundles.push(b) })

    // Hot-reload: kol-slow gets a much longer idle timeout
    agg.updatePerKolOverrides({ 'kol-slow': { idleTimeoutMs: 5_000 } })

    await agg.ingest(makeMessage({ authorId: 'kol-slow' }))
    // Default (100ms) would have fired by now — but slow override raised it
    await vi.advanceTimersByTimeAsync(150)
    expect(bundles).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(bundles).toHaveLength(1)
  })

  it('updatePerKolOverrides replaces, not merges', async () => {
    const agg = new MessageAggregator({
      idleTimeoutMs: 100,
      maxDurationMs: 10_000,
      perKolOverrides: { 'kol-a': { idleTimeoutMs: 5_000 } },
    })
    const bundles: MessageBundle[] = []
    agg.onBundleClosed(async (b) => { bundles.push(b) })

    // Replace with overrides for a DIFFERENT kol — kol-a now uses default again
    agg.updatePerKolOverrides({ 'kol-b': { idleTimeoutMs: 5_000 } })

    await agg.ingest(makeMessage({ authorId: 'kol-a' }))
    await vi.advanceTimersByTimeAsync(150)
    expect(bundles).toHaveLength(1)  // closed via default 100ms
  })
})

describe('MessageAggregator — handler errors', () => {
  it('does not crash when an onBundleClosed handler throws', async () => {
    const agg = new MessageAggregator({ idleTimeoutMs: 100, maxDurationMs: 5000 })
    agg.onBundleClosed(async () => { throw new Error('handler blew up') })

    const good: MessageBundle[] = []
    agg.onBundleClosed(async (b) => { good.push(b) })

    await agg.ingest(makeMessage())
    await vi.runAllTimersAsync()

    expect(good).toHaveLength(1)
  })
})
