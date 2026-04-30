import { z } from 'zod'
import { classificationLabelSchema } from '../parsing/common/labels.js'

/**
 * Zod schema for validating KOL config entries read from `data/kols/kols.json`.
 *
 * `parsingHints` is the key differentiator for LLM-based parsers (style
 * description, vocabulary, few-shot examples). There is no meaningful default.
 * This schema requires every LLM-type KOL to explicitly provide hints — even
 * a TODO stub is acceptable — so that a missing field fails at startup
 * validation rather than silently producing low-quality LLM output at runtime.
 *
 * `KolRegistry` responsibility: validate + load + hot-reload. It does NOT
 * supply default values. A KOL that fails schema validation causes a hard
 * startup failure with a precise error (which KOL ID, which field, actual
 * vs expected).
 *
 * Backward compatibility: the `z.preprocess` step defaults `parsingStrategy`
 * to `'llm_text'` for entries that predate this field. Such entries must also
 * have `parsingHints` present to pass validation — add a TODO stub if needed.
 */

/**
 * Schema for a single few-shot teaching example stored in `kols.json`.
 *
 * `expected.data` is intentionally `z.unknown()`: teaching counter-examples
 * may have deliberately incomplete fields to show the LLM what NOT to extract.
 * Strict validation of extraction output happens at runtime via
 * `signalExtractSchema` / `positionUpdateExtractSchema`, not here.
 */
const fewShotExampleSchema = z.object({
  description: z.string().optional(),
  inputText: z.string(),
  inputImages: z
    .array(z.object({ url: z.string(), contentType: z.string() }))
    .optional(),
  expected: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('classification'),
      label: classificationLabelSchema,
      reasoning: z.string().optional(),
    }),
    z.object({
      kind: z.literal('extraction'),
      targetKind: z.enum(['signal', 'update']),
      data: z.unknown(),
    }),
  ]),
})

const parsingHintsSchema = z.object({
  style: z.string(),
  vocabulary: z.record(z.string(), z.string()).optional(),
  imagePolicy: z.enum(['required', 'optional', 'ignore']).optional(),
  classifierExamples: z.array(fewShotExampleSchema).optional(),
  extractorExamples: z.array(fewShotExampleSchema).optional(),
  fieldDefaults: z
    .object({
      contractType: z.enum(['perpetual', 'spot']).optional(),
      leverage: z.number().int().min(1).optional(),
      side: z.enum(['long', 'short']).optional(),
    })
    .optional(),
})

/** Fields shared by all parsing strategies. */
const kolConfigBaseSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  avatarPath: z.string().optional(),
  enabled: z.boolean(),
  riskMultiplier: z.number().positive(),
  maxOpenPositions: z.number().int().min(1),
  defaultConviction: z.number().min(0).max(1),
  notes: z.string().optional(),
  addedAt: z.string().datetime(),
  confidenceOverride: z.number().min(0).max(1).optional(),
  defaultSymbolQuote: z.string().optional(),
  defaultContractType: z.enum(['perpetual', 'spot']).optional().default('perpetual'),
  aggregatorOverrides: z
    .object({
      idleTimeoutMs: z.number().int().positive().optional(),
      maxDurationMs: z.number().int().positive().optional(),
    })
    .optional(),
})

export const kolConfigSchema = z.preprocess(
  (raw) => {
    // Default parsingStrategy for entries that predate this field
    if (typeof raw === 'object' && raw !== null && !('parsingStrategy' in raw)) {
      return { ...(raw as Record<string, unknown>), parsingStrategy: 'llm_text' }
    }
    return raw
  },
  z.discriminatedUnion('parsingStrategy', [
    kolConfigBaseSchema.extend({
      parsingStrategy: z.literal('regex_structured'),
      regexConfigName: z.string(),
    }),
    kolConfigBaseSchema.extend({
      parsingStrategy: z.literal('llm_text'),
      parsingHints: parsingHintsSchema,
    }),
    kolConfigBaseSchema.extend({
      parsingStrategy: z.literal('llm_vision'),
      parsingHints: parsingHintsSchema,
    }),
    kolConfigBaseSchema.extend({
      parsingStrategy: z.literal('hybrid'),
      regexConfigName: z.string(),
      parsingHints: parsingHintsSchema,
    }),
  ]),
)

/** TypeScript type inferred from `kolConfigSchema`. */
export type KolConfigSchema = z.infer<typeof kolConfigSchema>
