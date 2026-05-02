import type { ZodSchema } from 'zod'
import { logger } from '../../../../core/logger.js'
import { newUlid } from '../../../../core/ids.js'
import { flattenBundle } from '../common/flatten.js'
import { signalExtractSchema } from '../common/signal-schema.js'
import { detectSymbols } from '../common/symbol-detect.js'
import { positionUpdateExtractSchema } from '../common/update-schema.js'
import type {
  ExtractMeta,
  ExtractResult,
  IExtractor,
  LlmCallRecord,
  LlmParseContext,
} from '../types.js'
import { buildExtractMessages, buildExtractorSystemPrompt, buildPriceHintBlock } from './prompts/render.js'
import { resolveImageUrls } from './image-resolution.js'
import type { IPriceService, PriceQuote } from '../../../../connectors/market/types.js'

const EMPTY_META = (model: string): ExtractMeta => ({
  latencyMs: 0,
  model,
  tokensUsed: { prompt: 0, completion: 0 },
  extractedFrom: 'text_only',
})

/**
 * Extractor stage of the LLM pipeline.
 *
 * Builds the chat payload once, sends it to the provider, and logs the
 * call with the provider-reported model and token usage. The same payload
 * is used for both the request and the audit record — there is no risk
 * of the log diverging from what was sent.
 *
 * `extractedFrom` flows from the message builder (which knows what was
 * actually included) through `ExtractInput` and `ExtractOutput` into the
 * returned `ExtractMeta`. LlmParser uses this — not any LLM-self-reported
 * value — when assembling the final Signal/PositionUpdate.
 */
export class Extractor implements IExtractor {
  async extract<T>(
    ctx: LlmParseContext,
    kind: 'signal' | 'update',
    schema: ZodSchema<T>,
  ): Promise<ExtractResult<T>> {
    const baseSystemPrompt = buildExtractorSystemPrompt(ctx.kol, kind)
    const imagePolicy = ctx.kol.parsingHints?.imagePolicy ?? 'optional'
    const includeImages = imagePolicy !== 'ignore'
    const built = buildExtractMessages(ctx.bundle, includeImages)
    const extractedFrom = built.extractedFrom
    // Resolve any remote image URLs in `messages` into base64 data URLs.
    // Discord CDN blocks LLM-provider IPs, so a raw URL passed to a vision
    // LLM 404s. Our process can fetch fine — convert here so the provider
    // call sees the bytes inline. Failures degrade silently (the offending
    // URL stays put; LLM may not see that one image but the rest goes).
    const messages = ctx.imageFetcher
      ? await resolveImageUrls(built.messages, ctx.imageFetcher)
      : built.messages

    // Layer-2 price hint: pre-fetch live prices for the most likely symbols
    // detected in the bundle text, so the LLM can unit-normalise shorthand
    // like "7.67" → 76700 when BTC trades in the tens of thousands.
    // Only meaningful for signal extraction (updates inherit symbol from
    // their parent signal). Failures degrade silently — extraction proceeds
    // without the hint.
    const quotes: PriceQuote[] = []
    if (kind === 'signal' && ctx.priceService) {
      try {
        quotes.push(...(await fetchPriceHints(ctx.bundle, ctx.priceService, ctx.kol.defaultContractType)))
      } catch (err) {
        logger.debug(
          { err, bundleId: ctx.bundle.id },
          'Extractor: price-hint pre-fetch failed; extracting without hint',
        )
      }
    }
    const systemPrompt = quotes.length > 0
      ? `${baseSystemPrompt}\n\n${buildPriceHintBlock(quotes)}`
      : baseSystemPrompt

    const startedAt = Date.now()
    let output
    try {
      output = await ctx.llmProvider.extract({
        bundle: ctx.bundle,
        kol: ctx.kol,
        targetKind: kind,
        schema: kind === 'signal' ? signalExtractSchema : positionUpdateExtractSchema,
        systemPrompt,
        messages,
        extractedFrom,
      })
    } catch (err) {
      const latencyMs = Date.now() - startedAt
      const detail = err instanceof Error ? (err.cause ?? err.stack ?? err.message) : String(err)
      logger.warn(
        {
          err,
          detail,
          kolId: ctx.kol.id,
          bundleId: ctx.bundle.id,
          model: 'unknown', // provider hadn't returned, so we don't know which yet
        },
        'Extractor: provider call threw',
      )
      // TODO(future): classify provider errors (HTTP 401/429/5xx vs schema
      // validation vs network timeout) so retry logic upstream can be precise.
      return {
        ok: false,
        error: {
          code: 'llm_timeout',
          message: err instanceof Error ? err.message : String(err),
          retriable: true,
          cause: err,
        },
        meta: { ...EMPTY_META('unknown'), latencyMs, extractedFrom },
      }
    }

    const latencyMs = Date.now() - startedAt
    const meta: ExtractMeta = {
      latencyMs,
      model: output.model,
      tokensUsed: output.tokensUsed,
      extractedFrom: output.extractedFrom,
    }

    const record: LlmCallRecord = {
      recordId: newUlid(),
      bundleId: ctx.bundle.id,
      kolId: ctx.kol.id,
      phase: 'extract',
      model: output.model,
      provider: 'openrouter',
      timestamp: new Date(startedAt).toISOString(),
      latencyMs,
      request: {
        system: systemPrompt,
        messages,
      },
      response: { ok: true, data: output.data, rawCompletion: JSON.stringify(output.rawResponse) },
      tokensUsed: {
        prompt: output.tokensUsed.prompt,
        completion: output.tokensUsed.completion,
        total: output.tokensUsed.prompt + output.tokensUsed.completion,
      },
    }
    await ctx.sessionLogger.logCall(record)

    const validated = schema.safeParse(output.data)
    if (!validated.success) {
      return {
        ok: false,
        error: {
          code: 'schema_validation',
          message: validated.error.message,
          retriable: false,
          cause: validated.error,
        },
        meta,
      }
    }

    return { ok: true, data: validated.data, meta }
  }
}

/**
 * Pre-extract symbol candidates from the bundle text and ask the price
 * service for a live quote on each. Returns up to 2 successful quotes —
 * enough for the LLM to anchor unit-normalisation, not so many that the
 * system prompt balloons.
 */
async function fetchPriceHints(
  bundle: { messages: import('../../ingestion/types.js').RawMessage[] },
  priceService: IPriceService,
  defaultContractType: 'spot' | 'perpetual' | undefined,
): Promise<PriceQuote[]> {
  const text = flattenBundle({ messages: bundle.messages } as Parameters<typeof flattenBundle>[0])
  const candidates = detectSymbols(text, 3)
  if (candidates.length === 0) return []

  const quotes: PriceQuote[] = []
  for (const c of candidates) {
    if (quotes.length >= 2) break
    const q = await priceService.getPrice(c.symbol, defaultContractType ?? 'perpetual')
    if (q) quotes.push(q)
  }
  return quotes
}
