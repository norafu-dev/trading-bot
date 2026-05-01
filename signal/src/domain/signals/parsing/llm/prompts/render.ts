import type { KolConfig } from '../../../../../../../shared/types.js'
import type { MessageBundle } from '../../../ingestion/aggregator/types.js'
import type { ClassifyFewShot, ExtractInput, LlmMessage } from '../../types.js'
import { flattenMessage } from '../../common/flatten.js'
import { GLOBAL_CLASSIFY_FEWSHOTS } from './fewshots-global.js'
import { buildClassifierSystemPrompt } from './system-classifier.js'
import { buildExtractorSystemPrompt } from './system-extractor.js'

export { buildClassifierSystemPrompt, buildExtractorSystemPrompt }

/**
 * Returns the few-shot examples to include in a classifier call.
 *
 * Currently returns only global shots — per-KOL shots are not yet stored
 * on `KolConfig.parsingHints`. The `_kol` parameter is reserved so the
 * signature stays stable when per-KOL few-shots are added.
 */
export function getClassifyFewShots(_kol: KolConfig): ClassifyFewShot[] {
  return GLOBAL_CLASSIFY_FEWSHOTS
}

/**
 * Builds the chat-message payload for a classifier call.
 *
 * Layout:
 *   user      — few-shot example message text
 *   assistant — expected label + reasoning (as JSON)
 *   …repeated for each few-shot…
 *   user      — the live bundle text to classify
 */
export function buildClassifyMessages(
  bundle: MessageBundle,
  fewShots: ClassifyFewShot[],
): LlmMessage[] {
  const messages: LlmMessage[] = []

  for (const shot of fewShots) {
    messages.push({ role: 'user', content: shot.messageText })
    messages.push({
      role: 'assistant',
      content: JSON.stringify({
        label: shot.expectedLabel,
        ...(shot.reasoning ? { reasoning: shot.reasoning } : {}),
      }),
    })
  }

  const bundleText = bundle.messages
    .map(flattenMessage)
    .filter(Boolean)
    .join('\n---\n')

  messages.push({ role: 'user', content: bundleText })
  return messages
}

/**
 * Result of `buildExtractMessages`: the messages to send AND the modality
 * actually included. The caller passes the modality straight into
 * `ExtractInput.extractedFrom` so the audit log records the truth.
 */
export interface ExtractMessageBuild {
  messages: LlmMessage[]
  extractedFrom: ExtractInput['extractedFrom']
}

/**
 * Builds the chat-message payload for an extractor call.
 *
 * For `includeImages: true`, image CDN URLs are embedded as multimodal
 * content blocks (OpenAI vision format). For `includeImages: false`, only
 * text is sent. The returned `extractedFrom` reflects what was actually
 * included, NOT what `includeImages` requested — when no images exist on
 * the bundle, we fall back to `text_only` even if `includeImages` was true.
 */
export function buildExtractMessages(
  bundle: MessageBundle,
  includeImages: boolean,
): ExtractMessageBuild {
  const textParts: string[] = []
  for (const msg of bundle.messages) {
    const text = flattenMessage(msg)
    if (text) textParts.push(text)
  }
  const joinedText = textParts.join('\n---\n')
  const hasText = joinedText.length > 0

  if (!includeImages) {
    return {
      messages: [{ role: 'user', content: joinedText }],
      extractedFrom: 'text_only',
    }
  }

  // Collect image URLs from attachments and embed images
  const imageUrls: string[] = []
  const IMAGE_EXT = /\.(png|jpg|jpeg|gif|webp)$/i
  for (const msg of bundle.messages) {
    for (const att of msg.attachments) {
      const isImageByMime = att.contentType?.startsWith('image/') === true
      const isImageByName = att.name !== undefined && IMAGE_EXT.test(att.name)
      if (isImageByMime || isImageByName) {
        imageUrls.push(att.url)
      }
    }
    for (const embed of msg.embeds) {
      if (embed.image) imageUrls.push(embed.image)
      // Note: thumbnails are intentionally skipped — too low-res to be useful
      // for vision models and just burn input tokens.
    }
  }

  if (imageUrls.length === 0) {
    return {
      messages: [{ role: 'user', content: joinedText }],
      extractedFrom: 'text_only',
    }
  }

  // Multimodal content block (OpenAI vision format)
  const contentParts: unknown[] = []
  if (hasText) {
    contentParts.push({ type: 'text', text: joinedText })
  }
  for (const url of imageUrls) {
    contentParts.push({ type: 'image_url', image_url: { url } })
  }

  return {
    messages: [{ role: 'user', content: contentParts }],
    extractedFrom: hasText ? 'text_and_image' : 'image_only',
  }
}
