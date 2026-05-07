/**
 * Tests for the BTC 星辰 regex config.
 *
 * Sample texts are condensed verbatim from a 30-day export of the channel.
 * Six message templates: 1 signal (open), 2 update kinds (tp_hit, full_close),
 * 3 explicit-discard kinds (加仓, 启动监控, 关闭监控).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { BaseParseContext } from '../types.js'
import { RegexConfigRegistry } from '../regex/config-registry.js'
import { BTC_STAR_CONFIG } from '../regex/configs/btc-star.js'
import { RegexStructuredParser } from '../regex/regex-parser.js'
import { makeBundle, resetSeq } from './helpers.js'
import { makeKolConfig } from '../../ingestion/__tests__/helpers.js'

let parser: RegexStructuredParser
const NOW = new Date('2026-05-07T08:00:00.000Z')

function makeKol() {
  return makeKolConfig({
    id: 'kol-btc-star',
    parsingStrategy: 'regex_structured' as const,
    regexConfigName: 'btc-star',
    enabled: true,
  })
}

function makeCtx(text: string, msgId = 'test-msg'): BaseParseContext {
  return {
    bundle: makeBundle(text, { kolId: 'kol-btc-star', messageId: msgId }),
    kol: makeKol(),
    now: NOW,
  }
}

beforeEach(() => {
  resetSeq()
  const registry = new RegexConfigRegistry()
  registry.register(BTC_STAR_CONFIG)
  parser = new RegexStructuredParser(registry)
})

// ── Signal (新开仓) ─────────────────────────────────────────────────────────

describe('BTC 星辰 — open signal', () => {
  const SAMPLE = `状态：发现新开仓动作

────────────────────
**📊 标的：ZECUSDT | 永续 | 3x**
🔍 方向：做空 (Short)

**📝 入场详情**
- **入场均价**：$ 378.75
- **持仓数量**：6,000 ZEC
- **预估强平**：$ 378.72

**💰 初始风险**
- **占用保证金**：7,575.07 USDT

⏰ 监控时间：2026-04-10 19:02:47`

  it('produces a signal with symbol, side, entry, leverage', async () => {
    const result = await parser.parse(makeCtx(SAMPLE))
    expect(result.kind).toBe('signal')
    if (result.kind !== 'signal') return
    const s = result.signal
    expect(s.symbol).toBe('ZECUSDT')
    expect(s.side).toBe('short')
    expect(s.contractType).toBe('perpetual')
    expect(s.action).toBe('open')
    expect(s.entry?.price).toBe('378.75')
    expect(s.entry?.type).toBe('market')
    expect(s.leverage).toBe(3)
    expect(s.confidence).toBe(1.0)
  })

  it('handles long side ("做多")', async () => {
    const text = SAMPLE.replace('做空 (Short)', '做多 (Long)')
    const result = await parser.parse(makeCtx(text))
    expect(result.kind).toBe('signal')
    if (result.kind === 'signal') expect(result.signal.side).toBe('long')
  })

  it('captures multi-digit leverage (10x)', async () => {
    const text = SAMPLE.replace('| 3x', '| 10x')
    const result = await parser.parse(makeCtx(text))
    expect(result.kind).toBe('signal')
    if (result.kind === 'signal') expect(result.signal.leverage).toBe(10)
  })
})

// ── PositionUpdate: tp_hit (部分止盈) ──────────────────────────────────────

describe('BTC 星辰 — partial TP', () => {
  const SAMPLE = `状态：部分止盈 ✂️

────────────────────
**📊 标的：ZECUSDT | 永续 | 3x**
**🔄 变动：减仓 ➖**

**📝 获利了结**
- **减仓数量**：-17.00 ZEC (0% 仓位)
- **成交价格**：$ 364.77
- **已实现盈亏**：+0.96 USDT 🏆

**📊 剩余状态**
- **剩余持仓**：84,794 ZEC
- **未实现盈亏**：+4,792.64 USDT

⏰ 监控时间：2026-04-12 10:09:49`

  it('produces a tp_hit update with realizedPriceRef', async () => {
    const result = await parser.parse(makeCtx(SAMPLE))
    expect(result.kind).toBe('update')
    if (result.kind !== 'update') return
    expect(result.update.updateType).toBe('tp_hit')
    expect(result.update.symbol).toBe('ZECUSDT')
    expect(result.update.realizedPriceRef).toBe('364.77')
  })
})

// ── PositionUpdate: full_close (止盈平仓 / 做多止盈 / 做空止盈) ────────────

describe('BTC 星辰 — full close', () => {
  const SAMPLE = `状态：止盈平仓 🎯

────────────────────
**📊 总结：ZECUSDT | 永续 | 1x**
**✅ 止盈平仓**

**📝 最终战绩**
- **累计总盈亏**：+3,300.05 USDT 💰

**⏱️ 持仓复盘**
- **平仓数量**：60,751 ZEC
- **入场均价**：$ 364.77
- **平仓均价**：$ 364.72

📆 结项日期：2026-04-12 10:10:27`

  it('produces a full_close update from "止盈平仓"', async () => {
    const result = await parser.parse(makeCtx(SAMPLE))
    expect(result.kind).toBe('update')
    if (result.kind !== 'update') return
    expect(result.update.updateType).toBe('full_close')
    expect(result.update.symbol).toBe('ZECUSDT')
    expect(result.update.realizedPriceRef).toBe('364.72')
  })

  it('also matches "做空止盈"', async () => {
    const text = SAMPLE.replace('止盈平仓', '做空止盈')
    const result = await parser.parse(makeCtx(text))
    expect(result.kind).toBe('update')
    if (result.kind === 'update') expect(result.update.updateType).toBe('full_close')
  })

  it('also matches "做多止盈"', async () => {
    const text = SAMPLE.replace('止盈平仓', '做多止盈')
    const result = await parser.parse(makeCtx(text))
    expect(result.kind).toBe('update')
    if (result.kind === 'update') expect(result.update.updateType).toBe('full_close')
  })

  it('also matches "止损平仓"', async () => {
    const text = SAMPLE.replace('止盈平仓', '止损平仓')
    const result = await parser.parse(makeCtx(text))
    expect(result.kind).toBe('update')
    if (result.kind === 'update') expect(result.update.updateType).toBe('full_close')
  })
})

// ── Discards (加仓 / 启动监控 / 关闭监控) ──────────────────────────────────

describe('BTC 星辰 — discarded templates', () => {
  it('discards "仓位已增加 (加码)" — DCA adds are not currently followed', async () => {
    const text = `状态：仓位已增加 (加码)

────────────────────
**📊 标的：ZECUSDT | 永续 | 3x**
**🔄 变动：加仓 ➕**

**📝 仓位变化**
- **本次加仓**：+5,000 ZEC
- **加仓价格**：$ 378.75`

    const result = await parser.parse(makeCtx(text))
    expect(result.kind).toBe('discarded')
    if (result.kind === 'discarded') expect(result.reason).toBe('update_unclassifiable')
  })

  it('discards "启动监控，发现持仓中" — connector sync, not a new action', async () => {
    const text = `状态：启动监控，发现持仓中

────────────────────
**📊 标的：BTCUSDT | 永续 | 5x**`

    const result = await parser.parse(makeCtx(text))
    expect(result.kind).toBe('discarded')
  })

  it('discards "监控已关闭，待重启" — connector status broadcast', async () => {
    const text = `状态：监控已关闭，待重启

────────────────────
**📋 交易员**：BTC 星辰
**🔌 已断开**`

    const result = await parser.parse(makeCtx(text))
    expect(result.kind).toBe('discarded')
  })
})

// ── No match → failed ─────────────────────────────────────────────────────

describe('BTC 星辰 — unrecognised input', () => {
  it('returns failed when text matches no template', async () => {
    const result = await parser.parse(makeCtx('Hello world, this is not a btc-star message'))
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') expect(result.error.code).toBe('regex_no_match')
  })
})
