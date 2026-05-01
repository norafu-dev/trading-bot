import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '../../../../core/logger.js'
import type { ISessionLogger, LlmCallRecord } from '../types.js'

/**
 * Writes one `LlmCallRecord` per line to:
 *   `data/sessions/llm/{YYYY-MM-DD}/{bundleId}.jsonl`
 *
 * Write failures throw — data integrity takes priority over continuing the
 * parse. Before the throw we emit a structured Pino log so the failure is
 * visible to operators without needing to dig into the parse error: the
 * upstream `Extractor` / `Classifier` will surface the exception as a
 * generic `llm_timeout`, which on its own is misleading when the root cause
 * is a full disk or permission issue.
 */
export class SessionLogger implements ISessionLogger {
  constructor(private readonly dataDir: string) {}

  async logCall(record: LlmCallRecord): Promise<void> {
    const date = record.timestamp.slice(0, 10) // "YYYY-MM-DD"
    const dir = join(this.dataDir, 'sessions', 'llm', date)
    const path = join(dir, `${record.bundleId}.jsonl`)
    try {
      await mkdir(dir, { recursive: true })
      await appendFile(path, JSON.stringify(record) + '\n', 'utf8')
    } catch (err) {
      logger.error(
        {
          err,
          bundleId: record.bundleId,
          kolId: record.kolId,
          phase: record.phase,
          path,
        },
        'SessionLogger.logCall failed — LLM audit record was NOT persisted',
      )
      throw err
    }
  }
}
