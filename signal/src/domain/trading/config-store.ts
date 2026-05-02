import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { PATHS } from '../../core/paths.js'
import { partitionSecrets, readSecrets, writeSecrets } from '../../core/secrets-store.js'
import type { TradingAccountConfig } from '../../../../shared/types.js'

const CONFIG_DIR = resolve(PATHS.dataRoot, 'config')
const ACCOUNTS_FILE = resolve(CONFIG_DIR, 'accounts.json')

const guardSchema = z.object({
  type: z.string().min(1),
  options: z.record(z.string(), z.unknown()).default({}),
})

export const tradingAccountConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  type: z.string().min(1),
  enabled: z.boolean().default(true),
  guards: z.array(guardSchema).default([]),
  brokerConfig: z.record(z.string(), z.unknown()).default({}),
})

export const tradingAccountsFileSchema = z.array(tradingAccountConfigSchema)

async function ensureDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true })
}

/**
 * Read + auto-migrate.
 *
 * Returns each account with its secrets merged back into `brokerConfig`,
 * so callers (ccxt-pool, dashboard /trading routes, etc.) see the same
 * shape they always saw — they don't know secrets live in another file.
 *
 * Migration: if accounts.json on disk still contains plaintext sensitive
 * fields (legacy state from before the secrets split), the next call to
 * `writeTradingAccountsConfig` will move them into secrets.json. Until
 * then we just merge during read.
 */
export async function readTradingAccountsConfig(): Promise<TradingAccountConfig[]> {
  await ensureDir()
  let parsed: TradingAccountConfig[]
  try {
    const raw = await readFile(ACCOUNTS_FILE, 'utf8')
    parsed = tradingAccountsFileSchema.parse(JSON.parse(raw)) as TradingAccountConfig[]
  } catch {
    return []
  }

  const secrets = await readSecrets()
  const ccxtSecrets = secrets.ccxt ?? {}

  for (const account of parsed) {
    const accountSecrets = ccxtSecrets[account.id]
    if (accountSecrets) {
      account.brokerConfig = { ...account.brokerConfig, ...accountSecrets }
    }
  }
  return parsed
}

/**
 * Write + auto-split.
 *
 * The given `accounts` may still carry plaintext secrets in
 * `brokerConfig` (the dashboard PUT route doesn't know it's not supposed
 * to). We partition each `brokerConfig` here:
 *   - sensitive fields → `secrets.json` under `ccxt.<accountId>`
 *   - everything else → `accounts.json`
 *
 * After this call, accounts.json never contains a plaintext apiKey/
 * secret/password — even if it did before. Re-running with the same
 * input is idempotent.
 */
export async function writeTradingAccountsConfig(accounts: TradingAccountConfig[]): Promise<void> {
  await ensureDir()
  const validated = tradingAccountsFileSchema.parse(accounts) as TradingAccountConfig[]

  const existingSecrets = await readSecrets()
  const ccxtSecrets: Record<string, Record<string, string>> = { ...(existingSecrets.ccxt ?? {}) }
  const sanitizedAccounts: TradingAccountConfig[] = []

  // Track which account ids are still present so we can drop secrets for
  // deleted accounts (otherwise they'd linger forever).
  const presentIds = new Set<string>()

  for (const account of validated) {
    presentIds.add(account.id)
    const { secrets: extracted, rest } = partitionSecrets(
      account.brokerConfig as Record<string, unknown>,
    )
    if (Object.keys(extracted).length > 0) {
      ccxtSecrets[account.id] = {
        ...(ccxtSecrets[account.id] ?? {}),
        ...extracted,
      }
    }
    sanitizedAccounts.push({ ...account, brokerConfig: rest })
  }

  // Garbage-collect orphan secret entries
  for (const id of Object.keys(ccxtSecrets)) {
    if (!presentIds.has(id)) delete ccxtSecrets[id]
  }

  await writeFile(
    ACCOUNTS_FILE,
    JSON.stringify(sanitizedAccounts, null, 2) + '\n',
    'utf8',
  )
  await writeSecrets({ ...existingSecrets, ccxt: ccxtSecrets })
}
