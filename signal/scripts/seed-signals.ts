/**
 * Seed dev fixture: writes a handful of Signal + PositionUpdate records to
 * `data/signals/signals.jsonl` and matching events to `data/event-log/events.jsonl`
 * so the dashboard signal-feed page has something to render before the
 * full Discord → router pipeline is wired (Batch 7).
 *
 * Run from the signal package dir:
 *   pnpm tsx scripts/seed-signals.ts
 *
 * Idempotent: deletes the existing files first so re-running gives the same
 * deterministic state. Safe to re-run; will not duplicate records.
 */

import { rm } from 'node:fs/promises'
import { ulid } from 'ulid'
import type { PositionUpdate, Signal } from '../../shared/types.js'
import { createEventLog } from '../src/core/event-log.js'
import { PATHS } from '../src/core/paths.js'
import { SignalIndex } from '../src/domain/signals/linking/signal-index.js'
import { ByExternalIdStrategy } from '../src/domain/signals/linking/strategies/by-external-id.js'
import { ByKolSymbolStrategy } from '../src/domain/signals/linking/strategies/by-kol-symbol.js'
import { UpdateLinker } from '../src/domain/signals/linking/update-linker.js'
import { SignalStore } from '../src/domain/signals/persistence/signal-store.js'
import { ResultRouter } from '../src/domain/signals/routing/result-router.js'
import type { ParseResult } from '../src/domain/signals/parsing/types.js'

// Real KOL ids from data/kols/kols.json so the dashboard can show avatars
const KOL_NEIL = '1417528451589476555'
const KOL_NORA = '1103586884170563635'
const KOL_SHUQIN = '1459527572344930348'
const KOL_GAULS = '1373381976144478329'

function toIso(offsetMin: number): string {
  const base = new Date('2026-04-30T08:00:00.000Z')
  return new Date(base.getTime() + offsetMin * 60_000).toISOString()
}

function makeSignal(over: Partial<Signal>): Signal {
  return {
    id: ulid(),
    source: 'discord',
    channelId: '1223443949415436308',
    messageId: ulid(),
    bundleId: ulid(),
    kolId: KOL_NEIL,
    rawText: '',
    parsedAt: toIso(0),
    parserType: 'llm_text',
    action: 'open',
    symbol: 'BTC',
    confidence: 0.9,
    ...over,
  }
}

function makeUpdate(over: Partial<PositionUpdate>): PositionUpdate {
  return {
    id: ulid(),
    kolId: KOL_NEIL,
    receivedAt: toIso(30),
    source: 'discord',
    channelId: '1223443949415436308',
    bundleId: ulid(),
    parserType: 'llm_text',
    updateType: 'tp_hit',
    confidence: 0.88,
    ...over,
  }
}

function asSignalResult(signal: Signal): Extract<ParseResult, { kind: 'signal' }> {
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

function asUpdateResult(update: PositionUpdate): Extract<ParseResult, { kind: 'update' }> {
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

async function main() {
  console.log('[seed] removing existing signals + event-log files…')
  await rm(PATHS.signalsLog, { force: true })
  await rm(PATHS.eventLog, { force: true })

  const store = new SignalStore(PATHS.signalsLog)
  const events = await createEventLog({ logPath: PATHS.eventLog })
  const index = new SignalIndex()
  const linker = new UpdateLinker([new ByExternalIdStrategy(), new ByKolSymbolStrategy()])
  const router = new ResultRouter(store, linker, index, events)

  // ── Signal 1: BTC long by Neil — open, no updates yet ──
  const sig1 = makeSignal({
    kolId: KOL_NEIL,
    parsedAt: toIso(0),
    symbol: 'BTC',
    side: 'long',
    contractType: 'perpetual',
    rawText: 'BTC 多 入场 76500-77000 止损 75500 TP1 78500 TP2 80000 20x',
    action: 'open',
    entry: { type: 'limit', priceRangeLow: '76500', priceRangeHigh: '77000' },
    stopLoss: { price: '75500' },
    takeProfits: [
      { level: 1, price: '78500' },
      { level: 2, price: '80000' },
    ],
    leverage: 20,
    size: { type: 'percent', value: '5' },
    confidence: 0.93,
    extractedFrom: 'text_only',
    reasoning: 'Clear entry range, SL, two TPs and 20x leverage stated explicitly',
  })
  await router.route(asSignalResult(sig1))

  // ── Signal 2: ETH short by Nora — gets two updates (TP1 hit, then closed) ──
  const sig2 = makeSignal({
    kolId: KOL_NORA,
    parsedAt: toIso(15),
    symbol: 'ETH',
    side: 'short',
    contractType: 'perpetual',
    rawText: 'ETH/USDT SHORT\nEntry: 3250-3280\nSL: 3350\nTP1: 3150 | TP2: 3050\nLev: 10x',
    action: 'open',
    entry: { type: 'limit', priceRangeLow: '3250', priceRangeHigh: '3280' },
    stopLoss: { price: '3350' },
    takeProfits: [
      { level: 1, price: '3150' },
      { level: 2, price: '3050' },
    ],
    leverage: 10,
    confidence: 0.91,
    extractedFrom: 'text_only',
    reasoning: 'Structured ENTRY/SL/TP block; standard Nora format',
  })
  await router.route(asSignalResult(sig2))

  await router.route(asUpdateResult(makeUpdate({
    kolId: KOL_NORA,
    bundleId: ulid(),
    receivedAt: toIso(45),
    symbol: 'ETH',
    externalMessageId: sig2.messageId,
    updateType: 'tp_hit',
    level: 1,
    closedPercent: '40',
    realizedPriceRef: '3148',
    confidence: 0.9,
    reasoning: 'TP1 hit at 3148, taking 40% off',
  })))

  await router.route(asUpdateResult(makeUpdate({
    kolId: KOL_NORA,
    bundleId: ulid(),
    receivedAt: toIso(75),
    symbol: 'ETH',
    externalMessageId: sig2.messageId,
    updateType: 'manual_close',
    closedPercent: '60',
    realizedPriceRef: '3098',
    realizedRR: '2.4',
    confidence: 0.92,
    reasoning: 'Manually closing remaining 60% at 3098 — full position closed, R/R 2.4',
  })))

  // ── Signal 3: HYPE long by 舒琴 — gets stopped out ──
  const sig3 = makeSignal({
    kolId: KOL_SHUQIN,
    parsedAt: toIso(60),
    symbol: 'HYPE',
    side: 'long',
    contractType: 'perpetual',
    rawText: 'HYPE 多 25.5 SL 24.8 TP 27 / 28.5 / 30 5x',
    action: 'open',
    entry: { type: 'limit', price: '25.5' },
    stopLoss: { price: '24.8' },
    takeProfits: [
      { level: 1, price: '27' },
      { level: 2, price: '28.5' },
      { level: 3, price: '30' },
    ],
    leverage: 5,
    confidence: 0.85,
    extractedFrom: 'text_only',
    reasoning: 'Casual format but all fields present',
  })
  await router.route(asSignalResult(sig3))

  await router.route(asUpdateResult(makeUpdate({
    kolId: KOL_SHUQIN,
    bundleId: ulid(),
    receivedAt: toIso(120),
    symbol: 'HYPE',
    externalMessageId: sig3.messageId,
    updateType: 'sl_hit',
    realizedPriceRef: '24.78',
    realizedRR: '-1.0',
    confidence: 0.95,
    reasoning: 'Stop loss triggered at 24.78',
  })))

  // ── Signal 4: GENIUS bot KOL signal — DEC-016 path ──
  const sig4 = makeSignal({
    kolId: KOL_GAULS,
    parsedAt: toIso(90),
    parserType: 'regex_structured',
    symbol: 'GENIUS',
    side: 'long',
    contractType: 'perpetual',
    rawText: '**<:Long:1397324271419785346>  [GENIUS](https://discord.com/channels/.../1494534655607701595)** | **入场:** 0.09680 | **止损:** 0.0830',
    messageId: 'forwarded-msg-genius',
    linkedExternalMessageId: '1494534655607701595',
    action: 'open',
    entry: { type: 'limit', price: '0.09680' },
    stopLoss: { price: '0.0830' },
    takeProfits: [
      { level: 1, price: '0.10610' },
      { level: 2, price: '0.11510' },
    ],
    confidence: 1,
    extractedFrom: 'text_only',
  })
  await router.route(asSignalResult(sig4))

  await router.route(asUpdateResult(makeUpdate({
    kolId: KOL_GAULS,
    parserType: 'regex_structured',
    bundleId: ulid(),
    receivedAt: toIso(150),
    symbol: 'GENIUS',
    linkedExternalMessageId: '1494534655607701595',
    updateType: 'tp_hit',
    level: 1,
    closedPercent: '25',
    realizedRR: '1.05',
    confidence: 1,
  })))

  // ── Discarded chitchat ──
  await router.route({
    kind: 'discarded',
    reason: 'not_a_signal',
    meta: {
      parserName: 'llm_text',
      bundleId: ulid(),
      kolId: KOL_NEIL,
      startedAt: toIso(20),
      completedAt: toIso(20),
    },
  })

  // ── Failed parse: schema validation ──
  await router.route({
    kind: 'failed',
    error: {
      code: 'schema_validation',
      message: 'extracted object missing required field "action"',
      retriable: false,
    },
    meta: {
      parserName: 'llm_text',
      bundleId: ulid(),
      kolId: KOL_NORA,
      startedAt: toIso(85),
      completedAt: toIso(85),
    },
  })

  // ── Unlinked update — orphan with no matching open signal ──
  await router.route(asUpdateResult(makeUpdate({
    kolId: KOL_NEIL,
    bundleId: ulid(),
    receivedAt: toIso(160),
    symbol: 'XRP',
    externalMessageId: 'nonexistent-msg',
    updateType: 'tp_hit',
    confidence: 0.8,
    reasoning: 'orphan — bot likely missed the original signal',
  })))

  await events.close()

  console.log('[seed] wrote signals to:', PATHS.signalsLog)
  console.log('[seed] wrote events  to:', PATHS.eventLog)
  console.log(`[seed] open-signal index size: ${index.size()}`)
}

main().catch((err) => {
  console.error('[seed] failed:', err)
  process.exit(1)
})
