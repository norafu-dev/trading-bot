/**
 * One-shot migration: pull every plaintext sensitive field out of
 *   data/config/accounts.json
 *   data/config/llm.json
 * and put them in
 *   data/config/secrets.json
 *
 * After this runs:
 *   - accounts.json contains no apiKey/secret/password fields
 *   - llm.json has apiKey: ""
 *   - secrets.json holds every credential
 *   - readTradingAccountsConfig() / loadLlmConfig() merge transparently
 *
 * Idempotent — re-running is a no-op once the split has happened.
 *
 *   pnpm tsx scripts/migrate-secrets.ts
 */

import { readTradingAccountsConfig, writeTradingAccountsConfig } from '../src/domain/trading/config-store.js'
import { loadLlmConfig, saveLlmConfig } from '../src/core/llm-config.js'

async function main() {
  console.log('[migrate] reading + rewriting trading accounts (auto-splits secrets)...')
  const accounts = await readTradingAccountsConfig()
  console.log(`[migrate]   found ${accounts.length} account(s)`)
  await writeTradingAccountsConfig(accounts)
  console.log('[migrate]   trading accounts split complete')

  console.log('[migrate] reading + rewriting LLM config (auto-splits apiKey)...')
  const llm = await loadLlmConfig()
  await saveLlmConfig(llm)
  console.log('[migrate]   LLM config split complete')

  console.log('[migrate] done.')
}

main().catch((err) => {
  console.error('[migrate] failed:', err)
  process.exit(1)
})
