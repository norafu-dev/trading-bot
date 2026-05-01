import type { RawMessage } from '../../ingestion/types.js'
import type { MessageBundle } from '../../ingestion/aggregator/types.js'
import type { FlattenMessageContent } from './message-content.js'

/**
 * Flattens a single `RawMessage` into plain text for LLM / regex input.
 *
 * Order: message content → embed title → embed description → embed fields.
 * Sections are joined with newlines; trailing whitespace is trimmed.
 * Returns an empty string for a fully empty message.
 */
export const flattenMessage: FlattenMessageContent = (message: RawMessage): string => {
  const parts: string[] = []
  if (message.content.trim()) parts.push(message.content.trim())
  for (const embed of message.embeds) {
    if (embed.title) parts.push(embed.title)
    if (embed.description) parts.push(embed.description)
    for (const field of embed.fields) {
      parts.push(`${field.name}: ${field.value}`)
    }
  }
  return parts.join('\n')
}

/**
 * Flattens all messages in a `MessageBundle` into a single string.
 * Messages are separated by `\n---\n`; empty messages are omitted.
 */
export function flattenBundle(bundle: MessageBundle): string {
  return bundle.messages
    .map(flattenMessage)
    .filter(Boolean)
    .join('\n---\n')
}
