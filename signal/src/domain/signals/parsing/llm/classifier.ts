import { newUlid } from '../../../../core/ids.js'
import type {
  ClassifyOutput,
  IClassifier,
  LlmParseContext,
} from '../types.js'
import { buildClassifierSystemPrompt, buildClassifyMessages, getClassifyFewShots } from './prompts/render.js'

/**
 * Classifier stage of the LLM pipeline.
 *
 * Builds the full chat payload (system prompt + few-shots + live bundle),
 * passes it to `ILlmProvider.classify`, and writes one audit record to the
 * `SessionLogger`. The label returned by the provider is trusted as-is —
 * `generateObject` already enforces the closed enum at the schema level,
 * so any label that arrives here is guaranteed valid; silently rewriting
 * it would mask provider-side bugs.
 */
export class Classifier implements IClassifier {
  async classify(ctx: LlmParseContext): Promise<ClassifyOutput> {
    const systemPrompt = buildClassifierSystemPrompt(ctx.kol)
    const fewShots = getClassifyFewShots(ctx.kol)
    const messages = buildClassifyMessages(ctx.bundle, fewShots)

    const startedAt = Date.now()
    const output = await ctx.llmProvider.classify({
      bundle: ctx.bundle,
      kol: ctx.kol,
      systemPrompt,
      messages,
      fewShots,
    })
    const latencyMs = Date.now() - startedAt

    await ctx.sessionLogger.logCall({
      recordId: newUlid(),
      bundleId: ctx.bundle.id,
      kolId: ctx.kol.id,
      phase: 'classify',
      model: output.model,
      provider: 'openrouter',
      timestamp: new Date(startedAt).toISOString(),
      latencyMs,
      request: {
        system: systemPrompt,
        messages,
      },
      response: { ok: true, data: output, rawCompletion: JSON.stringify(output.rawResponse) },
      tokensUsed: {
        prompt: output.tokensUsed.prompt,
        completion: output.tokensUsed.completion,
        total: output.tokensUsed.prompt + output.tokensUsed.completion,
      },
    })

    return output
  }
}
