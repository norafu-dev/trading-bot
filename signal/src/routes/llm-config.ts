import { Hono } from 'hono'
import { generateObject } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import {
  llmConfigUpdateSchema,
  loadLlmConfig,
  saveLlmConfig,
  toPublic,
  type LlmConfig,
} from '../core/llm-config.js'
import { logger } from '../core/logger.js'

/**
 * LLM provider configuration HTTP API.
 *
 *   GET  /api/config/llm       — public-safe view (no plaintext apiKey)
 *   PUT  /api/config/llm       — partial update; missing apiKey keeps the old one
 *   POST /api/config/llm/test  — exercises the provider with a tiny generateObject
 *                                call to confirm the key works
 *
 * Edits land on disk immediately. The pipeline reads its provider config
 * once at boot, so users must restart the signal process for parser
 * changes to take effect (a "需要重启" banner is shown in the dashboard
 * after a successful PUT).
 */

export function createLlmConfigRoutes() {
  return new Hono()
    .get('/', async (c) => {
      const cfg = await loadLlmConfig()
      return c.json(toPublic(cfg))
    })
    .put('/', async (c) => {
      const body = (await c.req.json()) as Record<string, unknown>
      const parsed = llmConfigUpdateSchema.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: parsed.error.flatten() }, 400)
      }

      // Merge: missing or empty apiKey preserves the existing one.
      const existing = await loadLlmConfig()
      const merged: LlmConfig = {
        ...existing,
        ...parsed.data,
        apiKey:
          parsed.data.apiKey && parsed.data.apiKey.length > 0
            ? parsed.data.apiKey
            : existing.apiKey,
      }
      await saveLlmConfig(merged)
      logger.info(
        {
          baseUrl: merged.baseUrl,
          classifyModel: merged.classifyModel,
          extractModel: merged.extractModel,
          confidenceThreshold: merged.confidenceThreshold,
          apiKeyChanged:
            (parsed.data.apiKey?.length ?? 0) > 0 &&
            parsed.data.apiKey !== existing.apiKey,
        },
        'LLM config updated — restart required for pipeline to pick up changes',
      )
      return c.json(toPublic(merged))
    })
    .post('/test', async (c) => {
      // Optional override body — caller can test a candidate config without
      // saving it, useful for "Test connection" before clicking Save.
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
      const candidate = llmConfigUpdateSchema.safeParse(body)
      if (!candidate.success) {
        return c.json({ ok: false, error: candidate.error.flatten() }, 400)
      }

      const stored = await loadLlmConfig()
      const cfg: LlmConfig = {
        ...stored,
        ...candidate.data,
        apiKey:
          candidate.data.apiKey && candidate.data.apiKey.length > 0
            ? candidate.data.apiKey
            : stored.apiKey,
      }

      if (!cfg.apiKey) {
        return c.json({ ok: false, error: 'API key is empty' }, 400)
      }

      try {
        const client = createOpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl })
        const startedAt = Date.now()
        const { object, usage } = await generateObject({
          model: client.chat(cfg.classifyModel),
          schema: z.object({
            ok: z.boolean(),
            note: z.string(),
          }),
          system:
            'You are a connectivity probe. Reply with ok=true and a one-sentence note.',
          messages: [{ role: 'user', content: 'Reply with ok=true.' }],
        })
        const latencyMs = Date.now() - startedAt
        return c.json({
          ok: true,
          model: cfg.classifyModel,
          latencyMs,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          note: object.note,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn({ err, message }, 'LLM config test call failed')
        return c.json({ ok: false, error: message }, 200)
      }
    })
}
