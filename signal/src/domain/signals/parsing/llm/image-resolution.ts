import type { IImageFetcher } from '../../../../connectors/discord/image-fetcher.js'
import type { MessageBundle } from '../../ingestion/aggregator/types.js'
import type { LlmMessage } from '../types.js'

const IMAGE_EXT = /\.(png|jpg|jpeg|gif|webp)$/i

/**
 * Walk every message in `bundle` and collect attachment / embed image URLs
 * in chronological insertion order. Embed thumbnails are intentionally
 * skipped (too low-res to help vision models, just burn tokens).
 */
export function collectImageUrls(bundle: MessageBundle): string[] {
  const out: string[] = []
  for (const msg of bundle.messages) {
    for (const att of msg.attachments) {
      const isImageByMime = att.contentType?.startsWith('image/') === true
      const isImageByName = att.name !== undefined && IMAGE_EXT.test(att.name)
      if (isImageByMime || isImageByName) out.push(att.url)
    }
    for (const embed of msg.embeds) {
      if (embed.image) out.push(embed.image)
    }
  }
  return out
}

/**
 * Walk a message array and replace every `{ type: 'image_url', image_url:
 * { url } }` part whose `url` is an http(s) URL with a `data:` URL fetched
 * via the supplied `imageFetcher`. Existing `data:` URLs and unrecognised
 * parts pass through unchanged.
 *
 * Used by both Classifier (so the model can decide signal vs chitchat
 * based on chart screenshots) and Extractor (so it can read prices off
 * the chart). Discord CDN blocks LLM-provider IPs, so passing raw URLs
 * 404s on the provider side — fetching to base64 in our process side-
 * steps the issue.
 *
 * Returns a new array; the input is not mutated. Failures degrade
 * silently — the original URL stays put and the LLM may still recover.
 */
export async function resolveImageUrls(
  messages: LlmMessage[],
  fetcher: IImageFetcher,
): Promise<LlmMessage[]> {
  return Promise.all(
    messages.map(async (m): Promise<LlmMessage> => {
      if (typeof m.content === 'string') return m
      const parts = m.content as Array<Record<string, unknown>>
      const resolved = await Promise.all(
        parts.map(async (part) => {
          if (part.type !== 'image_url') return part
          const inner = part.image_url as { url?: unknown } | undefined
          const rawUrl = typeof inner?.url === 'string' ? inner.url : undefined
          if (!rawUrl) return part
          if (rawUrl.startsWith('data:')) return part
          const dataUrl = await fetcher.fetchAsDataUrl(rawUrl)
          if (!dataUrl) return part
          return { type: 'image_url', image_url: { url: dataUrl } }
        }),
      )
      return { role: m.role, content: resolved }
    }),
  )
}
