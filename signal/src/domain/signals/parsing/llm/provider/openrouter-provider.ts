import { createOpenAI } from '@ai-sdk/openai'
import type { ModelMessage } from 'ai'
import { generateObject } from 'ai'
import { z } from 'zod'
import { classificationLabelSchema } from '../../common/labels.js'
import type {
  ClassifyInput,
  ClassifyOutput,
  ExtractInput,
  ExtractOutput,
  ILlmProvider,
  LlmMessage,
} from '../../types.js'

/**
 * Real LLM provider that calls OpenRouter via Vercel AI SDK.
 *
 * Not exercised in CI (no API key). Instantiated in `main.ts` and injected
 * into the parser registry.
 *
 * Env vars:
 *   OPENROUTER_API_KEY   — required
 *   OPENROUTER_BASE_URL  — optional, defaults to https://openrouter.ai/api/v1
 *
 * Design: this provider is a dumb pipe. It does NOT build prompts or
 * few-shots — `Classifier` and `Extractor` build them once and pass the
 * payload in via `ClassifyInput.messages` / `ExtractInput.messages`. That
 * lets the audit log record exactly what was sent without rebuilding it.
 */
export class OpenRouterProvider implements ILlmProvider {
  private readonly client

  constructor(
    private readonly classifyModel: string,
    private readonly extractModel: string,
    apiKey: string,
    baseUrl = 'https://openrouter.ai/api/v1',
  ) {
    this.client = createOpenAI({
      apiKey,
      baseURL: baseUrl,
    })
  }

  async classify(input: ClassifyInput): Promise<ClassifyOutput> {
    // NB: avoid Zod's .min/.max on number/string — Anthropic via OpenRouter
    // rejects JSON Schemas containing minimum/maximum/minLength constraints.
    // Use refine() so the validation runs after parse, but the JSON Schema
    // shipped to the provider stays plain.
    const classifySchema = z.object({
      label: classificationLabelSchema,
      confidence: z
        .number()
        .refine((n) => n >= 0 && n <= 1, { message: 'confidence must be in [0, 1]' }),
      reasoning: z
        .string()
        .refine((s) => s.length >= 20, { message: 'reasoning must be ≥ 20 chars' }),
    })

    const { object, usage } = await generateObject({
      model: this.client.chat(this.classifyModel),
      system: input.systemPrompt,
      messages: toModelMessages(input.messages),
      schema: classifySchema,
    })

    return {
      classification: object.label,
      confidence: object.confidence,
      reasoning: object.reasoning,
      model: this.classifyModel,
      tokensUsed: {
        prompt: usage?.inputTokens ?? 0,
        completion: usage?.outputTokens ?? 0,
      },
      rawResponse: { object, usage },
    }
  }

  async extract(input: ExtractInput): Promise<ExtractOutput> {
    const { object, usage } = await generateObject({
      model: this.client.chat(this.extractModel),
      system: input.systemPrompt,
      messages: toModelMessages(input.messages),
      schema: input.schema,
    })

    // confidence + reasoning are required by signalExtractSchema /
    // positionUpdateExtractSchema, so the cast is safe — schema validation
    // already rejected anything else upstream of generateObject's return.
    const obj = object as { confidence: number; reasoning?: string }

    return {
      data: object,
      confidence: obj.confidence,
      reasoning: obj.reasoning ?? '',
      extractedFrom: input.extractedFrom,
      model: this.extractModel,
      rawResponse: { object, usage },
      tokensUsed: {
        prompt: usage?.inputTokens ?? 0,
        completion: usage?.outputTokens ?? 0,
      },
    }
  }
}

/**
 * Convert our wire format into the AI SDK's ModelMessage shape.
 *
 * `ModelMessage` is a discriminated union where assistant content cannot
 * include image parts. We enforce that here: only user messages may carry
 * multimodal content. Assistant messages with non-string content are a
 * programming error and we throw rather than silently flatten.
 */
function toModelMessages(messages: LlmMessage[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    if (m.role === 'system') {
      // System messages are passed via `system` param, not in messages array.
      // If a caller put one here it's a bug — surface it instead of silently
      // converting to a user message.
      throw new Error('OpenRouterProvider: system role must be passed via systemPrompt, not messages')
    }
    if (m.role === 'assistant') {
      if (typeof m.content !== 'string') {
        throw new Error('OpenRouterProvider: assistant messages must have string content')
      }
      return { role: 'assistant', content: m.content }
    }
    // role === 'user' — may carry text or multimodal content
    if (typeof m.content === 'string') {
      return { role: 'user', content: m.content }
    }
    const parts = m.content as Array<Record<string, unknown>>
    return {
      role: 'user',
      content: parts.map(part => {
        if (part.type === 'text') {
          return { type: 'text' as const, text: part.text as string }
        }
        if (part.type === 'image_url') {
          const url = (part.image_url as Record<string, string>).url
          return { type: 'image' as const, image: new URL(url) }
        }
        return { type: 'text' as const, text: JSON.stringify(part) }
      }),
    }
  })
}
