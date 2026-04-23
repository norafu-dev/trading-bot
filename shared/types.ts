/** KOL (Key Opinion Leader) registration entry. */
export interface KolConfig {
  id: string
  label: string
  /** Relative path under data/avatars/, e.g. "avatars/123456.png" */
  avatarPath?: string
  enabled: boolean
  riskMultiplier: number
  maxOpenPositions: number
  defaultConviction: number
  notes?: string
  addedAt: string
}

export interface RawEmbed {
  title?: string
  description?: string
  fields: Array<{ name: string; value: string }>
  /** Direct image URL attached to this embed (embed.image.url) */
  image?: string
  /** Thumbnail URL attached to this embed (embed.thumbnail.url) */
  thumbnail?: string
}

export interface RawAttachment {
  url: string
  name: string
  contentType?: string
  width?: number
  height?: number
}

/** Snapshot of the message being replied to. */
export interface RawReference {
  messageId: string
  authorId: string
  authorUsername: string
  /** First 120 chars of the original message content (or empty if image-only). */
  contentSnippet: string
  /** True if the original message had image/file attachments. */
  hasAttachments: boolean
}

/** Serializable snapshot of a Discord message, stripped of discord.js internals. */
export interface RawDiscordMessage {
  messageId: string
  channelId: string
  guildId: string
  authorId: string
  authorUsername: string
  content: string
  embeds: RawEmbed[]
  attachments: RawAttachment[]
  /** Present when this message is a reply to another message. */
  reference?: RawReference
  receivedAt: string
}

/** Discord channel being monitored for trading signals. */
export interface ChannelConfig {
  id: string
  guildId: string
  label: string
  /** Display group name shown in the messages sidebar (e.g. "WWG交易员"). */
  group?: string
  enabled: boolean
  /** Trusted KOL user IDs for this channel. Empty = accept all authors. */
  kolIds: string[]
  /** When true, every message in this channel is sent to the LLM parser. */
  parseAllMessages: boolean
  /**
   * Other channel IDs whose messages should be merged into this channel's view.
   * Useful when a KOL posts entries in one channel and strategy updates in another.
   */
  linkedChannelIds?: string[]
  notes?: string
  addedAt: string
}

export interface GuardEntry {
  type: string
  options: Record<string, unknown>
}

export interface TradingAccountConfig {
  id: string
  label?: string
  type: string
  enabled: boolean
  guards: GuardEntry[]
  brokerConfig: Record<string, unknown>
}

export interface BrokerConfigField {
  name: string
  type: 'text' | 'password' | 'number' | 'boolean' | 'select'
  label: string
  placeholder?: string
  default?: unknown
  required?: boolean
  options?: Array<{ value: string; label: string }>
  description?: string
  sensitive?: boolean
}

export interface BrokerTypeInfo {
  type: string
  name: string
  description: string
  badge: string
  badgeColor: string
  fields: BrokerConfigField[]
  guardCategory: 'crypto' | 'securities'
}
