import * as ccxt from 'ccxt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Order as CcxtOrder, Ticker } from 'ccxt'
import type { Operation } from '../../../../../../shared/types.js'
import type { ExecutionConfig } from '../../../../core/execution-config.js'
import type { ICryptoBroker, PlaceOrderInput } from '../crypto-broker.js'
import { ExecutionError, OrderExecutor } from '../order-executor.js'

// ── Test helpers ──────────────────────────────────────────────────────────

function makeOp(overrides: Partial<Operation> = {}): Operation {
  return {
    id: '01OPTEST00000000000000000A',
    signalId: '01SIGTEST0000000000000000A',
    kolId: 'kol-1',
    accountId: 'acct-1',
    status: 'approved',
    createdAt: '2026-05-05T08:00:00Z',
    guardResults: [],
    spec: {
      action: 'placeOrder',
      symbol: 'BTC/USDT:USDT',
      side: 'long',
      contractType: 'perpetual',
      orderType: 'market',
      size: { unit: 'absolute', value: '50.00' },
      leverage: 5,
      stopLoss: { price: '49000' },
      takeProfits: [
        { level: 1, price: '52000' },
        { level: 2, price: '54000' },
        { level: 3, price: '56000' },
      ],
    },
    sizingContext: { equity: '1000.00', effectiveRiskPercent: '5.0000' },
    ...overrides,
  }
}

const DEFAULT_CFG: ExecutionConfig = {
  mode: 'live',
  slippageTolerancePercent: 1.0,
  maxOrderUsdt: 200,
  setLeverage: true,
  marginMode: 'isolated',
}

interface MockCalls {
  ticker: number
  setLeverage: PlaceOrderInput[] // unused shape, just for symmetry
  placeOrder: PlaceOrderInput[]
}

function makeMockBroker(
  tickerLast: number,
  placeOrderImpl?: (input: PlaceOrderInput) => Promise<CcxtOrder>,
): { broker: ICryptoBroker; calls: MockCalls; setLeverageMock: ReturnType<typeof vi.fn> } {
  const calls: MockCalls = { ticker: 0, setLeverage: [], placeOrder: [] }
  const setLeverageMock = vi.fn().mockResolvedValue(undefined)
  let nextOrderId = 1
  const broker: ICryptoBroker = {
    fetchTicker: vi.fn(async () => {
      calls.ticker++
      return { last: tickerLast } as Ticker
    }),
    setLeverage: setLeverageMock,
    placeOrder: vi.fn(async (input: PlaceOrderInput) => {
      calls.placeOrder.push(input)
      if (placeOrderImpl) return placeOrderImpl(input)
      return { id: `order-${nextOrderId++}` } as CcxtOrder
    }),
    cancelOrder: vi.fn(),
  }
  return { broker, calls, setLeverageMock }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('OrderExecutor', () => {
  let cfg: ExecutionConfig
  beforeEach(() => {
    cfg = { ...DEFAULT_CFG }
  })

  describe('dry-run', () => {
    it('skips broker entirely and returns DRYRUN- prefixed id', async () => {
      cfg.mode = 'dry-run'
      const { broker, calls } = makeMockBroker(50000)
      const exec = new OrderExecutor({ broker, loadExecutionConfig: async () => cfg })
      const result = await exec.execute(makeOp())

      expect(result.mainOrderId).toBe('DRYRUN-01OPTEST00000000000000000A')
      expect(calls.placeOrder).toHaveLength(0)
      // Ticker is still fetched (used to compute amount + connectivity check)
      expect(calls.ticker).toBe(1)
    })

    it('records the computed amount and refPrice', async () => {
      cfg.mode = 'dry-run'
      const { broker } = makeMockBroker(50000)
      const exec = new OrderExecutor({ broker, loadExecutionConfig: async () => cfg })
      const op = makeOp()
      // limit order at 50000, notional 50 → 0.001 BTC
      op.spec = { ...op.spec, action: 'placeOrder', orderType: 'limit', price: '50000' } as never
      const result = await exec.execute(op)

      expect(result.amount).toBe('0.00100000')
      expect(result.refPrice).toBe('50000.00')
    })
  })

  describe('live — main order', () => {
    it('converts USDT notional to base amount via ticker', async () => {
      const { broker, calls } = makeMockBroker(50000)
      const exec = new OrderExecutor({ broker, loadExecutionConfig: async () => cfg })
      const op = makeOp()
      // remove TPs to keep this test focused on the main order
      op.spec = { ...op.spec, action: 'placeOrder', takeProfits: [] } as never

      await exec.execute(op)
      // 50 USDT / 50000 = 0.001 BTC
      expect(calls.placeOrder[0]?.amount).toBeCloseTo(0.001, 8)
    })

    it('uses limit price (not ticker) for limit-order sizing', async () => {
      const { broker, calls } = makeMockBroker(50500)  // ticker drifts up
      const exec = new OrderExecutor({ broker, loadExecutionConfig: async () => cfg })
      const op = makeOp()
      op.spec = {
        ...op.spec,
        action: 'placeOrder',
        orderType: 'limit',
        price: '50000',
        takeProfits: [],
      } as never

      await exec.execute(op)
      // 50 USDT / 50000 (limit) = 0.001, not 50/50500
      expect(calls.placeOrder[0]?.amount).toBeCloseTo(0.001, 8)
      expect(calls.placeOrder[0]?.price).toBe(50000)
    })

    it('maps long → buy and short → sell', async () => {
      const { broker, calls } = makeMockBroker(50000)
      const exec = new OrderExecutor({ broker, loadExecutionConfig: async () => cfg })

      const opLong = makeOp()
      opLong.spec = { ...opLong.spec, action: 'placeOrder', takeProfits: [] } as never
      await exec.execute(opLong)
      expect(calls.placeOrder[0]?.side).toBe('buy')

      calls.placeOrder.length = 0
      const opShort = makeOp()
      opShort.spec = { ...opShort.spec, action: 'placeOrder', side: 'short', takeProfits: [] } as never
      await exec.execute(opShort)
      expect(calls.placeOrder[0]?.side).toBe('sell')
    })

    it('attaches stopLossPrice and takeProfitPrice (level 1) to the main order', async () => {
      const { broker, calls } = makeMockBroker(50000)
      const exec = new OrderExecutor({ broker, loadExecutionConfig: async () => cfg })

      await exec.execute(makeOp())
      const main = calls.placeOrder[0]!
      expect(main.params?.['stopLossPrice']).toBe(49000)
      expect(main.params?.['takeProfitPrice']).toBe(52000)
    })

    it('places extra TPs (level >= 2) as separate reduce-only limit orders', async () => {
      const { broker, calls } = makeMockBroker(50000)
      const exec = new OrderExecutor({ broker, loadExecutionConfig: async () => cfg })

      const result = await exec.execute(makeOp())
      // 1 main + 2 extras (TP2, TP3)
      expect(calls.placeOrder).toHaveLength(3)
      expect(result.extraTpOrderIds).toHaveLength(2)
      expect(calls.placeOrder[1]?.params?.['reduceOnly']).toBe(true)
      expect(calls.placeOrder[1]?.price).toBe(54000)  // TP2
      expect(calls.placeOrder[2]?.price).toBe(56000)  // TP3
    })

    it('reduce-only TPs use the closing side (long → sell, short → buy)', async () => {
      const { broker, calls } = makeMockBroker(50000)
      const exec = new OrderExecutor({ broker, loadExecutionConfig: async () => cfg })
      const op = makeOp()
      op.spec = { ...op.spec, action: 'placeOrder', side: 'short' } as never

      await exec.execute(op)
      expect(calls.placeOrder[0]?.side).toBe('sell')   // open
      expect(calls.placeOrder[1]?.side).toBe('buy')    // close TP2
    })

    it('continues on extra-TP failure but records main success', async () => {
      let n = 0
      const { broker, calls } = makeMockBroker(50000, async () => {
        n++
        if (n === 2) throw new ccxt.InvalidOrder('TP price too far')
        return { id: `o-${n}` } as CcxtOrder
      })
      const exec = new OrderExecutor({ broker, loadExecutionConfig: async () => cfg })

      const result = await exec.execute(makeOp())
      expect(result.mainOrderId).toBe('o-1')
      // TP2 failed, TP3 still placed
      expect(result.extraTpOrderIds).toEqual(['o-3'])
      expect(calls.placeOrder).toHaveLength(3)
    })
  })

  describe('safety knobs', () => {
    it('refuses orders above maxOrderUsdt', async () => {
      cfg.maxOrderUsdt = 30  // op notional is 50
      const { broker } = makeMockBroker(50000)
      const exec = new OrderExecutor({ broker, loadExecutionConfig: async () => cfg })

      await expect(exec.execute(makeOp())).rejects.toMatchObject({
        category: 'invalid-order',
        message: expect.stringContaining('maxOrderUsdt'),
      })
    })

    it('skips setLeverage when setLeverage=false', async () => {
      cfg.setLeverage = false
      const { broker, setLeverageMock } = makeMockBroker(50000)
      const exec = new OrderExecutor({ broker, loadExecutionConfig: async () => cfg })

      await exec.execute(makeOp())
      expect(setLeverageMock).not.toHaveBeenCalled()
    })

    it('skips setLeverage on spot operations', async () => {
      const { broker, setLeverageMock } = makeMockBroker(50000)
      const exec = new OrderExecutor({ broker, loadExecutionConfig: async () => cfg })
      const op = makeOp()
      op.spec = { ...op.spec, action: 'placeOrder', contractType: 'spot' } as never

      await exec.execute(op)
      expect(setLeverageMock).not.toHaveBeenCalled()
    })

    it('classifies main-order auth errors as auth (not retriable)', async () => {
      const { broker } = makeMockBroker(50000, async () => {
        throw new ccxt.AuthenticationError('bad key')
      })
      const exec = new OrderExecutor({ broker, loadExecutionConfig: async () => cfg })

      await expect(exec.execute(makeOp())).rejects.toMatchObject({
        category: 'auth',
      })
    })

    it('classifies main-order InsufficientFunds correctly', async () => {
      const { broker } = makeMockBroker(50000, async () => {
        throw new ccxt.InsufficientFunds('not enough')
      })
      const exec = new OrderExecutor({ broker, loadExecutionConfig: async () => cfg })

      const err = await exec.execute(makeOp()).catch((e) => e)
      expect(err).toBeInstanceOf(ExecutionError)
      expect((err as ExecutionError).category).toBe('insufficient')
    })

    it('rejects size.unit other than absolute', async () => {
      const { broker } = makeMockBroker(50000)
      const exec = new OrderExecutor({ broker, loadExecutionConfig: async () => cfg })
      const op = makeOp()
      op.spec = {
        ...op.spec,
        action: 'placeOrder',
        size: { unit: 'percent', value: '5' },
      } as never

      await expect(exec.execute(op)).rejects.toMatchObject({
        category: 'invalid-order',
      })
    })

    it('rejects when ticker has no usable price', async () => {
      const broker: ICryptoBroker = {
        fetchTicker: vi.fn(async () => ({ last: undefined, close: undefined, bid: undefined } as Ticker)),
        setLeverage: vi.fn(),
        placeOrder: vi.fn(),
        cancelOrder: vi.fn(),
      }
      const exec = new OrderExecutor({ broker, loadExecutionConfig: async () => cfg })

      await expect(exec.execute(makeOp())).rejects.toMatchObject({
        category: 'invalid-order',
        message: expect.stringContaining('no usable price'),
      })
    })
  })

  describe('non-placeOrder ops', () => {
    it('throws invalid-order for unsupported actions', async () => {
      const { broker } = makeMockBroker(50000)
      const exec = new OrderExecutor({ broker, loadExecutionConfig: async () => cfg })
      const op = makeOp()
      // @ts-expect-error — testing runtime guard
      op.spec = { action: 'closePosition', symbol: 'X' }

      await expect(exec.execute(op)).rejects.toMatchObject({
        category: 'invalid-order',
        message: expect.stringContaining('only handles placeOrder'),
      })
    })
  })
})
