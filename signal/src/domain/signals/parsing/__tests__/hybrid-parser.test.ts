import { describe, expect, it } from 'vitest'
import type { ISessionLogger, LlmCallRecord, LlmParseContext } from '../types.js'
import { HybridParser } from '../llm/hybrid-parser.js'
import { StubLlmProvider } from '../llm/provider/stub-provider.js'
import { RegexStructuredParser } from '../regex/regex-parser.js'
import { makeBundle, WG_BOT_CONFIG } from './helpers.js'
import type { IRegexConfigRegistry, RegexConfig } from '../regex/types.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

class SingleConfigRegistry implements IRegexConfigRegistry {
  constructor(private readonly config = WG_BOT_CONFIG) {}
  register(_config: RegexConfig): void { /* noop in tests */ }
  get(_name: string): RegexConfig | null { return this.config }
  list(): RegexConfig[] { return [this.config] }
  healthCheck(_kols: ReadonlyArray<unknown>): void { /* noop in tests */ }
}

class EmptyRegistry implements IRegexConfigRegistry {
  register(_config: RegexConfig): void { /* noop in tests */ }
  get(_name: string): RegexConfig | null { return null }
  list(): RegexConfig[] { return [] }
  healthCheck(_kols: ReadonlyArray<unknown>): void { /* noop in tests */ }
}

class NoopLogger implements ISessionLogger {
  async logCall(_record: LlmCallRecord): Promise<void> { /* noop */ }
}

// Hybrid KOL — has both `regexConfigName` (for regex fast path) and
// `parsingHints` (required by the LLM fallback). This matches the real
// production shape: HybridParser only ever sees hybrid-strategy KOLs.
const HYBRID_KOL = {
  id: 'kol-bot',
  label: 'WG Bot',
  enabled: true,
  riskMultiplier: 1,
  maxOpenPositions: 5,
  defaultConviction: 0.8,
  addedAt: '2026-01-01T00:00:00.000Z',
  parsingStrategy: 'hybrid' as const,
  regexConfigName: 'wg-bot',
  parsingHints: { style: 'Bot format with occasional Chinese annotations' },
}

function makeCtx(text: string, provider: StubLlmProvider): LlmParseContext {
  return {
    bundle: makeBundle(text, { kolId: 'kol-bot' }),
    kol: HYBRID_KOL,
    now: new Date('2026-04-20T10:00:00.000Z'),
    llmProvider: provider,
    sessionLogger: new NoopLogger(),
  }
}

// Real WG Bot signal message (single-line format matching the detector `| **入场:**`)
const WG_SIGNAL = '**<:Long:123> [GENIUS](https://discord.com/channels/111/222/1494534655607701595)** | **入场:** 0.09680 | **止损:** 0.0830 | **目标 1 (25%):** 0.10610 | **目标 2 (25%):** 0.11510 | **风险:** 3.0%'

const WG_UPDATE_UNKNOWN = '<:Long:123> [**GENIUS**](https://discord.com/channels/111/222/1494534655607701595): 限价订单已取消 **__<#222>__**'

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('HybridParser — regex fast path', () => {
  it('returns regex result directly when regex succeeds', async () => {
    const provider = new StubLlmProvider()
    const regexParser = new RegexStructuredParser(new SingleConfigRegistry())
    const parser = new HybridParser(regexParser)

    const result = await parser.parse(makeCtx(WG_SIGNAL, provider))

    expect(result.kind).toBe('signal')
    if (result.kind !== 'signal') return
    expect(result.signal.symbol).toBe('GENIUS')
    // Provider was never called
    await expect(provider.classify({} as never)).rejects.toThrow('queue is empty')
  })
})

describe('HybridParser — LLM fallback paths', () => {
  it('falls back to LLM when regex returns update_unclassifiable (限价订单已取消)', async () => {
    const provider = new StubLlmProvider()
      .queueClassify({
        classification: 'position_update',
        confidence: 0.85,
        reasoning: 'message describes order cancellation event',
        model: 'stub-classify',
        tokensUsed: { prompt: 100, completion: 30 },
        rawResponse: {},
      })
      .queueExtract({
        data: {
          updateType: 'full_close',
          confidence: 0.82,
          reasoning: 'cancelled limit order leaves no remaining position',
        },
        confidence: 0.82,
        reasoning: 'cancelled limit order leaves no remaining position',
        extractedFrom: 'text_only',
        model: 'stub-extract',
        rawResponse: {},
        tokensUsed: { prompt: 60, completion: 20 },
      })

    const regexParser = new RegexStructuredParser(new SingleConfigRegistry())
    const parser = new HybridParser(regexParser)

    const result = await parser.parse(makeCtx(WG_UPDATE_UNKNOWN, provider))

    // LLM reclassified the cancellation as a full_close
    expect(result.kind).toBe('update')
    if (result.kind !== 'update') return
    expect(result.update.updateType).toBe('full_close')
  })

  it('falls back to LLM when regex returns regex_no_match', async () => {
    const provider = new StubLlmProvider()
      .queueClassify({
        classification: 'new_signal',
        confidence: 0.9,
        reasoning: 'message contains BTC entry intent with explicit price',
        model: 'stub-classify',
        tokensUsed: { prompt: 100, completion: 30 },
        rawResponse: {},
      })
      .queueExtract({
        data: {
          action: 'open',
          symbol: 'BTC',
          confidence: 0.88,
          reasoning: 'symbol BTC and action open extracted from text',
        },
        confidence: 0.88,
        reasoning: 'symbol BTC and action open extracted from text',
        extractedFrom: 'text_only',
        model: 'stub-extract',
        rawResponse: {},
        tokensUsed: { prompt: 50, completion: 20 },
      })

    const regexParser = new RegexStructuredParser(new SingleConfigRegistry())
    const parser = new HybridParser(regexParser)

    // Message doesn't match WG Bot format at all
    const result = await parser.parse(makeCtx('BTC long entry 76500', provider))

    expect(result.kind).toBe('signal')
    if (result.kind !== 'signal') return
    expect(result.signal.symbol).toBe('BTC')
  })
})

describe('HybridParser — config error (no LLM fallback)', () => {
  it('returns failed(unknown) without calling LLM when RegexConfig is missing', async () => {
    const provider = new StubLlmProvider()
    const regexParser = new RegexStructuredParser(new EmptyRegistry())
    const parser = new HybridParser(regexParser)

    const result = await parser.parse(makeCtx(WG_SIGNAL, provider))

    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') return
    expect(result.error.code).toBe('unknown')
    // LLM was not called
    await expect(provider.classify({} as never)).rejects.toThrow('queue is empty')
  })
})
