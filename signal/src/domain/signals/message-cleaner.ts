/**
 * Utilities for cleaning raw Discord message content before sending to the AI
 * parser. The original content in the message store is never modified —
 * these helpers are applied only at the point where text is handed to the LLM.
 */

/**
 * Remove all Discord inline-mention tokens from a string.
 *
 * Stripped patterns:
 *   <@ID>   <@!ID>   — user mentions
 *   <@&ID>           — role mentions
 *   <#ID>            — channel mentions
 *   <:name:ID>  <a:name:ID>  — custom emoji
 */
export function stripDiscordMentions(text: string): string {
  return text
    .replace(/<@[!&]?\d+>/g, '')   // user / role mentions
    .replace(/<#\d+>/g, '')         // channel mentions
    .replace(/<a?:\w+:\d+>/g, '')   // custom emoji
    .trim()
}

/**
 * Return the text that should be sent to the AI parser for a given message.
 *
 * Priority:
 *  1. Embed descriptions joined together (most signal channels put the
 *     actual trade content here)
 *  2. Cleaned message content (mentions stripped)
 *
 * Returns an empty string if there is genuinely nothing to parse.
 */
export function buildParserInput(msg: {
  content: string
  embeds: Array<{ description?: string }>
}): string {
  const embedText = msg.embeds
    .map((e) => e.description ?? '')
    .filter(Boolean)
    .join('\n')
    .trim()

  if (embedText) return embedText

  return stripDiscordMentions(msg.content)
}
