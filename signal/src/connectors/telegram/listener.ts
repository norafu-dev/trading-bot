/**
 * Long-polling loop over Telegram's `getUpdates`. Translates inline-button
 * taps into ApprovalService transitions, then ack's the callback so the
 * user's client clears the loading spinner.
 *
 * Why long-poll instead of webhooks: the signal process runs behind NAT
 * (and on user's laptop in dev). Long-poll has zero infra requirements
 * and Telegram tolerates indefinite connections — this is the canonical
 * pattern for low-volume bots like ours (a handful of taps per day).
 *
 * Restart hygiene:
 *   - We persist the last-seen `update_id` so a restart resumes after
 *     the most recent ack rather than replaying the backlog.
 *   - On graceful stop the polling loop exits; mid-flight `getUpdates`
 *     calls (which can hang up to `timeoutSeconds`) are abandoned and
 *     the next start will catch any updates Telegram queued.
 *
 * Error policy:
 *   - Network errors → 5s backoff, retry. Don't crash the loop; the bot
 *     would silently stop accepting taps until process restart, which
 *     is exactly the surprise-failure mode we're trying to avoid.
 *   - API errors (401 token revoked, etc.) → log loudly, keep trying.
 *     A token rotation rewrites secrets.json; restart the process so
 *     the new value gets picked up.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { logger } from '../../core/logger.js'
import { PATHS } from '../../core/paths.js'
import type { ApprovalService } from '../../domain/copy-trading/approval/approval-service.js'
import { parseCallback } from './card-renderer.js'
import type { TelegramClient, TgCallbackQuery } from './client.js'
import { TelegramApiError } from './client.js'

const OFFSET_FILE = join(PATHS.dataRoot, 'approvals', 'telegram-offset.json')

const POLL_TIMEOUT_SECONDS = 30
const RETRY_BACKOFF_MS = 5_000

export interface TelegramListenerDeps {
  client: TelegramClient
  /** Only accept callbacks from this chat. Anything else is ignored. */
  chatId: number
  approvals: ApprovalService
}

export class TelegramListener {
  private offset = 0
  private running = false
  private loopPromise: Promise<void> | null = null

  constructor(private readonly deps: TelegramListenerDeps) {}

  async start(): Promise<void> {
    this.offset = await readOffset()
    this.running = true
    this.loopPromise = this.loop().catch((err) => {
      logger.error({ err }, 'TelegramListener: loop crashed (should not happen)')
    })
    logger.info({ offset: this.offset }, 'TelegramListener: started')
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.loopPromise) {
      await this.loopPromise
      this.loopPromise = null
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.deps.client.getUpdates({
          offset: this.offset,
          timeoutSeconds: POLL_TIMEOUT_SECONDS,
          allowedUpdates: ['callback_query'],
        })
        for (const update of updates) {
          this.offset = update.update_id + 1
          if (update.callback_query) {
            await this.handleCallback(update.callback_query)
          }
        }
        if (updates.length > 0) {
          await writeOffset(this.offset)
        }
      } catch (err) {
        if (!this.running) break  // shutdown raced with an in-flight poll
        if (err instanceof TelegramApiError) {
          logger.error({ err: err.message, code: err.errorCode }, 'TelegramListener: API error; backing off')
        } else {
          logger.warn({ err }, 'TelegramListener: poll failed; backing off')
        }
        await sleep(RETRY_BACKOFF_MS)
      }
    }
    logger.info('TelegramListener: loop exited')
  }

  private async handleCallback(query: TgCallbackQuery): Promise<void> {
    // 1. Reject taps from chats other than the configured one. A bot can
    //    technically be added to other chats; we trust only the one we
    //    were configured for.
    if (query.message && query.message.chat.id !== this.deps.chatId) {
      logger.warn(
        { fromChatId: query.message.chat.id, expected: this.deps.chatId },
        'TelegramListener: callback from unexpected chat — ignoring',
      )
      await this.ack(query.id, '未授权 chat。')
      return
    }

    // 2. Parse the callback_data we encoded in card-renderer.ts.
    if (!query.data) {
      await this.ack(query.id)
      return
    }
    const parsed = parseCallback(query.data)
    if (!parsed) {
      logger.warn({ data: query.data }, 'TelegramListener: malformed callback_data')
      await this.ack(query.id, '按钮无效。')
      return
    }

    // 3. Run the transition. ApprovalService validates the source state.
    const result = await this.deps.approvals.transition({
      operationId: parsed.operationId,
      newStatus: parsed.action === 'approve' ? 'approved' : 'rejected',
      by: 'telegram',
      reason:
        parsed.action === 'reject'
          ? `由 ${query.from.username ?? query.from.first_name ?? `tg:${query.from.id}`} 手动拒绝`
          : undefined,
    })

    if (!result.ok) {
      const statusLabelZh: Record<string, string> = {
        pending: '待审批',
        approved: '已批准',
        rejected: '已拒绝',
        executed: '已执行',
        failed: '执行失败',
      }
      const toast =
        result.code === 'not-found'
          ? '未找到该操作。'
          : `已是${statusLabelZh[result.currentStatus] ?? result.currentStatus}。`
      await this.ack(query.id, toast)
      return
    }

    await this.ack(
      query.id,
      parsed.action === 'approve' ? '已批准。' : '已拒绝。',
    )
    // The notifier (subscribed to operation.status-changed) will edit
    // the card. We don't do it here so the timeout-driven path produces
    // identical visual output.
  }

  private async ack(callbackQueryId: string, toast?: string): Promise<void> {
    try {
      await this.deps.client.answerCallbackQuery({
        callbackQueryId,
        ...(toast && { text: toast }),
      })
    } catch (err) {
      logger.warn({ err }, 'TelegramListener: ack failed')
    }
  }
}

// ── Offset persistence ─────────────────────────────────────────────────────

async function readOffset(): Promise<number> {
  try {
    const raw = await readFile(OFFSET_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as { offset?: number }
    return typeof parsed.offset === 'number' ? parsed.offset : 0
  } catch (err) {
    if (isENOENT(err)) return 0
    logger.warn({ err }, 'TelegramListener: offset file unreadable; starting from 0')
    return 0
  }
}

async function writeOffset(offset: number): Promise<void> {
  await mkdir(dirname(OFFSET_FILE), { recursive: true })
  await writeFile(OFFSET_FILE, JSON.stringify({ offset }) + '\n', 'utf-8')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
