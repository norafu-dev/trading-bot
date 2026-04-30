import type { Signal, PositionUpdate } from '../../../../../../shared/types.js'
import { newUlid } from '../../../../core/ids.js'
import type { MessageBundle } from '../../ingestion/aggregator/types.js'
import type { RawMessage } from '../../ingestion/types.js'
import type {
  BaseParseContext,
  IParser,
  ParseMeta,
  ParseResult,
} from '../types.js'
import type { FieldExtractor, IRegexConfigRegistry, RegexConfig } from './types.js'

export class RegexStructuredParser implements IParser<BaseParseContext> {
  readonly name = 'regex_structured'

  constructor(private readonly configRegistry: IRegexConfigRegistry) {}

  async parse(ctx: BaseParseContext): Promise<ParseResult> {
    const startedAt = ctx.now.toISOString()
    const meta = buildMeta(ctx.bundle, startedAt, ctx.now)

    if (ctx.kol.parsingStrategy !== 'regex_structured') {
      return {
        kind: 'failed',
        error: {
          code: 'unknown',
          message: `RegexStructuredParser received KOL '${ctx.kol.id}' with strategy '${ctx.kol.parsingStrategy}'`,
          retriable: false,
        },
        meta,
      }
    }

    const config = this.configRegistry.get(ctx.kol.regexConfigName)
    if (!config) {
      return {
        kind: 'failed',
        error: {
          code: 'unknown',
          message: `RegexConfig '${ctx.kol.regexConfigName}' not found in registry`,
          retriable: false,
        },
        meta,
      }
    }

    const text = flattenBundle(ctx.bundle)
    return applyConfig(config, text, ctx, meta)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function flattenBundle(bundle: MessageBundle): string {
  return bundle.messages
    .map(flattenMessage)
    .filter(Boolean)
    .join('\n---\n')
}

function flattenMessage(msg: RawMessage): string {
  const parts: string[] = []
  if (msg.content.trim()) parts.push(msg.content.trim())
  for (const embed of msg.embeds) {
    if (embed.title) parts.push(embed.title)
    if (embed.description) parts.push(embed.description)
    for (const field of embed.fields) {
      parts.push(`${field.name}: ${field.value}`)
    }
  }
  return parts.join('\n')
}

function extract(extractor: FieldExtractor, text: string): string | undefined {
  const match = new RegExp(extractor.pattern, 'i').exec(text)
  if (!match) return undefined
  const groupIdx = extractor.group ?? 1
  const raw = match[groupIdx]?.trim()
  if (raw === undefined || raw === '') return undefined
  if (extractor.valueMap) return extractor.valueMap[raw] ?? raw
  return raw
}

function buildMeta(bundle: MessageBundle, startedAt: string, now: Date): ParseMeta {
  return {
    parserName: 'regex_structured',
    bundleId: bundle.id,
    kolId: bundle.kolId,
    startedAt,
    completedAt: now.toISOString(),
  }
}

function applyConfig(
  config: RegexConfig,
  text: string,
  ctx: BaseParseContext,
  meta: ParseMeta,
): ParseResult {
  // Try update patterns first (more specific than signal detector)
  for (const upd of config.updates) {
    if (!new RegExp(upd.detector, 'i').test(text)) continue

    // Intercept extractor-internal sentinels
    if (upd.updateType === 're_entry_hint') {
      return { kind: 'discarded', reason: 're_entry_hint', meta }
    }
    if (upd.updateType === 'other') {
      return { kind: 'discarded', reason: 'update_unclassifiable', meta }
    }

    const update: PositionUpdate = {
      id: newUlid(),
      externalMessageId: ctx.bundle.messages[0].messageId,
      kolId: ctx.kol.id,
      receivedAt: ctx.now.toISOString(),
      source: 'discord',
      channelId: ctx.bundle.channelId,
      bundleId: ctx.bundle.id,
      parserType: 'regex_structured',
      updateType: upd.updateType,
      confidence: 1.0,
      extractedFrom: 'text_only',
    }

    const f = upd.fields
    if (f) {
      if (f.linkedExternalMessageId) {
        update.linkedExternalMessageId = extract(f.linkedExternalMessageId, text)
      }
      if (f.level) {
        const raw = extract(f.level, text)
        if (raw) update.level = parseInt(raw, 10)
      }
      if (f.closedPercent) update.closedPercent = extract(f.closedPercent, text)
      if (f.remainingPercent) update.remainingPercent = extract(f.remainingPercent, text)
      if (f.newStopLoss) update.newStopLoss = extract(f.newStopLoss, text)
      if (f.realizedPriceRef) update.realizedPriceRef = extract(f.realizedPriceRef, text)
      if (f.realizedRR) update.realizedRR = extract(f.realizedRR, text)
    }

    return { kind: 'update', update, meta }
  }

  // Try signal detector
  if (!new RegExp(config.signal.detector, 'i').test(text)) {
    return {
      kind: 'failed',
      error: { code: 'regex_no_match', message: 'No signal or update pattern matched', retriable: false },
      meta,
    }
  }

  // Extract required symbol
  const sf = config.signal.fields
  const symbol = sf.symbol ? extract(sf.symbol, text) : undefined
  if (!symbol) {
    return {
      kind: 'failed',
      error: { code: 'regex_no_match', message: 'Could not extract required field: symbol', retriable: false },
      meta,
    }
  }

  const signal: Signal = {
    id: newUlid(),
    source: 'discord',
    channelId: ctx.bundle.channelId,
    messageId: ctx.bundle.messages[0].messageId,
    bundleId: ctx.bundle.id,
    kolId: ctx.kol.id,
    rawText: text,
    parsedAt: ctx.now.toISOString(),
    parserType: 'regex_structured',
    action: config.signal.defaults.action,
    symbol,
    contractType: config.signal.defaults.contractType,
    confidence: 1.0,
    extractedFrom: 'text_only',
  }

  // Side
  if (sf.side) {
    const sideRaw = extract(sf.side, text)?.toLowerCase()
    if (sideRaw === 'long' || sideRaw === 'short') signal.side = sideRaw
  }

  // Entry — prefer range over single price
  const rangeLow = sf.entryRangeLow ? extract(sf.entryRangeLow, text) : undefined
  const rangeHigh = sf.entryRangeHigh ? extract(sf.entryRangeHigh, text) : undefined

  if (rangeLow !== undefined || rangeHigh !== undefined) {
    signal.entry = { type: config.signal.defaults.entryType }
    if (rangeLow) signal.entry.priceRangeLow = rangeLow
    if (rangeHigh) signal.entry.priceRangeHigh = rangeHigh
  } else {
    const price = sf.entryPrice ? extract(sf.entryPrice, text) : undefined
    if (price) signal.entry = { type: config.signal.defaults.entryType, price }
  }

  // Stop loss
  const slPrice = sf.stopLossPrice ? extract(sf.stopLossPrice, text) : undefined
  if (slPrice) signal.stopLoss = { price: slPrice }

  // Take profits
  const tpLevels = (['tp1', 'tp2', 'tp3', 'tp4'] as const)
    .map((key, i) => {
      const ext = sf[key]
      if (!ext) return undefined
      const price = extract(ext, text)
      return price ? { level: i + 1, price } : undefined
    })
    .filter((tp): tp is { level: number; price: string } => tp !== undefined)
  if (tpLevels.length > 0) signal.takeProfits = tpLevels

  // Leverage
  if (sf.leverage) {
    const raw = extract(sf.leverage, text)
    if (raw) signal.leverage = parseInt(raw, 10)
  }

  // Size (risk percent)
  if (sf.riskPercent) {
    const raw = extract(sf.riskPercent, text)
    if (raw) signal.size = { type: 'percent', value: raw }
  }

  // Linked external message ID (bot KOL forwarded message path — DEC-016)
  if (sf.linkedExternalMessageId) {
    const linked = extract(sf.linkedExternalMessageId, text)
    if (linked) signal.linkedExternalMessageId = linked
  }

  return { kind: 'signal', signal, meta }
}
