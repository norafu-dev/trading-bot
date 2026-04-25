import { z } from 'zod'
import type { RawEmbed } from '../../../../../shared/types.js'

/**
 * Zod schema for a single Discord embed.
 *
 * The `satisfies z.ZodType<RawEmbed>` constraint creates a compile-time
 * assertion that this schema's output type stays in sync with `RawEmbed`
 * from shared/types.ts. If either type drifts, tsc will report an error here.
 */
export const rawEmbedSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  /** Name/value pairs from the embed's field rows. */
  fields: z.array(z.object({ name: z.string(), value: z.string() })),
  /** Direct image URL from embed.image.url, if present. */
  image: z.string().optional(),
  /** Thumbnail URL from embed.thumbnail.url, if present. */
  thumbnail: z.string().optional(),
}) satisfies z.ZodType<RawEmbed>

/**
 * Image or file attached to a Discord message, in the form used throughout
 * the signal pipeline (stripped of discord.js-specific internals).
 */
export const attachmentSchema = z.object({
  url: z.string().url(),
  contentType: z.string(),
  name: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
})

export type Attachment = z.infer<typeof attachmentSchema>

/**
 * Canonical internal representation of a Discord message as it flows through
 * the signal pipeline.
 *
 * Converted from `RawDiscordMessage` (the discord.js snapshot in shared/types.ts)
 * at the ingestion boundary. Fields mirror the source structure directly —
 * no derived or computed values. Both `content` and `embeds` are preserved
 * because:
 * - Human KOLs write natural-language text in `content`; `embeds` is usually empty.
 * - Bot KOLs format all structured data as `embeds`; `content` is often empty.
 * - Image-only posts may have both fields empty, with data only in `attachments`.
 *
 * Consuming code that needs a single flat text string for LLM input should use
 * `FlattenMessageContent` from parsing/common/message-content.ts, not roll
 * its own inline derivation.
 *
 * `eventType` distinguishes new posts from edits. The pre-pipeline discards
 * all 'update' events; only 'create' events reach the aggregator.
 */
export const rawMessageSchema = z.object({
  /** Discord snowflake ID. Stable primary key used for deduplication. */
  messageId: z.string(),

  /**
   * 'create' = new message post; 'update' = message edit.
   * The pre-pipeline hard-drops all 'update' events before aggregation.
   */
  eventType: z.enum(['create', 'update']),

  /** ISO 8601 timestamp of when Discord says the message was created. */
  timestamp: z.string().datetime(),

  channelId: z.string(),
  authorId: z.string(),

  /**
   * Raw Discord message content string.
   * Empty when the KOL posts image-only or all text lives in embeds.
   */
  content: z.string(),

  /**
   * Structured embed objects from the message.
   * Bot KOLs carry all signal data here (title / description / field rows).
   * Human KOLs rarely use embeds; this array is usually empty for them.
   */
  embeds: z.array(rawEmbedSchema),

  attachments: z.array(attachmentSchema),

  /** Present when this message is a Discord reply to another message. */
  replyTo: z
    .object({
      messageId: z.string(),
      authorId: z.string(),
      /** First 120 chars of the replied-to message's content, for context. */
      contentSnippet: z.string(),
    })
    .optional(),

  /** Set only for 'update' events; ISO 8601. */
  editedAt: z.string().datetime().optional(),
})

export type RawMessage = z.infer<typeof rawMessageSchema>

/**
 * Append-only raw message store.
 *
 * Single responsibility: durable persistence and chronological replay.
 * Must not filter, parse, aggregate, or forward messages — those are the
 * responsibilities of the layers above it.
 */
export interface IRawMessageStore {
  /** Append a message to the store. Idempotent on messageId. */
  append(message: RawMessage): Promise<void>

  /** Stream messages matching the given filters. */
  query(filters: {
    dateRange?: { from: Date; to: Date }
    authorId?: string
    channelId?: string
  }): AsyncIterable<RawMessage>

  /**
   * Replay all messages in the date range in strict chronological order.
   * Used for backfill, testing, and crash recovery.
   */
  replay(dateRange: { from: Date; to: Date }): AsyncIterable<RawMessage>
}
