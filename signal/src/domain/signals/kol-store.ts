import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { PATHS } from '../../core/paths.js'
import type { KolConfig, ChannelConfig } from '../../../../shared/types.js'

// ==================== Schemas ====================

// ── Parsing-related sub-schemas ─────────────────────────────────────────────
//
// These mirror `shared/types.ts` `KolConfig.parsingHints` etc. The signal
// domain has a stricter discriminated-union form; the dashboard edits the
// looser shared form. `passthrough()` on parsingHints preserves fields the
// dashboard does not surface (e.g. classifierExamples/extractorExamples
// written by the signal domain) so partial updates don't drop them.

const parserTypeSchema = z.enum(['regex_structured', 'llm_text', 'llm_vision', 'hybrid'])

const parsingHintsSchema = z.object({
  style: z.string().optional(),
  vocabulary: z.record(z.string()).optional(),
  imagePolicy: z.enum(['required', 'optional', 'ignore']).optional(),
  fieldDefaults: z
    .object({
      contractType: z.enum(['perpetual', 'spot']).optional(),
      leverage: z.number().int().min(1).optional(),
      side: z.enum(['long', 'short']).optional(),
    })
    .optional(),
}).passthrough()

const aggregatorOverridesSchema = z.object({
  idleTimeoutMs: z.number().int().positive().optional(),
  maxDurationMs: z.number().int().positive().optional(),
}).optional()

export const kolConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  avatarPath: z.string().optional(),
  enabled: z.boolean().default(true),
  riskMultiplier: z.number().positive().default(1),
  maxOpenPositions: z.number().int().min(0).default(3),
  defaultConviction: z.number().min(0).max(1).default(0.5),
  notes: z.string().optional(),
  addedAt: z.string(),

  // ── Signal-pipeline fields ─────────────────────────────────────────────────
  parsingStrategy: parserTypeSchema.optional(),
  parsingHints: parsingHintsSchema.optional(),
  regexConfigName: z.string().optional(),
  confidenceOverride: z.number().min(0).max(1).optional(),
  defaultSymbolQuote: z.string().optional(),
  defaultContractType: z.enum(['perpetual', 'spot']).optional(),
  aggregatorOverrides: aggregatorOverridesSchema,
})

export const channelConfigSchema = z.object({
  id: z.string().min(1),
  guildId: z.string().min(1),
  label: z.string().min(1),
  group: z.string().optional(),
  enabled: z.boolean().default(true),
  kolIds: z.array(z.string()).default([]),
  parseAllMessages: z.boolean().default(false),
  linkedChannelIds: z.array(z.string()).default([]),
  notes: z.string().optional(),
  addedAt: z.string(),
})

export const createKolSchema = kolConfigSchema.omit({ addedAt: true })
export const updateKolSchema = kolConfigSchema.partial().omit({ id: true, addedAt: true })
export const createChannelSchema = channelConfigSchema.omit({ addedAt: true })
export const updateChannelSchema = channelConfigSchema.partial().omit({ id: true, addedAt: true })

// ==================== File paths ====================

const KOLS_DIR = resolve(PATHS.dataRoot, 'kols')
const KOLS_FILE = resolve(KOLS_DIR, 'kols.json')
const CHANNELS_FILE = resolve(KOLS_DIR, 'channels.json')

async function ensureDir() {
  await mkdir(KOLS_DIR, { recursive: true })
}

// ==================== KOLs ====================

export async function readKols(): Promise<KolConfig[]> {
  await ensureDir()
  try {
    const raw = await readFile(KOLS_FILE, 'utf8')
    return JSON.parse(raw) as KolConfig[]
  } catch {
    return []
  }
}

export async function writeKols(kols: KolConfig[]): Promise<void> {
  await ensureDir()
  await writeFile(KOLS_FILE, JSON.stringify(kols, null, 2) + '\n', 'utf8')
}

// ==================== Channels ====================

export async function readChannels(): Promise<ChannelConfig[]> {
  await ensureDir()
  try {
    const raw = await readFile(CHANNELS_FILE, 'utf8')
    return JSON.parse(raw) as ChannelConfig[]
  } catch {
    return []
  }
}

export async function writeChannels(channels: ChannelConfig[]): Promise<void> {
  await ensureDir()
  await writeFile(CHANNELS_FILE, JSON.stringify(channels, null, 2) + '\n', 'utf8')
}
