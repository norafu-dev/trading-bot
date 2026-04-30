/**
 * LLM Session Store — append-only JSONL log for LLM call records.
 * @adapted-from reference/OpenAlice/src/core/session.ts
 *   Lifted pattern: JSONL append with mkdir-on-demand and ENOENT handling.
 *   Interface completely replaced: OpenAlice stores Claude Code conversation
 *   history (user/assistant turns, tool calls). This file stores
 *   `LlmCallRecord` objects emitted by the signal parsing pipeline.
 *   Storage layout differs: one file per bundle under
 *   `data/sessions/llm/{YYYY-MM-DD}/{bundleId}.jsonl`.
 *
 * Implements `ISessionLogger` from `../domain/signals/parsing/types.ts`.
 * Callers use the interface, never this class directly.
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ISessionLogger, LlmCallRecord } from '../domain/signals/parsing/types.js'
import { PATHS } from './paths.js'

export class LlmSessionStore implements ISessionLogger {
  private readonly sessionsDir: string

  constructor(sessionsDir: string = PATHS.llmSessionsDir) {
    this.sessionsDir = sessionsDir
  }

  /**
   * Append a single LLM call record to the per-bundle JSONL file.
   * Path: `{sessionsDir}/{YYYY-MM-DD}/{bundleId}.jsonl`
   *
   * Creates the directory on first write. Subsequent appends are
   * fire-and-persist: the file grows one line per call.
   */
  async logCall(record: LlmCallRecord): Promise<void> {
    const date = record.timestamp.slice(0, 10) // "YYYY-MM-DD"
    const dir = join(this.sessionsDir, date)
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, `${record.bundleId}.jsonl`)
    await appendFile(filePath, JSON.stringify(record) + '\n', 'utf-8')
  }
}
