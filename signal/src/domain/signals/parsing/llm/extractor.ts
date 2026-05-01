import type { ZodSchema } from 'zod'
import { newUlid } from '../../../../core/ids.js'
import { signalExtractSchema } from '../common/signal-schema.js'
import { positionUpdateExtractSchema } from '../common/update-schema.js'
import type {
  ExtractMeta,
  ExtractResult,
  IExtractor,
  LlmCallRecord,
  LlmParseContext,
} from '../types.js'
import { buildExtractMessages, buildExtractorSystemPrompt } from './prompts/render.js'

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
    const systemPrompt = buildExtractorSystemPrompt(ctx.kol, kind)
    const imagePolicy = ctx.kol.parsingHints?.imagePolicy ?? 'optional'
    const includeImages = imagePolicy !== 'ignore'
    const { messages, extractedFrom } = buildExtractMessages(ctx.bundle, includeImages)

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
