import type { ParserType, Signal, PositionUpdate } from '../../../../../../shared/types.js'
import { newUlid } from '../../../../core/ids.js'
import { flattenBundle } from '../common/flatten.js'
import { signalExtractSchema } from '../common/signal-schema.js'
import { positionUpdateExtractSchema } from '../common/update-schema.js'
import type {
  IParser,
  LlmParseContext,
  ParseMeta,
  ParseResult,
} from '../types.js'
import { Classifier } from './classifier.js'
import { Extractor } from './extractor.js'

const DEFAULT_CONFIDENCE_THRESHOLD = 0.6

/**
 * LLM-based parser for `llm_text` and `llm_vision` KOLs.
 *
 * Pipeline:
 *   1. Classifier → coarse label (new_signal | position_update | discard)
 *   2. If actionable → Extractor → structured fields
 *   3. Confidence gate → discard if below threshold
 *   4. Assemble Signal or PositionUpdate
 */
export class LlmParser implements IParser<LlmParseContext> {
  readonly name: ParserType
  private readonly classifier = new Classifier()
  private readonly extractor = new Extractor()
  private readonly confidenceThreshold: number

  constructor(
    strategy: 'llm_text' | 'llm_vision',
    confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD,
  ) {
    this.name = strategy
    this.confidenceThreshold = confidenceThreshold
  }

  async parse(ctx: LlmParseContext): Promise<ParseResult> {
    const startedAt = ctx.now.toISOString()

    const buildMeta = (): ParseMeta => ({
      parserName: this.name,
      bundleId: ctx.bundle.id,
      kolId: ctx.kol.id,
      startedAt,
      completedAt: ctx.now.toISOString(),
    })

    // ── Stage 1: classify ────────────────────────────────────────────────────
    let classifyOutput
    try {
      classifyOutput = await this.classifier.classify(ctx)
    } catch (err) {
      return {
        kind: 'failed',
        error: {
          code: 'llm_timeout',
          message: err instanceof Error ? err.message : String(err),
          retriable: true,
          cause: err,
        },
        meta: buildMeta(),
      }
    }

    const label = classifyOutput.classification
    if (label !== 'new_signal' && label !== 'position_update') {
      return { kind: 'discarded', reason: 'not_a_signal', meta: buildMeta() }
    }

    const threshold = ctx.kol.confidenceOverride ?? this.confidenceThreshold

    const flatText = flattenBundle(ctx.bundle)

    // ── Signal path ──────────────────────────────────────────────────────────
    if (label === 'new_signal') {
      const extractResult = await this.extractor.extract(ctx, 'signal', signalExtractSchema)
      if (!extractResult.ok) {
        return { kind: 'failed', error: extractResult.error, meta: buildMeta() }
      }
      const s = extractResult.data
      if (s.confidence < threshold) {
        return { kind: 'discarded', reason: 'low_confidence', meta: buildMeta() }
      }
      const signal: Signal = {
        id: newUlid(),
        source: 'discord',
        channelId: ctx.bundle.channelId,
        messageId: ctx.bundle.messages[0].messageId,
        bundleId: ctx.bundle.id,
        kolId: ctx.kol.id,
        rawText: flatText,
        parsedAt: ctx.now.toISOString(),
        parserType: this.name,
        action: s.action,
        symbol: s.symbol,
        confidence: s.confidence,
        extractedFrom: extractResult.meta.extractedFrom,
        ...(s.side !== undefined && { side: s.side }),
        ...(s.contractType !== undefined && { contractType: s.contractType }),
        ...(s.entry !== undefined && { entry: s.entry }),
        ...(s.stopLoss !== undefined && { stopLoss: s.stopLoss }),
        ...(s.takeProfits !== undefined && { takeProfits: s.takeProfits }),
        ...(s.size !== undefined && { size: s.size }),
        ...(s.leverage !== undefined && { leverage: s.leverage }),
        ...(s.unitAnomaly !== undefined && { unitAnomaly: s.unitAnomaly }),
        ...(s.notes !== undefined && { notes: s.notes }),
        ...(s.reasoning !== undefined && { reasoning: s.reasoning }),
      }
      return { kind: 'signal', signal, meta: buildMeta() }
    }

    // ── Update path ──────────────────────────────────────────────────────────
    const extractResult = await this.extractor.extract(ctx, 'update', positionUpdateExtractSchema)
    if (!extractResult.ok) {
      return { kind: 'failed', error: extractResult.error, meta: buildMeta() }
    }
    const u = extractResult.data
    if (u.confidence < threshold) {
      return { kind: 'discarded', reason: 'low_confidence', meta: buildMeta() }
    }

    // Intercept extractor-internal sentinels
    if (u.updateType === 're_entry_hint') {
      return { kind: 'discarded', reason: 're_entry_hint', meta: buildMeta() }
    }
    if (u.updateType === 'other') {
      return { kind: 'discarded', reason: 'update_unclassifiable', meta: buildMeta() }
    }

    const update: PositionUpdate = {
      id: newUlid(),
      kolId: ctx.kol.id,
      receivedAt: ctx.now.toISOString(),
      source: 'discord',
      channelId: ctx.bundle.channelId,
      bundleId: ctx.bundle.id,
      parserType: this.name,
      updateType: u.updateType as PositionUpdate['updateType'],
      confidence: u.confidence,
      extractedFrom: extractResult.meta.extractedFrom,
      ...(u.symbol !== undefined && { symbol: u.symbol }),
      ...(u.externalMessageId !== undefined && { externalMessageId: u.externalMessageId }),
      ...(u.linkedExternalMessageId !== undefined && { linkedExternalMessageId: u.linkedExternalMessageId }),
      ...(u.level !== undefined && { level: u.level }),
      ...(u.closedPercent !== undefined && { closedPercent: u.closedPercent }),
      ...(u.remainingPercent !== undefined && { remainingPercent: u.remainingPercent }),
      ...(u.newStopLoss !== undefined && { newStopLoss: u.newStopLoss }),
      ...(u.realizedPriceRef !== undefined && { realizedPriceRef: u.realizedPriceRef }),
      ...(u.realizedRR !== undefined && { realizedRR: u.realizedRR }),
      ...(u.reasoning !== undefined && { reasoning: u.reasoning }),
    }

    return { kind: 'update', update, meta: buildMeta() }
  }
}
