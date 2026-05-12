import { describe, expect, it, vi } from 'vitest'
import type { KolConfig, Operation, Signal } from '../../../../../shared/types.js'
import { isResubmittable, MAX_RESUBMITS_PER_SIGNAL, ResubmitService } from '../resubmit-service.js'
import type { CopyTradingEngine } from '../engine.js'
import type { IOperationStore } from '../operation-store.js'
import type { ISignalStore, StoredRecord } from '../../signals/persistence/signal-store.js'
import { makeKol, makeOperation, makeSignal } from './helpers.js'

/**
 * The resubmit service composes 4 collaborators; we use lightweight
 * fakes for each so we can drive the validation paths from the test
 * surface without booting an exchange / pipeline.
 *
 * The validation logic is what's interesting here — the engine call
 * itself is just a passthrough. Tests therefore concentrate on:
 *   - which rejected ops are eligible
 *   - signal/kol lookup paths
 *   - the per-signal attempt cap
 *   - happy path produces a new op via engine.process
 */

function makeFakeOperationStore(ops: Operation[]): IOperationStore {
  return {
    append: vi.fn(),
    appendStatusChange: vi.fn(),
    replay: async function* () {
      // Not used by ResubmitService.
    },
    readAllOperations: vi.fn().mockResolvedValue(ops),
  }
}

function makeFakeSignalStore(signals: Signal[]): ISignalStore {
  return {
    appendSignal: vi.fn(),
    appendUpdate: vi.fn(),
    replay: async function* () {
      for (const s of signals) {
        yield { kind: 'signal', record: s } satisfies StoredRecord
      }
    },
  }
}

function makeFakeEngine(returnOp: Operation | null = makeOperation({ id: 'op-new' })): CopyTradingEngine {
  // Only `.process()` is invoked; we cast to keep the test ergonomic.
  return {
    process: vi.fn().mockResolvedValue(returnOp),
  } as unknown as CopyTradingEngine
}

function makeFakeEventLog() {
  return {
    append: vi.fn(),
  }
}

function timedOutOp(over: Partial<Operation> = {}): Operation {
  return makeOperation({
    status: 'rejected',
    lastDecision: {
      by: 'engine',
      at: '2026-05-02T10:05:00.000Z',
      reason: 'approval timeout (300s)',
    },
    ...over,
  })
}

describe('ResubmitService', () => {
  it('happy path: resubmits a timed-out op and returns the new operation', async () => {
    const op = timedOutOp({ id: 'op-old', signalId: 'sig-1' })
    const signal = makeSignal({ id: 'sig-1' })
    const newOp = makeOperation({ id: 'op-fresh' })
    const engine = makeFakeEngine(newOp)
    const events = makeFakeEventLog()

    const svc = new ResubmitService({
      store: makeFakeOperationStore([op]),
      signalStore: makeFakeSignalStore([signal]),
      engine,
      events: events as never,
      getKol: () => makeKol(),
    })

    const result = await svc.resubmit('op-old')
    expect(result).toEqual({ ok: true, operation: newOp })
    expect(engine.process).toHaveBeenCalledOnce()
    expect(events.append).toHaveBeenCalledWith(
      'operation.resubmitted',
      expect.objectContaining({
        originalOperationId: 'op-old',
        newOperationId: 'op-fresh',
        signalId: 'sig-1',
        attemptNumber: 2,
      }),
    )
  })

  it('refreshes priceCheck via priceService before resubmitting', async () => {
    const op = timedOutOp({ id: 'op-old', signalId: 'sig-1' })
    const signal = makeSignal({ id: 'sig-1' })
    const engine = makeFakeEngine()
    const priceService = {
      getPrice: vi.fn().mockResolvedValue({
        ccxtSymbol: 'BTC/USDT:USDT',
        base: 'BTC',
        quote: 'USDT',
        price: '76521',
        source: 'binance',
        fetchedAt: '2026-05-02T10:30:00.000Z',
        fromCache: false,
      }),
    }

    const svc = new ResubmitService({
      store: makeFakeOperationStore([op]),
      signalStore: makeFakeSignalStore([signal]),
      engine,
      events: makeFakeEventLog() as never,
      getKol: () => makeKol(),
      priceService,
    })

    await svc.resubmit('op-old')
    // engine.process was called with the signal containing a refreshed priceCheck
    const calledWith = (engine.process as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Signal
    expect(calledWith.priceCheck?.currentPrice).toBe('76521')
    expect(calledWith.priceCheck?.source).toBe('binance')
  })

  it('rejects when the operation does not exist', async () => {
    const svc = new ResubmitService({
      store: makeFakeOperationStore([]),
      signalStore: makeFakeSignalStore([]),
      engine: makeFakeEngine(),
      events: makeFakeEventLog() as never,
      getKol: () => undefined,
    })
    expect(await svc.resubmit('nope')).toEqual({ ok: false, code: 'op-not-found' })
  })

  it('rejects ops that are still pending — only timed-out ones are eligible', async () => {
    const op = makeOperation({ id: 'op-old', status: 'pending' })
    const svc = new ResubmitService({
      store: makeFakeOperationStore([op]),
      signalStore: makeFakeSignalStore([makeSignal()]),
      engine: makeFakeEngine(),
      events: makeFakeEventLog() as never,
      getKol: () => makeKol(),
    })
    const r = await svc.resubmit('op-old')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('not-resubmittable')
      if (r.code === 'not-resubmittable') {
        expect(r.currentStatus).toBe('pending')
      }
    }
  })

  it('accepts broker-failed ops (main order rejected by exchange)', async () => {
    // executor only marks `failed` when the main order didn't fill, so
    // resubmit is safe — no broker-side state to reconcile.
    const op = makeOperation({
      id: 'op-old',
      status: 'failed',
      lastDecision: {
        by: 'broker',
        at: '2026-05-12T10:00:00.000Z',
        reason: '[invalid-order] main order failed: bitget amount of BTC/USDT:USDT must be greater than minimum amount precision of 0.0001',
      },
    })
    const newOp = makeOperation({ id: 'op-fresh' })
    const svc = new ResubmitService({
      store: makeFakeOperationStore([op]),
      signalStore: makeFakeSignalStore([makeSignal()]),
      engine: makeFakeEngine(newOp),
      events: makeFakeEventLog() as never,
      getKol: () => makeKol(),
    })
    const r = await svc.resubmit('op-old')
    expect(r).toEqual({ ok: true, operation: newOp })
  })

  it('rejects failed ops whose lastDecision was NOT a broker call (shape-guard)', async () => {
    // Defensive: status='failed' without broker authorship is an
    // ill-formed record. Don't pretend it's resubmittable.
    const op = makeOperation({
      id: 'op-old',
      status: 'failed',
      lastDecision: { by: 'engine', at: '2026-05-12T10:00:00.000Z' },
    })
    const svc = new ResubmitService({
      store: makeFakeOperationStore([op]),
      signalStore: makeFakeSignalStore([makeSignal()]),
      engine: makeFakeEngine(),
      events: makeFakeEventLog() as never,
      getKol: () => makeKol(),
    })
    const r = await svc.resubmit('op-old')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not-resubmittable')
  })

  it('rejects approved/executed ops', async () => {
    const op = makeOperation({ id: 'op-old', status: 'executed' })
    const svc = new ResubmitService({
      store: makeFakeOperationStore([op]),
      signalStore: makeFakeSignalStore([makeSignal()]),
      engine: makeFakeEngine(),
      events: makeFakeEventLog() as never,
      getKol: () => makeKol(),
    })
    const r = await svc.resubmit('op-old')
    expect(r.ok).toBe(false)
  })

  it('rejects guard-rejected ops (not timed out — guard means engine considered & blocked)', async () => {
    // Guard rejection → status='rejected', but lastDecision is absent
    // (status was set at creation time, not via appendStatusChange).
    const op = makeOperation({
      id: 'op-old',
      status: 'rejected',
      guardRejection: { guardName: 'stale-signal', reason: 'market past entry' },
    })
    const svc = new ResubmitService({
      store: makeFakeOperationStore([op]),
      signalStore: makeFakeSignalStore([makeSignal()]),
      engine: makeFakeEngine(),
      events: makeFakeEventLog() as never,
      getKol: () => makeKol(),
    })
    const r = await svc.resubmit('op-old')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not-resubmittable')
  })

  it('rejects human-rejected ops (lastDecision.by is dashboard/telegram, not engine)', async () => {
    const op = makeOperation({
      id: 'op-old',
      status: 'rejected',
      lastDecision: {
        by: 'dashboard',
        at: '2026-05-02T10:01:00.000Z',
        reason: 'operator said no',
      },
    })
    const svc = new ResubmitService({
      store: makeFakeOperationStore([op]),
      signalStore: makeFakeSignalStore([makeSignal()]),
      engine: makeFakeEngine(),
      events: makeFakeEventLog() as never,
      getKol: () => makeKol(),
    })
    const r = await svc.resubmit('op-old')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not-resubmittable')
  })

  it('rejects engine-rejected ops with non-timeout reasons', async () => {
    // The engine could also self-reject for non-timeout reasons (currently
    // only timeout exists, but the rule rejects anything not starting with
    // "approval timeout").
    const op = makeOperation({
      id: 'op-old',
      status: 'rejected',
      lastDecision: {
        by: 'engine',
        at: '2026-05-02T10:01:00.000Z',
        reason: 'some-other-engine-reason',
      },
    })
    const svc = new ResubmitService({
      store: makeFakeOperationStore([op]),
      signalStore: makeFakeSignalStore([makeSignal()]),
      engine: makeFakeEngine(),
      events: makeFakeEventLog() as never,
      getKol: () => makeKol(),
    })
    const r = await svc.resubmit('op-old')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not-resubmittable')
  })

  it(`caps resubmits at ${MAX_RESUBMITS_PER_SIGNAL} per signal`, async () => {
    // Three existing ops all from sig-1 → next resubmit is the 4th attempt, blocked
    const ops = [
      timedOutOp({ id: 'op-1', signalId: 'sig-1' }),
      timedOutOp({ id: 'op-2', signalId: 'sig-1' }),
      timedOutOp({ id: 'op-3', signalId: 'sig-1' }),
    ]
    const svc = new ResubmitService({
      store: makeFakeOperationStore(ops),
      signalStore: makeFakeSignalStore([makeSignal({ id: 'sig-1' })]),
      engine: makeFakeEngine(),
      events: makeFakeEventLog() as never,
      getKol: () => makeKol(),
    })
    const r = await svc.resubmit('op-3')
    expect(r.ok).toBe(false)
    if (!r.ok && r.code === 'max-attempts-reached') {
      expect(r.attemptCount).toBe(3)
    } else {
      throw new Error(`expected max-attempts-reached, got ${JSON.stringify(r)}`)
    }
  })

  it('allows up to MAX_RESUBMITS_PER_SIGNAL attempts inclusive of the original', async () => {
    // Two existing ops (original + 1 resubmit) → 3rd attempt allowed
    const ops = [
      timedOutOp({ id: 'op-1', signalId: 'sig-1' }),
      timedOutOp({ id: 'op-2', signalId: 'sig-1' }),
    ]
    const svc = new ResubmitService({
      store: makeFakeOperationStore(ops),
      signalStore: makeFakeSignalStore([makeSignal({ id: 'sig-1' })]),
      engine: makeFakeEngine(makeOperation({ id: 'op-fresh' })),
      events: makeFakeEventLog() as never,
      getKol: () => makeKol(),
    })
    const r = await svc.resubmit('op-2')
    expect(r.ok).toBe(true)
  })

  it('rejects when the original signal can no longer be found', async () => {
    const op = timedOutOp({ id: 'op-old', signalId: 'sig-gone' })
    const svc = new ResubmitService({
      store: makeFakeOperationStore([op]),
      signalStore: makeFakeSignalStore([]),  // empty store
      engine: makeFakeEngine(),
      events: makeFakeEventLog() as never,
      getKol: () => makeKol(),
    })
    const r = await svc.resubmit('op-old')
    expect(r.ok).toBe(false)
    if (!r.ok && r.code === 'signal-not-found') {
      expect(r.signalId).toBe('sig-gone')
    } else {
      throw new Error(`expected signal-not-found, got ${JSON.stringify(r)}`)
    }
  })

  it('rejects when the KOL has been removed from the registry', async () => {
    const op = timedOutOp({ id: 'op-old', signalId: 'sig-1' })
    const svc = new ResubmitService({
      store: makeFakeOperationStore([op]),
      signalStore: makeFakeSignalStore([makeSignal({ id: 'sig-1', kolId: 'kol-gone' })]),
      engine: makeFakeEngine(),
      events: makeFakeEventLog() as never,
      getKol: (id) => (id === 'kol-gone' ? undefined : makeKol()),
    })
    const r = await svc.resubmit('op-old')
    expect(r.ok).toBe(false)
    if (!r.ok && r.code === 'kol-not-found') {
      expect(r.kolId).toBe('kol-gone')
    }
  })

  it('does not count ops for OTHER signals against this signal\'s cap', async () => {
    // Same KOL, two different signals — both at the cap individually
    // should still be independently allowed (each one is a separate
    // attempt chain).
    const ops = [
      timedOutOp({ id: 'op-A1', signalId: 'sig-A' }),
      timedOutOp({ id: 'op-A2', signalId: 'sig-A' }),
      timedOutOp({ id: 'op-B1', signalId: 'sig-B' }),  // unrelated
    ]
    const svc = new ResubmitService({
      store: makeFakeOperationStore(ops),
      signalStore: makeFakeSignalStore([
        makeSignal({ id: 'sig-A' }),
        makeSignal({ id: 'sig-B' }),
      ]),
      engine: makeFakeEngine(makeOperation({ id: 'op-fresh' })),
      events: makeFakeEventLog() as never,
      getKol: () => makeKol(),
    })
    // sig-A has 2 ops; resubmitting op-A2 produces a 3rd → allowed.
    const r = await svc.resubmit('op-A2')
    expect(r.ok).toBe(true)
  })

  it('isResubmittable predicate matches the route\'s eligibility rule', () => {
    // pending: no
    expect(isResubmittable(makeOperation({ status: 'pending' }))).toBe(false)
    // approved: no
    expect(isResubmittable(makeOperation({ status: 'approved' }))).toBe(false)
    // executed: no
    expect(isResubmittable(makeOperation({ status: 'executed' }))).toBe(false)
    // guard rejection: no
    expect(
      isResubmittable(makeOperation({
        status: 'rejected',
        guardRejection: { guardName: 'cooldown', reason: 'active' },
      })),
    ).toBe(false)
    // human rejection: no
    expect(
      isResubmittable(makeOperation({
        status: 'rejected',
        lastDecision: { by: 'dashboard', at: '2026-05-02T10:00:00.000Z' },
      })),
    ).toBe(false)
    // approval timeout: yes
    expect(
      isResubmittable(makeOperation({
        status: 'rejected',
        lastDecision: { by: 'engine', at: '2026-05-02T10:00:00.000Z', reason: 'approval timeout (300s)' },
      })),
    ).toBe(true)
    // broker failure: yes
    expect(
      isResubmittable(makeOperation({
        status: 'failed',
        lastDecision: { by: 'broker', at: '2026-05-12T10:00:00.000Z', reason: '[invalid-order] …' },
      })),
    ).toBe(true)
    // failed without broker authorship: no (defensive)
    expect(
      isResubmittable(makeOperation({
        status: 'failed',
        lastDecision: { by: 'engine', at: '2026-05-12T10:00:00.000Z' },
      })),
    ).toBe(false)
  })

  it('passes the fetched KOL through to engine.process', async () => {
    const op = timedOutOp({ id: 'op-old', signalId: 'sig-1' })
    const signal = makeSignal({ id: 'sig-1', kolId: 'kol-special' })
    const expectedKol = makeKol({ id: 'kol-special', riskMultiplier: 2 })
    const engine = makeFakeEngine()
    const svc = new ResubmitService({
      store: makeFakeOperationStore([op]),
      signalStore: makeFakeSignalStore([signal]),
      engine,
      events: makeFakeEventLog() as never,
      getKol: (id) => (id === 'kol-special' ? expectedKol : undefined),
    })
    await svc.resubmit('op-old')
    const calls = (engine.process as ReturnType<typeof vi.fn>).mock.calls
    const passedKol = calls[0]?.[1] as KolConfig
    expect(passedKol.id).toBe('kol-special')
    expect(passedKol.riskMultiplier).toBe(2)
  })
})
