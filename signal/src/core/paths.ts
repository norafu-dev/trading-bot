/**
 * Centralised path constants for all runtime data directories.
 * @adapted-from reference/OpenAlice/src/core/ — not a direct lift.
 *   OpenAlice hard-codes CONFIG_DIR and SESSIONS_DIR as module-level
 *   constants. This file adds DATA_ROOT env-var override so tests can
 *   isolate writes without touching production data. (DEC-009)
 *
 * Rules (enforced by code review):
 * - Every path the signal process reads or writes MUST be derived from
 *   this file. No other module may hard-code path fragments.
 * - Tests set `process.env.DATA_ROOT` to a temp directory before import.
 */

import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/** Repository root — three levels above `signal/src/core/`. */
const REPO_ROOT = resolve(__dirname, '..', '..', '..')

const DATA_ROOT = process.env['DATA_ROOT']
  ? resolve(process.env['DATA_ROOT'])
  : join(REPO_ROOT, 'data')

/**
 * All runtime data paths. Import this object; do not hard-code paths.
 *
 * To use an isolated data directory in tests, set `DATA_ROOT` before
 * importing any module that transitively imports this file:
 *   process.env.DATA_ROOT = '/tmp/test-data'
 */
export const PATHS = {
  /** Root of all runtime data. Override via DATA_ROOT env var. */
  dataRoot: DATA_ROOT,

  /** JSON config files (accounts, risk config, etc.). */
  configDir: join(DATA_ROOT, 'config'),

  /** Append-only event bus archive. */
  eventLog: join(DATA_ROOT, 'event-log', 'events.jsonl'),

  /** Parsed signal records. */
  signalsLog: join(DATA_ROOT, 'signals', 'signals.jsonl'),

  /** KOL registry JSON. */
  kolsFile: join(DATA_ROOT, 'kols', 'kols.json'),

  /** Channel registry JSON. */
  channelsFile: join(DATA_ROOT, 'kols', 'channels.json'),

  /** Raw Discord messages (pre-aggregation). */
  messagesLog: join(DATA_ROOT, 'messages', 'messages.jsonl'),

  /** Root for per-bundle LLM call JSONL files. */
  llmSessionsDir: join(DATA_ROOT, 'sessions', 'llm'),

  /** Pending approvals (crash recovery). */
  approvalsPending: join(DATA_ROOT, 'approvals', 'pending.json'),

  /** Root for per-account trading history. */
  tradingDir: join(DATA_ROOT, 'trading'),

  /** KOL avatar images. */
  avatarsDir: join(DATA_ROOT, 'avatars'),
} as const
