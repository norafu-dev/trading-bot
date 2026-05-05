/**
 * Subscribes to the EventLog and pushes / updates Telegram approval cards.
 *
 * Subscriptions:
 *   - `operation.created`         status==='pending'   → send a new card with
 *                                                       Approve / Reject inline
 *                                                       keyboard.
 *   - `operation.status-changed`                       → edit the existing card
 *                                                       (no buttons, resolved
 *                                                       state) so the user can
 *                                                       see at a glance who
 *                                                       decided what.
 *
 * Why subscribe to `operation.status-changed` for both manual and timeout
 * paths: ApprovalService is the single emitter of that event, regardless of
 * whether the trigger was a Telegram tap, a dashboard click, or a 5-minute
 * timeout. One subscription handles every "card needs updating" case.
 *
 * Persistence: we map `op.id → telegram message_id` to disk so a process
 * restart still allows in-flight cards to be edited later. The map lives
 * at `data/approvals/telegram-cards.json` — small, never queried, just
 * loaded once on boot and rewritten after each `sendMessage`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { EventLog, EventLogEntry } from '../../core/event-log.js'
import { logger } from '../../core/logger.js'
import { PATHS } from '../../core/paths.js'
import type { KolRegistry } from '../../domain/signals/kol/registry.js'
import type { IOperationStore } from '../../domain/copy-trading/operation-store.js'
import { renderApprovalCard, renderResolvedText } from './card-renderer.js'
import type { TelegramClient } from './client.js'
import { TelegramApiError } from './client.js'

const MAPPING_FILE = join(PATHS.dataRoot, 'approvals', 'telegram-cards.json')

interface CardLocation {
  chatId: number
  messageId: number
}

interface MappingFile {
  /** opId → CardLocation */
  cards: Record<string, CardLocation>
}

export interface ApprovalNotifierDeps {
  client: TelegramClient
  chatId: number
  events: EventLog
  store: IOperationStore
  kolRegistry: KolRegistry
}

/**
 * `operation.created` payload (matches what engine.ts emits).
 * Defined locally because the engine emits it as a free JSON object;
 * we read the fields we care about defensively.
 */
interface OperationCreatedPayload {
  operationId: string
  status: string
}

/**
 * `operation.status-changed` payload (matches what ApprovalService emits).
 */
interface StatusChangedPayload {
  operationId: string
  from: string
  to: string
  by: 'dashboard' | 'telegram' | 'engine' | 'broker'
  at: string
  reason?: string
}

export class TelegramNotifier {
  private mapping: Record<string, CardLocation> = {}
  private unsubscribers: Array<() => void> = []

  constructor(private readonly deps: ApprovalNotifierDeps) {}

  async start(): Promise<void> {
    this.mapping = await readMapping()
    this.unsubscribers.push(
      this.deps.events.subscribeType('operation.created', (e) => {
        void this.handleCreated(e as EventLogEntry<OperationCreatedPayload>)
      }),
    )
    this.unsubscribers.push(
      this.deps.events.subscribeType('operation.status-changed', (e) => {
        void this.handleStatusChanged(e as EventLogEntry<StatusChangedPayload>)
      }),
    )
    logger.info('TelegramNotifier: subscribed to EventLog')
  }

  async stop(): Promise<void> {
    for (const u of this.unsubscribers) u()
    this.unsubscribers = []
  }

  /** Look up the Telegram card for an operation. Used by the listener. */
  getCardLocation(operationId: string): CardLocation | undefined {
    return this.mapping[operationId]
  }

  // ── Handlers ─────────────────────────────────────────────────────────────

  private async handleCreated(entry: EventLogEntry<OperationCreatedPayload>): Promise<void> {
    if (entry.payload.status !== 'pending') return

    // Re-read the operation. The event payload is a small projection; we
    // need the full Operation to render the card.
    const all = await this.deps.store.readAllOperations()
    const op = all.find((o) => o.id === entry.payload.operationId)
    if (!op) {
      logger.warn(
        { operationId: entry.payload.operationId },
        'TelegramNotifier: operation.created received but op not found in store',
      )
      return
    }
    if (op.status !== 'pending') return  // already decided since the event

    const kol = this.deps.kolRegistry.get(op.kolId) ?? undefined
    const card = renderApprovalCard(op, kol)
    try {
      const message = await this.deps.client.sendMessage({
        chatId: this.deps.chatId,
        text: card.text,
        replyMarkup: card.replyMarkup,
      })
      this.mapping[op.id] = { chatId: message.chat.id, messageId: message.message_id }
      await writeMapping({ cards: this.mapping })
      logger.info(
        { operationId: op.id, messageId: message.message_id },
        'TelegramNotifier: approval card sent',
      )
    } catch (err) {
      logger.error(
        { err, operationId: op.id },
        'TelegramNotifier: failed to send approval card (op stays pending; dashboard still works)',
      )
    }
  }

  private async handleStatusChanged(entry: EventLogEntry<StatusChangedPayload>): Promise<void> {
    const { operationId, by, at, reason } = entry.payload
    const location = this.mapping[operationId]
    if (!location) {
      // No card on file — probably the op was created before the notifier
      // started, or the mapping file was wiped. Nothing to update.
      return
    }
    const all = await this.deps.store.readAllOperations()
    const op = all.find((o) => o.id === operationId)
    if (!op) return
    const kol = this.deps.kolRegistry.get(op.kolId) ?? undefined
    const text = renderResolvedText(op, kol, { by, at, reason })

    try {
      await this.deps.client.editMessageText({
        chatId: location.chatId,
        messageId: location.messageId,
        text,
        // Drop the keyboard — decision recorded.
      })
    } catch (err) {
      // "message is not modified" / "message to edit not found" are not
      // worth alerting on; surface anything else.
      if (
        err instanceof TelegramApiError &&
        (err.message.includes('message is not modified') ||
          err.message.includes('message to edit not found'))
      ) {
        return
      }
      logger.warn(
        { err, operationId },
        'TelegramNotifier: failed to update card (decision is still recorded)',
      )
    }
  }
}

// ── Mapping persistence ────────────────────────────────────────────────────

async function readMapping(): Promise<Record<string, CardLocation>> {
  try {
    const raw = await readFile(MAPPING_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as MappingFile
    return parsed.cards ?? {}
  } catch (err) {
    if (isENOENT(err)) return {}
    logger.warn({ err, path: MAPPING_FILE }, 'TelegramNotifier: mapping file unreadable, starting fresh')
    return {}
  }
}

async function writeMapping(file: MappingFile): Promise<void> {
  await mkdir(dirname(MAPPING_FILE), { recursive: true })
  await writeFile(MAPPING_FILE, JSON.stringify(file, null, 2) + '\n', 'utf-8')
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
