import { appendFile, readFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DATA_DIR } from '../../paths.js'
import type { RawDiscordMessage } from '../../../../shared/types.js'

const MESSAGES_DIR = resolve(DATA_DIR, 'messages')
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
      this.messages = all.slice(-MAX_MEMORY)
    } catch {
      this.messages = []
    }
  }

  async append(msg: RawDiscordMessage): Promise<void> {
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

  distinctChannels(): string[] {
    return [...new Set(this.messages.map((m) => m.channelId))]
  }

  get count() {
    return this.messages.length
  }
}
