/**
 * Pino-based structured logger.
 *
 * Production: writes JSON lines to `logs/signal.log` (file) and pretty
 * output to stderr (for pm2 / terminal monitoring).
 * Tests: set LOG_LEVEL=silent to suppress all output.
 *
 * Usage:
 *   import { logger } from '../core/logger.js'
 *   logger.info({ kolId }, 'Bundle dispatched')
 *   logger.child({ bundleId }).debug('Classifier called')
 */

import pino from 'pino'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/** Repository root (signal/src/core/ → three levels up). */
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const LOG_FILE = join(REPO_ROOT, 'logs', 'signal.log')
const LOG_LEVEL = (process.env['LOG_LEVEL'] ?? 'info') as pino.Level

export const logger = pino(
  {
    level: LOG_LEVEL,
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.multistream([
    {
      stream: pino.destination({ dest: LOG_FILE, sync: false, mkdir: true }),
      level: LOG_LEVEL,
    },
    {
      stream: process.stderr,
      level: LOG_LEVEL,
    },
  ]),
)
