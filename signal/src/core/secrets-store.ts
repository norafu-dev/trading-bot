/**
 * Plaintext secrets, split off from the user-visible config files so the
 * non-sensitive parts can be edited / committed / shared without leaking
 * keys.
 *
 * On-disk shape (`data/config/secrets.json`):
 *
 *   {
 *     "ccxt": {
 *       "<accountId>": { "apiKey": "...", "secret": "...", "password": "..." }
 *     },
 *     "openrouter": { "apiKey": "..." }
 *   }
 *
 * Why a single file rather than per-domain files:
 *   - One mental model: "if it's sensitive, it's in secrets.json"
 *   - One file to .gitignore, one file to back up, one file to rotate
 *   - Trivial to grep for accidental commits
 *
 * The file is gitignored at the directory level (`data/`). The store itself
 * never logs the values it reads or writes — only key names — so a log
 * leak doesn't become a credential leak.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { PATHS } from './paths.js'

const SECRETS_FILE = resolve(PATHS.configDir, 'secrets.json')

/** Field names that are *always* treated as secrets across every domain. */
export const SENSITIVE_FIELD_PATTERN = /key|secret|password|token|passphrase|privateKey|twofa/i

const ccxtSecretsSchema = z.record(z.string(), z.record(z.string(), z.string()))
const openrouterSecretsSchema = z.object({ apiKey: z.string().optional() }).optional()

const secretsFileSchema = z.object({
  ccxt: ccxtSecretsSchema.optional().default({}),
  openrouter: openrouterSecretsSchema,
})

export type SecretsFile = z.infer<typeof secretsFileSchema>

const EMPTY: SecretsFile = { ccxt: {} }

export async function readSecrets(): Promise<SecretsFile> {
  try {
    const raw = await readFile(SECRETS_FILE, 'utf8')
    const parsed = secretsFileSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return { ...EMPTY }
    return parsed.data
  } catch (err) {
    if (isENOENT(err)) return { ...EMPTY }
    throw err
  }
}

export async function writeSecrets(secrets: SecretsFile): Promise<void> {
  await mkdir(PATHS.configDir, { recursive: true })
  const validated = secretsFileSchema.parse(secrets)
  await writeFile(SECRETS_FILE, JSON.stringify(validated, null, 2) + '\n', 'utf8')
}

// ── Helpers used by both ccxt and llm migration paths ──────────────────────

/**
 * Pull out every value whose key matches `SENSITIVE_FIELD_PATTERN` from a
 * flat object. Returns `{ secrets, rest }` so callers can:
 *   - persist `rest` to the user-visible config file
 *   - persist `secrets` to secrets.json
 * Mutation-free.
 */
export function partitionSecrets<T extends Record<string, unknown>>(
  obj: T,
): { secrets: Record<string, string>; rest: Record<string, unknown> } {
  const secrets: Record<string, string> = {}
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && SENSITIVE_FIELD_PATTERN.test(k)) {
      if (v.length > 0) secrets[k] = v
    } else {
      rest[k] = v
    }
  }
  return { secrets, rest }
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
