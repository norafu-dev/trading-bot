import { Client } from 'discord.js-selfbot-v13'
import type { Message } from 'discord.js-selfbot-v13'
import type { RawDiscordMessage, RawReference, ChannelConfig } from '../../../../shared/types.js'
import { readChannels, readKols } from '../../domain/signals/kol-store.js'

// ==================== Types ====================

export type ListenerStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface DiscordListenerInit {
  token: string
  onMessage: (msg: RawDiscordMessage) => void | Promise<void>
}

// ==================== Listener ====================

export class DiscordListener {
  private client: Client
  private token: string
  private onMessageCb: DiscordListenerInit['onMessage']

  /** channel ID → config (only enabled channels) */
  private channelMap = new Map<string, ChannelConfig>()
  /** globally-enabled KOL IDs */
  private enabledKolIds = new Set<string>()

  status: ListenerStatus = 'disconnected'
  username = ''
  messageCount = 0
  lastError?: string

  constructor(init: DiscordListenerInit) {
    this.token = init.token
    this.onMessageCb = init.onMessage
    this.client = new Client()

    this.client.on('ready', () => {
      this.status = 'connected'
      this.username = this.client.user?.tag ?? 'unknown'
      console.log(`[Discord] Connected as ${this.username}`)
      console.log(`[Discord] Monitoring ${this.channelMap.size} channel(s)`)
    })

    this.client.on('messageCreate', (msg: Message) => {
      void this.handleMessage(msg)
    })

    this.client.on('error', (err: Error) => {
      this.lastError = err.message
      console.error('[Discord] Error:', err.message)
    })

    this.client.on('warn', (info: string) => {
      console.warn('[Discord] Warning:', info)
    })

    this.client.on('invalidated', () => {
      this.status = 'error'
      this.lastError = 'Session invalidated — token may be revoked'
      console.error('[Discord]', this.lastError)
    })
  }

  // ==================== Lifecycle ====================

  async start(): Promise<void> {
    this.status = 'connecting'
    await this.reloadConfig()
    await this.client.login(this.token)
  }

  async stop(): Promise<void> {
    this.client.destroy()
    this.status = 'disconnected'
    console.log('[Discord] Stopped')
  }

  /** Re-read channels + KOLs from disk. Call after dashboard CRUD. */
  async reloadConfig(): Promise<void> {
    const [channels, kols] = await Promise.all([readChannels(), readKols()])

    this.enabledKolIds = new Set(kols.filter((k) => k.enabled).map((k) => k.id))

    this.channelMap.clear()
    for (const ch of channels) {
      if (ch.enabled) this.channelMap.set(ch.id, ch)
    }

    console.log(
      `[Discord] Config reloaded: ${this.channelMap.size} channel(s), ${this.enabledKolIds.size} KOL(s)`,
    )
  }

  // ==================== Message handler ====================

  private async handleMessage(message: Message): Promise<void> {
    if (!message.guild) return

    // Skip if nothing to store
    if (!message.content && message.embeds.length === 0 && message.attachments.size === 0) return

    // ---- Channel filter ----
    const chConf = this.channelMap.get(message.channel.id)
    if (!chConf) return
    if (message.guild.id !== chConf.guildId) return

    // ---- Author filter ----
    if (!chConf.parseAllMessages) {
      const authorAllowed =
        chConf.kolIds.length === 0 || chConf.kolIds.includes(message.author.id)
      if (!authorAllowed) return
      if (chConf.kolIds.length > 0 && !this.enabledKolIds.has(message.author.id)) return
    }

    // ---- Resolve reply reference ----
    let reference: RawReference | undefined
    if (message.reference?.messageId) {
      try {
        const refMsg = await message.fetchReference()
        reference = {
          messageId: refMsg.id,
          authorId: refMsg.author.id,
          authorUsername: refMsg.author.tag ?? refMsg.author.username,
          contentSnippet: (refMsg.content || '').slice(0, 120),
          hasAttachments: refMsg.attachments.size > 0,
        }
      } catch {
        reference = {
          messageId: message.reference.messageId,
          authorId: '',
          authorUsername: '未知',
          contentSnippet: '',
          hasAttachments: false,
        }
      }
    }

    // ---- Build raw snapshot ----
    const raw: RawDiscordMessage = {
      messageId: message.id,
      channelId: message.channel.id,
      guildId: message.guild.id,
      authorId: message.author.id,
      authorUsername: message.author.tag ?? message.author.username,
      content: message.content ?? '',
      embeds: message.embeds.map((e) => ({
        title: e.title ?? undefined,
        description: e.description ?? undefined,
        fields: (e.fields ?? []).map((f) => ({ name: f.name, value: f.value })),
        image: e.image?.url ?? undefined,
        thumbnail: e.thumbnail?.url ?? undefined,
      })),
      attachments: [...message.attachments.values()].map((a) => ({
        url: a.url,
        name: a.name ?? 'file',
        contentType: a.contentType ?? undefined,
        width: a.width ?? undefined,
        height: a.height ?? undefined,
      })),
      reference,
      receivedAt: new Date().toISOString(),
    }

    this.messageCount++

    try {
      await this.onMessageCb(raw)
    } catch (err) {
      console.error('[Discord] onMessage callback error:', err)
    }
  }
}
