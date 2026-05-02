import { appendFile, readFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PATHS } from '../../core/paths.js'
import type { RawDiscordMessage } from '../../../../shared/types.js'

const MESSAGES_DIR = resolve(PATHS.dataRoot, 'messages')
const MESSAGES_FILE = resolve(MESSAGES_DIR, 'messages.jsonl')
const MAX_MEMORY = 500

export class MessageStore {
  private messages: RawDiscordMessage[] = []

  async init(): Promise<void> {
    await mkdir(MESSAGES_DIR, { recursive: true })
    try {
      const raw = await readFile(MESSAGES_FILE, 'utf8')
      const lines = raw.split('\n').filter(Boolean)
      const all = lines.map((l) => JSON.parse(l) as RawDiscordMessage)
      // Dedupe by messageId, keeping the LAST occurrence so the in-memory
      // tail reflects the most recent version of any edited / re-archived
      // message. Without this, dashboards that key by messageId hit React
      // "duplicate key" warnings whenever the file has historical dups.
      const seen = new Map<string, RawDiscordMessage>()
      for (const m of all) seen.set(m.messageId, m)
      const deduped = Array.from(seen.values())
      this.messages = deduped.slice(-MAX_MEMORY)
    } catch {
      this.messages = []
    }
  }

  async append(msg: RawDiscordMessage): Promise<void> {
    // Idempotent on messageId. Discord can re-deliver the same snowflake
    // (gateway resume, reconnect with replay), and the dev-tool inject route
    // would otherwise duplicate-write any historical message it replays.
    // We use the in-memory tail as the dedup window — older messages may
    // re-appear but they're effectively new from this process's perspective.
    if (this.messages.some((m) => m.messageId === msg.messageId)) return
    this.messages.push(msg)
    if (this.messages.length > MAX_MEMORY) {
      this.messages = this.messages.slice(-MAX_MEMORY)
    }
    await appendFile(MESSAGES_FILE, JSON.stringify(msg) + '\n', 'utf8')
  }

  /** Accept a single channelId or an array (for merged views). */
  query(channelIds?: string | string[], limit = 200): RawDiscordMessage[] {
    let msgs = this.messages
    if (channelIds) {
      const ids = Array.isArray(channelIds) ? channelIds : [channelIds]
      if (ids.length > 0) msgs = msgs.filter((m) => ids.includes(m.channelId))
    }
    return msgs.slice(-limit)
  }

  /**
   * Look up a message by Discord snowflake. Searches the in-memory tail
   * (up to MAX_MEMORY entries); for older messages the caller would need
   * to read messages.jsonl directly. Returns null when not found.
   */
  findById(messageId: string): RawDiscordMessage | null {
    return this.messages.find((m) => m.messageId === messageId) ?? null
  }

  distinctChannels(): string[] {
    return [...new Set(this.messages.map((m) => m.channelId))]
  }

  get count() {
    return this.messages.length
  }
}
