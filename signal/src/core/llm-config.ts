/**
 * LLM provider configuration loader.
 *
 * Source priority on read (first hit wins):
 *   1. `data/config/llm.json`  — managed by the dashboard
 *   2. `process.env.OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`,
 *      `OPENROUTER_CLASSIFY_MODEL`, `OPENROUTER_EXTRACT_MODEL`
 *   3. Hard-coded defaults for non-secret fields (models, baseUrl)
 *
 * Writes always go to the JSON file. Env vars are a one-way fallback,
 * useful for headless / CI environments where the file isn't seeded.
 *
 * Pipeline reads this once at boot. Changes require a restart — there is
 * deliberately no in-process hot-reload because swapping the LLM provider
 * mid-flight would cause inconsistent SessionLogger records mid-bundle.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { PATHS } from './paths.js'

// ── Schema (full, with secret) ──────────────────────────────────────────────

export const llmConfigSchema = z.object({
  provider: z.literal('openrouter').default('openrouter'),
  /**
   * OpenRouter API key. Stored in plaintext on disk under data/config/llm.json
   * — same protection model as `data/config/accounts.json`.
   */
  apiKey: z.string().default(''),
  baseUrl: z.string().url().default('https://openrouter.ai/api/v1'),
  classifyModel: z.string().min(1).default('google/gemini-2.5-flash'),
  extractModel: z.string().min(1).default('anthropic/claude-sonnet-4.5'),
  /** Default per-bundle confidence gate; KOLs may override via confidenceOverride. */
  confidenceThreshold: z.number().min(0).max(1).default(0.6),
})

export type LlmConfig = z.infer<typeof llmConfigSchema>

/**
 * Schema for PUT bodies. apiKey is optional so a caller can update other
 * fields without rewriting the secret. The route layer applies merge logic
 * before validating.
 */
export const llmConfigUpdateSchema = llmConfigSchema.partial()
export type LlmConfigUpdate = z.infer<typeof llmConfigUpdateSchema>

// ── Public-safe view (no plaintext apiKey) ──────────────────────────────────

export interface PublicLlmConfig {
  provider: 'openrouter'
  baseUrl: string
  classifyModel: string
  extractModel: string
  confidenceThreshold: number
  /** Whether a non-empty apiKey is currently stored. */
  apiKeyConfigured: boolean
  /** Last 4 chars of the apiKey, or empty string if none. */
  apiKeyLast4: string
}

export function toPublic(cfg: LlmConfig): PublicLlmConfig {
  const last4 = cfg.apiKey.length >= 4 ? cfg.apiKey.slice(-4) : ''
  return {
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    classifyModel: cfg.classifyModel,
    extractModel: cfg.extractModel,
    confidenceThreshold: cfg.confidenceThreshold,
    apiKeyConfigured: cfg.apiKey.length > 0,
    apiKeyLast4: last4,
  }
}

// ── File location ───────────────────────────────────────────────────────────

const LLM_CONFIG_FILE = join(PATHS.configDir, 'llm.json')

// ── Read / write ────────────────────────────────────────────────────────────

/**
 * Load LLM config: file → env → defaults.
 *
 * Never throws on missing file. Throws only if the file exists but fails
 * schema validation — that's a config bug worth surfacing immediately
 * rather than silently using defaults.
 */
export async function loadLlmConfig(): Promise<LlmConfig> {
  // 1. Try the file
  try {
    const raw = await readFile(LLM_CONFIG_FILE, 'utf-8')
    const parsed = llmConfigSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      throw new Error(
        `LLM config at ${LLM_CONFIG_FILE} is malformed: ${parsed.error.message}`,
      )
    }
    return parsed.data
  } catch (err) {
    if (!isENOENT(err)) throw err
  }

  // 2. Fall back to env vars
  const fromEnv = llmConfigSchema.parse({
    apiKey: process.env['OPENROUTER_API_KEY'] ?? '',
    ...(process.env['OPENROUTER_BASE_URL'] && { baseUrl: process.env['OPENROUTER_BASE_URL'] }),
    ...(process.env['OPENROUTER_CLASSIFY_MODEL'] && { classifyModel: process.env['OPENROUTER_CLASSIFY_MODEL'] }),
    ...(process.env['OPENROUTER_EXTRACT_MODEL'] && { extractModel: process.env['OPENROUTER_EXTRACT_MODEL'] }),
  })
  return fromEnv
}

/**
 * Persist the full config (including apiKey) to disk.
 * Creates the parent directory if missing.
 */
export async function saveLlmConfig(cfg: LlmConfig): Promise<void> {
  await mkdir(dirname(LLM_CONFIG_FILE), { recursive: true })
  await writeFile(LLM_CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf-8')
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isENOENT(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
