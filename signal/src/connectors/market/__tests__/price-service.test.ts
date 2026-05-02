import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CcxtPriceService } from '../price-service.js'

interface FakeExchange {
  fetchTicker: ReturnType<typeof vi.fn>
}

function makeFakeExchange(opts: { last?: number; throws?: Error } = {}): FakeExchange {
  return {
    fetchTicker: vi.fn().mockImplementation(async () => {
      if (opts.throws) throw opts.throws
      return { last: opts.last ?? 76521.5 }
    }),
  }
}

describe('CcxtPriceService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns a quote on first call', async () => {
    const ex = makeFakeExchange({ last: 76521.5 })
    const svc = new CcxtPriceService({ instance: ex })
    const q = await svc.getPrice('BTC')

    expect(q).not.toBeNull()
    expect(q?.base).toBe('BTC')
    expect(q?.price).toBe('76521.5')
    expect(q?.fromCache).toBe(false)
    expect(ex.fetchTicker).toHaveBeenCalledOnce()
    expect(ex.fetchTicker).toHaveBeenCalledWith('BTC/USDT:USDT')
  })

  it('serves from cache within TTL', async () => {
    const ex = makeFakeExchange({ last: 76521.5 })
    const svc = new CcxtPriceService({ instance: ex, cacheTtlMs: 30_000 })

    await svc.getPrice('BTC')
    const second = await svc.getPrice('BTC')

    expect(second?.fromCache).toBe(true)
    expect(ex.fetchTicker).toHaveBeenCalledOnce()
  })

  it('refetches after TTL expires', async () => {
    const ex = makeFakeExchange({ last: 76521.5 })
    const svc = new CcxtPriceService({ instance: ex, cacheTtlMs: 30_000 })

    await svc.getPrice('BTC')
    vi.advanceTimersByTime(31_000)
    await svc.getPrice('BTC')

    expect(ex.fetchTicker).toHaveBeenCalledTimes(2)
  })

  it('different symbols are cached independently', async () => {
    const ex = makeFakeExchange({ last: 1 })
    const svc = new CcxtPriceService({ instance: ex })

    await svc.getPrice('BTC')
    await svc.getPrice('ETH')

    expect(ex.fetchTicker).toHaveBeenCalledTimes(2)
  })

  it('treats Chinese / decorated / flat shapes as same canonical key', async () => {
    const ex = makeFakeExchange({ last: 76521 })
    const svc = new CcxtPriceService({ instance: ex })

    await svc.getPrice('比特币')
    await svc.getPrice('$BTC')
    await svc.getPrice('BTCUSDT')

    // All collapse to BTC/USDT:USDT (perpetual default), so only one network call
    expect(ex.fetchTicker).toHaveBeenCalledOnce()
  })

  it('returns null when ticker fetch throws', async () => {
    const ex = makeFakeExchange({ throws: new Error('BadSymbol') })
    const svc = new CcxtPriceService({ instance: ex })

    const q = await svc.getPrice('NONEXISTENTCOIN')
    expect(q).toBeNull()
  })

  it('returns null when symbol cannot be normalised', async () => {
    const ex = makeFakeExchange({ last: 1 })
    const svc = new CcxtPriceService({ instance: ex })

    const q = await svc.getPrice('???')
    expect(q).toBeNull()
    expect(ex.fetchTicker).not.toHaveBeenCalled()
  })

  it('returns null when ticker has no usable last price', async () => {
    const ex: FakeExchange = {
      fetchTicker: vi.fn().mockResolvedValue({ last: 0 }),
    }
    const svc = new CcxtPriceService({ instance: ex })
    expect(await svc.getPrice('BTC')).toBeNull()
  })

  it('falls back to ticker.close when last is missing', async () => {
    const ex: FakeExchange = {
      fetchTicker: vi.fn().mockResolvedValue({ close: 100 }),
    }
    const svc = new CcxtPriceService({ instance: ex })
    const q = await svc.getPrice('BTC')
    expect(q?.price).toBe('100')
  })
})
