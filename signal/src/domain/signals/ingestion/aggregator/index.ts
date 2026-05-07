import type { RawMessage } from '../types.js'
import { newUlid } from '../../../../core/ids.js'
import type {
  AggregatorConfig,
  BundleCloseReason,
  IMessageAggregator,
  MessageBundle,
} from './types.js'

/** Stable ULID-like key for a KOL+channel window. */
function windowKey(kolId: string, channelId: string): string {
  return `${kolId}:${channelId}`
}

interface Window {
  id: string
  kolId: string
  channelId: string
  messages: RawMessage[]
  openedAt: string
  idleTimer?: ReturnType<typeof setTimeout>
  maxTimer?: ReturnType<typeof setTimeout>
}

/**
 * Per-KOL sliding-window message aggregator.
 *
 * One window is maintained per (kolId, channelId) pair. A window opens on
 * the first message for that pair, resets its idle timer on each subsequent
 * message, and closes (emitting a `MessageBundle`) when either:
 *   - no new message arrives within `idleTimeoutMs`, OR
 *   - the window has been open longer than `maxDurationMs`.
 *
 * `flushAll()` immediately closes every open window — call it on graceful
 * shutdown to avoid losing in-flight data.
 */
export class MessageAggregator implements IMessageAggregator {
  private readonly config: AggregatorConfig
  private readonly handlers: Array<(bundle: MessageBundle) => Promise<void>> = []
  private readonly windows = new Map<string, Window>()

  constructor(config: AggregatorConfig) {
    this.config = config
  }

  onBundleClosed(handler: (bundle: MessageBundle) => Promise<void>): void {
    this.handlers.push(handler)
  }

  async ingest(message: RawMessage): Promise<void> {
    const key = windowKey(message.authorId, message.channelId)
    const existing = this.windows.get(key)

    if (existing) {
      existing.messages.push(message)
      clearTimeout(existing.idleTimer)
      existing.idleTimer = this.scheduleIdle(key, existing)
    } else {
      const maxMs = this.maxDurationFor(message.authorId)

      const win: Window = {
        id: newUlid(),
        kolId: message.authorId,
        channelId: message.channelId,
        messages: [message],
        openedAt: new Date().toISOString(),
      }

      win.idleTimer = this.scheduleIdle(key, win)
      win.maxTimer = setTimeout(() => {
        void this.closeWindow(key, 'max_duration')
      }, maxMs)

      this.windows.set(key, win)
    }
  }

  updatePerKolOverrides(
    overrides: NonNullable<AggregatorConfig['perKolOverrides']>,
  ): void {
    // Replace by reference; idleTimeoutFor / maxDurationFor read this map
    // every time, so the next ingest() call picks up the new values.
    // We deliberately don't reset already-open windows: their existing
    // timers already fire on the OLD value, but mid-flight bundles
    // shouldn't change behaviour mid-flight either.
    this.config.perKolOverrides = overrides
  }

  async flushAll(): Promise<void> {
    const keys = Array.from(this.windows.keys())
    await Promise.all(keys.map((k) => this.closeWindow(k, 'forced_flush')))
  }

  private scheduleIdle(key: string, win: Window): ReturnType<typeof setTimeout> {
    const idleMs = this.idleTimeoutFor(win.kolId)
    return setTimeout(() => {
      void this.closeWindow(key, 'idle_timeout')
    }, idleMs)
  }

  private async closeWindow(key: string, reason: BundleCloseReason): Promise<void> {
    const win = this.windows.get(key)
    if (!win) return

    this.windows.delete(key)
    clearTimeout(win.idleTimer)
    clearTimeout(win.maxTimer)

    const bundle: MessageBundle = {
      id: win.id,
      kolId: win.kolId,
      channelId: win.channelId,
      messages: win.messages,
      openedAt: win.openedAt,
      closedAt: new Date().toISOString(),
      closeReason: reason,
    }

    for (const handler of this.handlers) {
      try {
        await handler(bundle)
      } catch {
        // Handlers must not throw; if they do, swallow to protect the aggregator.
      }
    }
  }

  private idleTimeoutFor(kolId: string): number {
    return this.config.perKolOverrides?.[kolId]?.idleTimeoutMs ?? this.config.idleTimeoutMs
  }

  private maxDurationFor(kolId: string): number {
    return this.config.perKolOverrides?.[kolId]?.maxDurationMs ?? this.config.maxDurationMs
  }
}

export function createDefaultAggregator(): MessageAggregator {
  return new MessageAggregator({
    idleTimeoutMs: 30_000,
    maxDurationMs: 120_000,
  })
}
