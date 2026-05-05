/**
 * Execution mode + safety knobs for the broker dispatcher.
 *
 * `mode` is the top-level safety switch:
 *   - 'dry-run' (default) — every approved Operation is logged and
 *                            transitioned to `executed` with a fake
 *                            order id. NO broker call is made. This
 *                            is the boot-up default; switching to
 *                            `live` is a deliberate dashboard action.
 *   - 'live'              — actually call CCXT createOrder / setLeverage
 *                            etc. against the configured account.
 *
 * `slippageTolerancePercent` adds a bounds check before market orders:
 * if the live ticker has moved more than this percent from the entry
 * the operation was sized at, we refuse to place the order rather than
 * eating arbitrary slippage. The KOL's intent was sized on a stale
 * price; better to fail loudly than silently overpay.
 *
 * `maxOrderUsdt` is a per-order ceiling that runs even before guards.
 * A bug in the sizer or in a KOL's risk multiplier could otherwise
 * spit out a 5000-USDT order on a 1000-USDT account; this number is
 * the hard cap that the broker dispatcher enforces independently.
 *
 * Edits via PUT /api/config/execution take effect immediately —
 * unlike LLM/Telegram config, the broker dispatcher reads execution
 * config per operation, so flipping `live` ↔ `dry-run` doesn't need
 * a process restart. This is intentional: in an emergency you want
 * to halt live trading from the dashboard without an SSH session.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { PATHS } from './paths.js'

export const executionConfigSchema = z.object({
  mode: z.enum(['dry-run', 'live']).default('dry-run'),
  /**
   * Refuse market orders whose live price has moved more than N %
   * from the operation's `sizingContext` reference. 0 disables the
   * check (not recommended). Default 1.0 (= 100bps).
   */
  slippageTolerancePercent: z.number().min(0).default(1.0),
  /**
   * Hard cap on per-order notional, in USDT. 0 disables. Default 200.
   * The sizer is supposed to keep things much smaller via baseRiskPercent,
   * but this is the final safety net.
   */
  maxOrderUsdt: z.number().min(0).default(200),
  /**
   * When true, attempt to set leverage on every open. When false,
   * leverage from the operation is silently ignored — useful if the
   * exchange rejects setLeverage on already-open positions.
   */
  setLeverage: z.boolean().default(true),
  /**
   * 'isolated' or 'cross'. Applied via setMarginMode before each open
   * if not already in that mode. Most copy-trading defaults to isolated
   * so a single bad signal can't blow up the account.
   */
  marginMode: z.enum(['isolated', 'cross']).default('isolated'),
})

export type ExecutionConfig = z.infer<typeof executionConfigSchema>

export const executionConfigUpdateSchema = executionConfigSchema.partial()
export type ExecutionConfigUpdate = z.infer<typeof executionConfigUpdateSchema>

const EXECUTION_CONFIG_FILE = join(PATHS.configDir, 'execution.json')

/**
 * Load execution config, applying schema defaults for any missing field.
 * Missing file → all defaults (dry-run / 1% slippage / $200 cap), which
 * is the safest no-config posture.
 */
export async function loadExecutionConfig(): Promise<ExecutionConfig> {
  try {
    const raw = await readFile(EXECUTION_CONFIG_FILE, 'utf-8')
    const parsed = executionConfigSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      throw new Error(
        `Execution config at ${EXECUTION_CONFIG_FILE} is malformed: ${parsed.error.message}`,
      )
    }
    return parsed.data
  } catch (err) {
    if (isENOENT(err)) return executionConfigSchema.parse({})
    throw err
  }
}

export async function saveExecutionConfig(cfg: ExecutionConfig): Promise<void> {
  await mkdir(dirname(EXECUTION_CONFIG_FILE), { recursive: true })
  const validated = executionConfigSchema.parse(cfg)
  await writeFile(EXECUTION_CONFIG_FILE, JSON.stringify(validated, null, 2) + '\n', 'utf-8')
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
