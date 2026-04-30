import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { PATHS } from '../../core/paths.js'
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

export async function readTradingAccountsConfig(): Promise<TradingAccountConfig[]> {
  await ensureDir()
  try {
    const raw = await readFile(ACCOUNTS_FILE, 'utf8')
    const parsed = tradingAccountsFileSchema.parse(JSON.parse(raw))
    return parsed as TradingAccountConfig[]
  } catch {
    return []
  }
}

export async function writeTradingAccountsConfig(accounts: TradingAccountConfig[]): Promise<void> {
  await ensureDir()
  const validated = tradingAccountsFileSchema.parse(accounts) as TradingAccountConfig[]
  await writeFile(ACCOUNTS_FILE, JSON.stringify(validated, null, 2) + '\n', 'utf8')
}
