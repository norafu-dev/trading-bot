import { describe, expect, it } from 'vitest'
import type { ClassificationLabel } from '../common/labels.js'
import type {
  ClassifyOutput,
  ExtractOutput,
  ISessionLogger,
  LlmCallRecord,
  LlmParseContext,
} from '../types.js'
import { LlmParser } from '../llm/llm-parser.js'
import { StubLlmProvider } from '../llm/provider/stub-provider.js'
import { makeBundle } from './helpers.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const LLM_KOL = {
  id: 'kol-llm',
  label: 'Test LLM KOL',
  enabled: true,
  riskMultiplier: 1,
  maxOpenPositions: 3,
  defaultConviction: 0.7,
  addedAt: '2026-01-01T00:00:00.000Z',
  parsingStrategy: 'llm_text' as const,
  parsingHints: { style: 'Casual English' },
}

class NoopLogger implements ISessionLogger {
  async logCall(_record: LlmCallRecord): Promise<void> { /* noop */ }
}

function makeCtx(
  text: string,
  provider: StubLlmProvider,
  kolOverrides: Partial<typeof LLM_KOL> & { confidenceOverride?: number } = {},
): LlmParseContext {
  return {
    bundle: makeBundle(text),
    kol: { ...LLM_KOL, ...kolOverrides },
    now: new Date('2026-04-20T10:00:00.000Z'),
    llmProvider: provider,
    sessionLogger: new NoopLogger(),
  }
}

function classifyResp(
  label: ClassificationLabel,
  confidence = 0.9,
): ClassifyOutput {
  return {
    classification: label,
    confidence,
    reasoning: `classified as ${label} from message content`,
    model: 'stub-classify-model',
    tokensUsed: { prompt: 100, completion: 30 },
    rawResponse: {},
  }
}

function extractResp(
  data: Record<string, unknown>,
  overrides: Partial<ExtractOutput> = {},
): ExtractOutput {
  const confidence = (data['confidence'] as number) ?? 0.9
  return {
    data,
    confidence,
    reasoning: 'extracted from message body of test fixture',
    extractedFrom: 'text_only',
    model: 'stub-extract-model',
    tokensUsed: { prompt: 80, completion: 30 },
    rawResponse: {},
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LlmParser — signal path', () => {
  it('classifies new_signal and extracts a Signal', async () => {
    const provider = new StubLlmProvider()
      .queueClassify(classifyResp('new_signal', 0.95))
      .queueExtract(extractResp({
        action: 'open',
        side: 'long',
        symbol: 'BTC',
        contractType: 'perpetual',
        entry: { type: 'limit', price: '76500' },
        stopLoss: { price: '75500' },
        takeProfits: [{ level: 1, price: '78000' }],
        confidence: 0.9,
        reasoning: 'extracted side=long, entry=76500, sl=75500, tp1=78000',
      }))

    const parser = new LlmParser('llm_text')
    const result = await parser.parse(makeCtx('BTC long 76500 SL 75500 TP 78000', provider))

    expect(result.kind).toBe('signal')
    if (result.kind !== 'signal') return
    expect(result.signal.symbol).toBe('BTC')
    expect(result.signal.side).toBe('long')
    expect(result.signal.entry?.price).toBe('76500')
    expect(result.signal.stopLoss?.price).toBe('75500')
    expect(result.signal.parserType).toBe('llm_text')
    // extractedFrom comes from ExtractOutput (provider-declared), not LLM-self-reported
    expect(result.signal.extractedFrom).toBe('text_only')
    // rawText reflects flattenBundle, not just message.content
    expect(result.signal.rawText).toContain('BTC long 76500')
  })
})

describe('LlmParser — update path', () => {
  it('classifies position_update and extracts a PositionUpdate', async () => {
    const provider = new StubLlmProvider()
      .queueClassify(classifyResp('position_update'))
      .queueExtract(extractResp({
        updateType: 'tp_hit',
        level: 1,
        closedPercent: '30',
        confidence: 0.88,
        reasoning: 'TP1 triggered, KOL closing 30% of position',
      }))

    const parser = new LlmParser('llm_text')
    const result = await parser.parse(makeCtx('ETH TP1 hit, 30% closed', provider))

    expect(result.kind).toBe('update')
    if (result.kind !== 'update') return
    expect(result.update.updateType).toBe('tp_hit')
    expect(result.update.level).toBe(1)
    expect(result.update.closedPercent).toBe('30')
    expect(result.update.extractedFrom).toBe('text_only')
  })
})

describe('LlmParser — discard paths', () => {
  it('discards when classifier returns a non-actionable label', async () => {
    const provider = new StubLlmProvider()
      .queueClassify(classifyResp('chitchat', 0.95))

    const parser = new LlmParser('llm_text')
    const result = await parser.parse(makeCtx('Good morning everyone!', provider))

    expect(result.kind).toBe('discarded')
    if (result.kind !== 'discarded') return
    expect(result.reason).toBe('not_a_signal')
  })

  it('discards when extractor confidence is below threshold', async () => {
    const provider = new StubLlmProvider()
      .queueClassify(classifyResp('new_signal'))
      .queueExtract(extractResp({
        action: 'open',
        symbol: 'ETH',
        confidence: 0.3,
        reasoning: 'low confidence — message was ambiguous',
      }))

    const parser = new LlmParser('llm_text')
    const result = await parser.parse(makeCtx('ETH something...', provider))

    expect(result.kind).toBe('discarded')
    if (result.kind !== 'discarded') return
    expect(result.reason).toBe('low_confidence')
  })

  it('discards re_entry_hint sentinel from extractor', async () => {
    const provider = new StubLlmProvider()
      .queueClassify(classifyResp('position_update', 0.85))
      .queueExtract(extractResp({
        updateType: 're_entry_hint',
        confidence: 0.8,
        reasoning: 'message reads as informal re-entry suggestion',
      }))

    const parser = new LlmParser('llm_text')
    const result = await parser.parse(makeCtx('BTC re-entry at 76000 possible', provider))

    expect(result.kind).toBe('discarded')
    if (result.kind !== 'discarded') return
    expect(result.reason).toBe('re_entry_hint')
  })

  it('discards update_unclassifiable sentinel from extractor', async () => {
    const provider = new StubLlmProvider()
      .queueClassify(classifyResp('position_update', 0.8))
      .queueExtract(extractResp({
        updateType: 'other',
        confidence: 0.75,
        reasoning: 'cannot determine update type from message',
      }))

    const parser = new LlmParser('llm_text')
    const result = await parser.parse(makeCtx('Some update we cannot classify', provider))

    expect(result.kind).toBe('discarded')
    if (result.kind !== 'discarded') return
    expect(result.reason).toBe('update_unclassifiable')
  })

  it('respects per-KOL confidence override', async () => {
    const provider = new StubLlmProvider()
      .queueClassify(classifyResp('new_signal', 0.95))
      .queueExtract(extractResp({
        action: 'open',
        symbol: 'SOL',
        confidence: 0.65,
        reasoning: 'moderate confidence — fields are clear but KOL style varies',
      }))

    // Default threshold is 0.6; override to 0.8 means 0.65 is below threshold
    const parser = new LlmParser('llm_text')
    const result = await parser.parse(makeCtx('SOL long...', provider, { confidenceOverride: 0.8 }))

    expect(result.kind).toBe('discarded')
    if (result.kind !== 'discarded') return
    expect(result.reason).toBe('low_confidence')
  })
})

describe('LlmParser — failure paths', () => {
  it('returns failed when extractor returns schema_validation error', async () => {
    const provider = new StubLlmProvider()
      .queueClassify(classifyResp('new_signal', 0.95))
      .queueExtract(extractResp({
        // Missing required `action` field — will fail schema validation
        symbol: 'BTC',
        confidence: 0.9,
        reasoning: 'extracted symbol but action field absent in message',
      }))

    const parser = new LlmParser('llm_text')
    const result = await parser.parse(makeCtx('BTC long something', provider))

    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') return
    expect(result.error.code).toBe('schema_validation')
  })

  it('returns failed when classifier throws', async () => {
    const provider = new StubLlmProvider()
    // No queued responses → classify() will throw "queue is empty"

    const parser = new LlmParser('llm_text')
    const result = await parser.parse(makeCtx('anything', provider))

    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') return
    expect(result.error.code).toBe('llm_timeout')
  })
})

describe('LlmParser — extractedFrom flows from provider, not LLM data', () => {
  it('uses ExtractOutput.extractedFrom even when LLM data omits it', async () => {
    const provider = new StubLlmProvider()
      .queueClassify(classifyResp('new_signal'))
      .queueExtract(extractResp(
        {
          action: 'open',
          symbol: 'BTC',
          confidence: 0.9,
          reasoning: 'extracted symbol BTC and action open from message',
        },
        { extractedFrom: 'text_and_image' },
      ))

    const parser = new LlmParser('llm_text')
    const result = await parser.parse(makeCtx('BTC long', provider))

    expect(result.kind).toBe('signal')
    if (result.kind !== 'signal') return
    expect(result.signal.extractedFrom).toBe('text_and_image')
  })
})

describe('StubLlmProvider', () => {
  it('throws when classify queue is empty', async () => {
    const provider = new StubLlmProvider()
    await expect(provider.classify({} as never)).rejects.toThrow('classify queue is empty')
  })

  it('throws when extract queue is empty', async () => {
    const provider = new StubLlmProvider()
    await expect(provider.extract({} as never)).rejects.toThrow('extract queue is empty')
  })
})
