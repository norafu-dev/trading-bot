/**
 * Minimal Telegram Bot API client.
 *
 * The official telegram bot API is plain JSON over HTTPS. We use only
 * three methods (sendMessage, editMessageText, getUpdates) so a thin
 * fetch wrapper is preferable to pulling `telegraf` and its router /
 * middleware machinery.
 *
 * All methods auto-resolve the bot's request-baseUrl from the configured
 * token. Error envelopes from Telegram (`{ ok: false, description }`)
 * are surfaced as thrown `TelegramApiError`s so callers can `try/catch`
 * the same way as a network failure.
 */

import { logger } from '../../core/logger.js'

// ── Wire-format types (subset we use) ───────────────────────────────────────

export interface TgMessage {
  message_id: number
  chat: { id: number }
  text?: string
}

export interface TgInlineKeyboardButton {
  text: string
  callback_data: string
}

export interface TgInlineKeyboardMarkup {
  inline_keyboard: TgInlineKeyboardButton[][]
}

export interface TgCallbackQuery {
  id: string
  from: { id: number; username?: string; first_name?: string }
  message?: TgMessage
  data?: string
}

export interface TgUpdate {
  update_id: number
  callback_query?: TgCallbackQuery
}

export class TelegramApiError extends Error {
  constructor(
    public readonly errorCode: number,
    message: string,
    public readonly method: string,
  ) {
    super(`Telegram API ${method} failed (${errorCode}): ${message}`)
    this.name = 'TelegramApiError'
  }
}

// ── Client ──────────────────────────────────────────────────────────────────

export interface TelegramClientConfig {
  botToken: string
  /** Override for tests. Defaults to https://api.telegram.org. */
  baseUrl?: string
}

export class TelegramClient {
  private readonly baseUrl: string

  constructor(private readonly config: TelegramClientConfig) {
    this.baseUrl = config.baseUrl ?? 'https://api.telegram.org'
  }

  /** Send a Markdown-rendered message with optional inline keyboard. */
  async sendMessage(args: {
    chatId: number
    text: string
    replyMarkup?: TgInlineKeyboardMarkup
  }): Promise<TgMessage> {
    return this.call<TgMessage>('sendMessage', {
      chat_id: args.chatId,
      text: args.text,
      parse_mode: 'Markdown',
      ...(args.replyMarkup && { reply_markup: args.replyMarkup }),
    })
  }

  /** Replace the text + keyboard of a previously-sent message. */
  async editMessageText(args: {
    chatId: number
    messageId: number
    text: string
    replyMarkup?: TgInlineKeyboardMarkup
  }): Promise<TgMessage | true> {
    // Telegram returns `true` if nothing actually changed; otherwise the
    // updated message object. We allow either.
    return this.call<TgMessage | true>('editMessageText', {
      chat_id: args.chatId,
      message_id: args.messageId,
      text: args.text,
      parse_mode: 'Markdown',
      ...(args.replyMarkup && { reply_markup: args.replyMarkup }),
    })
  }

  /**
   * Acknowledge a callback_query so the user's tap clears the loading
   * spinner. Optional toast text shown in-client. If we never call this
   * Telegram still returns the next update, but the button stays
   * "loading" for ~15 seconds in the client UI.
   */
  async answerCallbackQuery(args: {
    callbackQueryId: string
    text?: string
  }): Promise<true> {
    return this.call<true>('answerCallbackQuery', {
      callback_query_id: args.callbackQueryId,
      ...(args.text && { text: args.text }),
    })
  }

  /**
   * Long-poll for incoming updates. `offset` is `(last seen update_id) + 1`
   * — Telegram drops anything older than that on next call, which is how
   * we ack the previous batch.
   */
  async getUpdates(args: {
    offset: number
    timeoutSeconds: number
    /** Limit which update kinds Telegram sends. We only care about button taps. */
    allowedUpdates?: Array<'callback_query' | 'message'>
  }): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>('getUpdates', {
      offset: args.offset,
      timeout: args.timeoutSeconds,
      ...(args.allowedUpdates && { allowed_updates: args.allowedUpdates }),
    })
  }

  /** Quick liveness check: returns the bot's profile (used by the dashboard "test connection" button). */
  async getMe(): Promise<{ id: number; username?: string; first_name: string }> {
    return this.call('getMe', {})
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}/bot${this.config.botToken}/${method}`
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (err) {
      // Network failures shouldn't crash the long-poll loop — surface
      // as a recognisable error so the caller can retry with backoff.
      logger.warn(
        { err, method },
        'TelegramClient: fetch failed (network)',
      )
      throw err
    }

    let envelope: { ok: boolean; result?: T; description?: string; error_code?: number }
    try {
      envelope = (await response.json()) as typeof envelope
    } catch (err) {
      throw new TelegramApiError(
        response.status,
        `non-JSON response: ${err instanceof Error ? err.message : String(err)}`,
        method,
      )
    }

    if (!envelope.ok) {
      throw new TelegramApiError(
        envelope.error_code ?? response.status,
        envelope.description ?? 'unknown error',
        method,
      )
    }
    return envelope.result as T
  }
}
