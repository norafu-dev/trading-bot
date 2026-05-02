import { logger } from '../../core/logger.js'
import { cdnUrlExpired, refreshOne } from './url-refresher.js'

/**
 * Fetches a remote image (typically Discord CDN) and converts it to a
 * `data:` URL that LLM vision endpoints can consume directly.
 *
 * Why this exists: Discord CDN serves attachments fine to residential /
 * VPS IPs, but blocks the cloud IPs that LLM-provider image-fetch services
 * run from (Anthropic, OpenAI internal fetchers, Cloudflare workers).
 * Sending a raw Discord URL to a vision LLM therefore reliably 404s on the
 * provider side, even when the URL works in our process. The fix is to
 * pull the bytes ourselves and embed them as base64.
 *
 * Failures degrade gracefully: a fetch error returns null, the caller
 * leaves the original URL in place, and the LLM call proceeds (and
 * probably fails on that one image — same as today, but no worse).
 *
 * Caching: same-URL repeats inside a single Extract call, or a flurry of
 * inject/replay calls during prompt iteration, hit a size-bounded LRU.
 * No TTL — Discord URLs are immutable once issued, and the LRU eviction
 * keeps memory bounded.
 */

export interface IImageFetcher {
  /**
   * Fetch `url` and return a `data:image/...;base64,...` string, or null
   * when the resource cannot be retrieved or isn't a usable image. Does
   * not throw under normal failure modes.
   */
  fetchAsDataUrl(url: string): Promise<string | null>
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024 // 8 MB — Discord caps screenshots ~8MB
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_CACHE_SIZE = 64

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

export interface ImageFetcherOptions {
  maxBytes?: number
  timeoutMs?: number
  cacheSize?: number
  /**
   * Discord selfbot token. When present, expired (or 404'd) Discord CDN
   * URLs are refreshed via the official `/attachments/refresh-urls`
   * endpoint and re-fetched. Without a token, stale URLs simply fail.
   */
  discordToken?: string
}

export class ImageFetcher implements IImageFetcher {
  /**
   * Map: url → dataUrl. Insertion order is the LRU access order — every
   * read/write moves the entry to the end, eviction takes the first.
   */
  private readonly cache = new Map<string, string>()
  private readonly maxBytes: number
  private readonly timeoutMs: number
  private readonly cacheSize: number
  private readonly discordToken: string | undefined

  constructor(opts: ImageFetcherOptions = {}) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.cacheSize = opts.cacheSize ?? DEFAULT_CACHE_SIZE
    this.discordToken = opts.discordToken
  }

  async fetchAsDataUrl(url: string): Promise<string | null> {
    // 1. Cache hit on the original URL — nothing to refresh, return.
    const cached = this.cache.get(url)
    if (cached !== undefined) {
      this.cache.delete(url)
      this.cache.set(url, cached)
      return cached
    }

    // 2. Pre-emptive refresh: if the URL is a Discord CDN URL with an
    //    expired `ex=` timestamp, refresh BEFORE fetching to skip the
    //    pointless 404 round trip.
    let effectiveUrl = url
    if (this.discordToken && cdnUrlExpired(url)) {
      const refreshed = await refreshOne(url, this.discordToken)
      if (refreshed) {
        logger.debug({ url, refreshed }, 'ImageFetcher: pre-refreshed expired Discord URL')
        effectiveUrl = refreshed
      }
    }

    const result = await this.tryFetch(effectiveUrl)
    if (result !== null) {
      this.put(url, result)
      return result
    }

    // 3. Post-fetch refresh: fetch failed (404/etc) and we haven't yet
    //    refreshed this URL. Try refresh + retry once.
    if (this.discordToken && effectiveUrl === url) {
      const refreshed = await refreshOne(url, this.discordToken)
      if (refreshed && refreshed !== url) {
        logger.debug({ url, refreshed }, 'ImageFetcher: refresh-and-retry after failed fetch')
        const second = await this.tryFetch(refreshed)
        if (second !== null) {
          this.put(url, second)
          return second
        }
      }
    }
    return null
  }

  private async tryFetch(url: string): Promise<string | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) {
        logger.debug({ url, status: res.status }, 'ImageFetcher: non-2xx response')
        return null
      }

      // content-length pre-check: refuse anything obviously too large
      const lenHeader = res.headers.get('content-length')
      if (lenHeader) {
        const len = Number(lenHeader)
        if (Number.isFinite(len) && len > this.maxBytes) {
          logger.debug(
            { url, contentLength: len, max: this.maxBytes },
            'ImageFetcher: image exceeds max size',
          )
          return null
        }
      }

      const buf = await res.arrayBuffer()
      if (buf.byteLength === 0 || buf.byteLength > this.maxBytes) {
        return null
      }

      // Prefer Content-Type, fall back to URL extension, then sniff PNG/JPEG.
      const mime = chooseMime(res.headers.get('content-type'), url, new Uint8Array(buf, 0, Math.min(buf.byteLength, 16)))
      if (!mime) {
        logger.debug({ url }, 'ImageFetcher: could not determine image mime type')
        return null
      }

      const base64 = bufferToBase64(buf)
      return `data:${mime};base64,${base64}`
    } catch (err) {
      logger.debug(
        { url, err: err instanceof Error ? err.message : String(err) },
        'ImageFetcher: fetch failed',
      )
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  private put(key: string, value: string): void {
    if (this.cache.size >= this.cacheSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) this.cache.delete(firstKey)
    }
    this.cache.set(key, value)
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function chooseMime(
  contentType: string | null,
  url: string,
  head: Uint8Array,
): string | null {
  if (contentType) {
    const trimmed = contentType.split(';')[0]?.trim().toLowerCase()
    if (trimmed?.startsWith('image/')) return trimmed
  }
  // URL extension — strip query string first
  const path = url.split('?')[0] ?? url
  const dot = path.lastIndexOf('.')
  if (dot > 0) {
    const ext = path.slice(dot + 1).toLowerCase()
    if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext]
  }
  // Magic-byte sniff
  if (head.length >= 8) {
    if (
      head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
    ) return 'image/png'
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
    if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return 'image/gif'
    if (
      head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
      head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
    ) return 'image/webp'
  }
  return null
}

function bufferToBase64(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString('base64')
}
