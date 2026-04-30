/**
 * Tests for RegexStructuredParser.
 *
 * All message text strings are taken verbatim from samples/johnny.json —
 * the real WG Bot messages we need to parse correctly. The WG_BOT_CONFIG
 * fixture in helpers.ts captures the regex patterns that match this format.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { BaseParseContext } from '../types.js'
import { RegexConfigRegistry } from '../regex/config-registry.js'
import { RegexStructuredParser } from '../regex/regex-parser.js'
import { makeBundle, resetSeq, WG_BOT_CONFIG } from './helpers.js'
import { makeKolConfig } from '../../ingestion/__tests__/helpers.js'

// ── Setup ─────────────────────────────────────────────────────────────────────

let configRegistry: RegexConfigRegistry
let parser: RegexStructuredParser
const NOW = new Date('2026-04-20T10:00:00.000Z')

function makeKol() {
  return makeKolConfig({
    id: 'kol-johnny',
    parsingStrategy: 'regex_structured' as const,
    regexConfigName: 'wg-bot',
    enabled: true,
  })
}

function makeCtx(text: string, msgId = 'test-msg'): BaseParseContext {
  return {
    bundle: makeBundle(text, { kolId: 'kol-johnny', messageId: msgId }),
    kol: makeKol(),
    now: NOW,
  }
}

beforeEach(() => {
  resetSeq()
  configRegistry = new RegexConfigRegistry()
  configRegistry.register(WG_BOT_CONFIG)
  parser = new RegexStructuredParser(configRegistry)
})

// ── Signal parsing ─────────────────────────────────────────────────────────────

describe('RegexStructuredParser — signal parsing (from samples/johnny.json)', () => {
  it('parses a GENIUS long signal with entry and SL (from johnny.json:30)', async () => {
    const text =
      'WG Bot\n**<:Long:1397324271419785346>  [GENIUS](https://discord.com/channels/1189492691352956989/1223443949415436308/1494534655607701595)** | **入场:** 0.644 | **止损:** 0.594 | **风险:** 5.0% **__<#1367913758420238396>__**'

    const result = await parser.parse(makeCtx(text, '1494534875892678747'))

    expect(result.kind).toBe('signal')
    if (result.kind !== 'signal') return

    expect(result.signal.symbol).toBe('GENIUS')
    expect(result.signal.side).toBe('long')
    expect(result.signal.action).toBe('open')
    expect(result.signal.contractType).toBe('perpetual')
    expect(result.signal.entry?.type).toBe('limit')
    expect(result.signal.entry?.price).toBe('0.644')
    expect(result.signal.stopLoss?.price).toBe('0.594')
    expect(result.signal.size).toEqual({ type: 'percent', value: '5.0' })
    expect(result.signal.confidence).toBe(1.0)
    expect(result.signal.extractedFrom).toBe('text_only')
    expect(result.signal.kolId).toBe('kol-johnny')
    expect(result.signal.messageId).toBe('1494534875892678747')
    // DEC-016: bot KOL — URL-embedded original WG Bot msg ID differs from forwarded msg ID
    expect(result.signal.linkedExternalMessageId).toBe('1494534655607701595')
  })

  it('parses a DOGE long signal with TPs (from johnny.json — DOGE format)', async () => {
    const text =
      '**<:Long:1397324271419785346>  [DOGE](https://discord.com/channels/1189492691352956989/1223443949415436308/1494684178380357813)** | **入场:** 0.19010 | **止损:** 0.18510 | **目标 1 (25%):** 0.21510 | **目标 2 (40%):** 0.23010 | **风险:** 5.0% **__<#1367913758420238396>__**'

    const result = await parser.parse(makeCtx(text))

    expect(result.kind).toBe('signal')
    if (result.kind !== 'signal') return

    expect(result.signal.symbol).toBe('DOGE')
    expect(result.signal.entry?.price).toBe('0.19010')
    expect(result.signal.stopLoss?.price).toBe('0.18510')
    expect(result.signal.takeProfits).toEqual([
      { level: 1, price: '0.21510' },
      { level: 2, price: '0.23010' },
    ])
  })

  it('parses a GUN short signal (from johnny.json:261)', async () => {
    const text =
      '**<:Short:1397324392324661349>  [GUN](https://discord.com/channels/1189492691352956989/1223443949415436308/1495834873087393793)** | **入场:** 0.0252 | **止损:** 0.0292 | **风险:** 5.0% **__<#1367913758420238396>__**'

    const result = await parser.parse(makeCtx(text))

    expect(result.kind).toBe('signal')
    if (result.kind !== 'signal') return

    expect(result.signal.symbol).toBe('GUN')
    expect(result.signal.side).toBe('short')
    expect(result.signal.entry?.price).toBe('0.0252')
    expect(result.signal.stopLoss?.price).toBe('0.0292')
  })

  it('parses a BTC signal with entry range (from johnny.json:459)', async () => {
    const text =
      '**<:Long:1397324271419785346>  [BTC](https://discord.com/channels/1189492691352956989/1223443949415436308/1496807815673811065)** | **入场:** 76840 − 76640 | **止损:** 75112 **__<#1367913758420238396>__**'

    const result = await parser.parse(makeCtx(text))

    expect(result.kind).toBe('signal')
    if (result.kind !== 'signal') return

    expect(result.signal.symbol).toBe('BTC')
    expect(result.signal.entry?.priceRangeHigh).toBe('76840')
    expect(result.signal.entry?.priceRangeLow).toBe('76640')
    expect(result.signal.entry?.price).toBeUndefined()
    expect(result.signal.stopLoss?.price).toBe('75112')
  })

  it('returns failed when text has no recognisable pattern', async () => {
    // Pure noise message from johnny.json
    const text = '**__<#1367913758420238396>__**'
    const result = await parser.parse(makeCtx(text))

    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') return
    expect(result.error.code).toBe('regex_no_match')
    expect(result.error.retriable).toBe(false)
  })
})

// ── Update parsing ─────────────────────────────────────────────────────────────

describe('RegexStructuredParser — update parsing (from samples/johnny.json)', () => {
  it('parses a breakeven_move with no RR (from johnny.json:8)', async () => {
    const text =
      '<:Long:1397324271419785346> [**GENIUS**](https://discord.com/channels/1189492691352956989/1361043391944724749/1494485515192373278): 止损移至保本价 **__<#1367913758420238396>__**'

    const result = await parser.parse(makeCtx(text, '1494514679429726288'))

    expect(result.kind).toBe('update')
    if (result.kind !== 'update') return

    expect(result.update.updateType).toBe('breakeven_move')
    expect(result.update.externalMessageId).toBe('1494514679429726288')
    expect(result.update.linkedExternalMessageId).toBe('1494485515192373278')
    expect(result.update.realizedRR).toBeUndefined()
    expect(result.update.confidence).toBe(1.0)
  })

  it('parses a breakeven_move with RR (from johnny.json:151)', async () => {
    const text =
      '<:Long:1397324271419785346> [**GENIUS**](https://discord.com/channels/1189492691352956989/1361043391944724749/1494719376807428237): 止损移至保本价 • 已实现 R/R: 0.31 **__<#1367913758420238396>__**'

    const result = await parser.parse(makeCtx(text))

    expect(result.kind).toBe('update')
    if (result.kind !== 'update') return
    expect(result.update.updateType).toBe('breakeven_move')
    expect(result.update.realizedRR).toBe('0.31')
  })

  it('parses a tp_hit with level, closedPercent, remainingPercent (from johnny.json:96)', async () => {
    const text =
      '<:Long:1397324271419785346> [**ETH**](https://discord.com/channels/1189492691352956989/1361043391944724749/1494685825789595830): 到达第一目标 (50%) - 50% 剩余仓位 **__<#1367913758420238396>__**'

    const result = await parser.parse(makeCtx(text))

    expect(result.kind).toBe('update')
    if (result.kind !== 'update') return

    expect(result.update.updateType).toBe('tp_hit')
    expect(result.update.level).toBe(1)
    expect(result.update.closedPercent).toBe('50')
    expect(result.update.remainingPercent).toBe('50')
  })

  it('parses a tp_hit level 2 (from johnny.json:140)', async () => {
    const text =
      '<:Long:1397324271419785346> [**GENIUS**](https://discord.com/channels/1189492691352956989/1361043391944724749/1494719376807428237): 到达第二目标 (40%) - 60% 剩余仓位 **__<#1367913758420238396>__**'

    const result = await parser.parse(makeCtx(text))

    expect(result.kind).toBe('update')
    if (result.kind !== 'update') return
    expect(result.update.updateType).toBe('tp_hit')
    expect(result.update.level).toBe(2)
    expect(result.update.closedPercent).toBe('40')
  })

  it('parses a sl_hit with RR (from johnny.json:173)', async () => {
    const text =
      '<:Long:1397324271419785346> [**GENIUS**](https://discord.com/channels/1189492691352956989/1361043391944724749/1494871517757181982): 止损平仓 • 已实现 R/R: -1.00 **__<#1367913758420238396>__**'

    const result = await parser.parse(makeCtx(text))

    expect(result.kind).toBe('update')
    if (result.kind !== 'update') return
    expect(result.update.updateType).toBe('sl_hit')
    expect(result.update.realizedRR).toBe('-1.00')
  })

  it('parses a full_close with RR (from johnny.json:40)', async () => {
    const text =
      '<:Long:1397324271419785346> [**GENIUS**](https://discord.com/channels/1189492691352956989/1361043391944724749/1494534655607701595): 盈利平仓 • 已实现 R/R % 0.29 **__<#1367913758420238396>__**'

    const result = await parser.parse(makeCtx(text))

    expect(result.kind).toBe('update')
    if (result.kind !== 'update') return
    expect(result.update.updateType).toBe('full_close')
    expect(result.update.realizedRR).toBe('0.29')
    expect(result.update.linkedExternalMessageId).toBe('1494534655607701595')
  })

  it('parses a runner_close (partial profitable close) with percent and RR (from johnny.json:393)', async () => {
    const text =
      '<:Long:1397324271419785346> [**BTC**](https://discord.com/channels/1189492691352956989/1361043391944724749/1495545610319954000): 盈利平仓 (75%) • 已实现 R/R: 1.89 **__<#1367913758420238396>__**'

    const result = await parser.parse(makeCtx(text))

    expect(result.kind).toBe('update')
    if (result.kind !== 'update') return
    expect(result.update.updateType).toBe('runner_close')
    expect(result.update.closedPercent).toBe('75')
    expect(result.update.realizedRR).toBe('1.89')
  })

  it('parses a stop_modified with newStopLoss price (from johnny.json:327)', async () => {
    const text =
      '<:Long:1397324271419785346> [**GUN**](https://discord.com/channels/1189492691352956989/1361043391944724749/1496140319266439209): 止损移至 0.02184 **__<#1367913758420238396>__**'

    const result = await parser.parse(makeCtx(text))

    expect(result.kind).toBe('update')
    if (result.kind !== 'update') return
    expect(result.update.updateType).toBe('stop_modified')
    expect(result.update.newStopLoss).toBe('0.02184')
    expect(result.update.linkedExternalMessageId).toBe('1496140319266439209')
  })

  it('parses a limit_filled (from johnny.json:426)', async () => {
    const text =
      '⛓️ **EITHER**: 限价订单已成交 **__<#1367913758420238396>__**'

    const result = await parser.parse(makeCtx(text))

    expect(result.kind).toBe('update')
    if (result.kind !== 'update') return
    expect(result.update.updateType).toBe('limit_filled')
  })

  it('discards limit order cancellation as update_unclassifiable (from johnny.json:492)', async () => {
    const text =
      '<:Long:1397324271419785346> [**BTC**](https://discord.com/channels/1189492691352956989/1361043391944724749/1496807815673811065): 限价订单已取消 **__<#1367913758420238396>__**'

    const result = await parser.parse(makeCtx(text))

    expect(result.kind).toBe('discarded')
    if (result.kind !== 'discarded') return
    expect(result.reason).toBe('update_unclassifiable')
  })
})

// ── Error cases ────────────────────────────────────────────────────────────────

describe('RegexStructuredParser — error cases', () => {
  it('returns failed when RegexConfig is not registered', async () => {
    const emptyRegistry = new RegexConfigRegistry()
    const parserWithNoConfig = new RegexStructuredParser(emptyRegistry)

    const result = await parserWithNoConfig.parse(makeCtx('any text'))

    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') return
    expect(result.error.code).toBe('unknown')
    expect(result.error.retriable).toBe(false)
  })

  it('returns failed when KOL has wrong parsingStrategy', async () => {
    const wrongKolCtx: BaseParseContext = {
      bundle: makeBundle('LONG BTC'),
      kol: makeKolConfig({
        id: 'kol-llm',
        parsingStrategy: 'llm_text' as const,
        parsingHints: { style: 'test' },
        enabled: true,
      }),
      now: NOW,
    }

    const result = await parser.parse(wrongKolCtx)

    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') return
    expect(result.error.code).toBe('unknown')
  })
})
