/**
 * Global risk configuration, persisted to `data/config/risk.json`.
 *
 * Edited in the dashboard. PositionSizer + guard pipeline read at
 * startup and on each operation creation (no caching — file size is
 * tiny, no performance pressure here).
 *
 * Defaults are deliberately conservative: 1% baseline risk per signal,
 * 5% hard cap, no whitelist (everything allowed), 5 minute cooldown.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { RiskConfig } from '../../../shared/types.js'
import { PATHS } from './paths.js'

export const riskConfigSchema = z.object({
  baseRiskPercent: z.number().min(0).max(100).default(1),
  maxOperationSizePercent: z.number().min(0).max(100).default(5),
  symbolWhitelist: z.array(z.string()).default([]),
  cooldownMinutes: z.number().min(0).default(5),
  // ── TP execution policy ──────────────────────────────────────────
  // 0 < cap; capped at 10 to keep validation explicit. KOLs writing
  // more than 10 TPs are extremely rare; the cap keeps validation
  // explicit and the UI bounded.
  maxTakeProfits: z.number().int().min(1).max(10).default(3),
  // String preset OR custom percentages array. Each array entry must
  // be > 0; we don't enforce sum=100 here — the executor normalises.
  tpDistribution: z.union([
    z.enum(['even', 'front-heavy', 'back-heavy']),
    z.array(z.number().positive()).min(1),
  ]).default('even'),
})

export const riskConfigUpdateSchema = riskConfigSchema.partial()

const RISK_CONFIG_FILE = join(PATHS.configDir, 'risk.json')

const DEFAULTS: RiskConfig = riskConfigSchema.parse({})

/**
 * Load the risk config. Returns defaults when the file is absent — that
 * lets a fresh install boot without mandatory configuration.
 */
export async function loadRiskConfig(): Promise<RiskConfig> {
  try {
    const raw = await readFile(RISK_CONFIG_FILE, 'utf-8')
    const parsed = riskConfigSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      throw new Error(
        `Risk config at ${RISK_CONFIG_FILE} is malformed: ${parsed.error.message}`,
      )
    }
    return parsed.data
  } catch (err) {
    if (isENOENT(err)) return { ...DEFAULTS }
    throw err
  }
}

/** Persist the full config to disk. Creates the directory if missing. */
export async function saveRiskConfig(cfg: RiskConfig): Promise<void> {
  await mkdir(PATHS.configDir, { recursive: true })
  const validated = riskConfigSchema.parse(cfg)
  await writeFile(RISK_CONFIG_FILE, JSON.stringify(validated, null, 2) + '\n', 'utf-8')
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
