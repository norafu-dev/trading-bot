import { Hono } from 'hono'
import type { MessageStore } from '../domain/signals/message-store.js'
import type { RawDiscordMessage, RawAttachment, RawEmbed } from '../../../../shared/types.js'

// ── Discord CDN URL refresh ──────────────────────────────────────────────────

/**
 * Discord attachment URLs contain `?ex=HEX` where HEX is the Unix expiry
 * timestamp (seconds) encoded as lowercase hex.
 */
function cdnUrlExpired(url: string): boolean {
  const m = url.match(/[?&]ex=([0-9a-f]+)/i)
  if (!m) return false
  const expiresAtSec = parseInt(m[1], 16)
  return Date.now() / 1000 > expiresAtSec
}

function collectExpiredUrls(msgs: RawDiscordMessage[]): string[] {
  const expired: string[] = []
  for (const m of msgs) {
    for (const a of m.attachments) {
      if (cdnUrlExpired(a.url)) expired.push(a.url)
    }
    for (const e of m.embeds) {
      if (e.image && cdnUrlExpired(e.image)) expired.push(e.image)
      if (e.thumbnail && cdnUrlExpired(e.thumbnail)) expired.push(e.thumbnail)
    }
  }
  return [...new Set(expired)]
}

async function refreshDiscordUrls(
  expiredUrls: string[],
  token: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (expiredUrls.length === 0) return map
  try {
    const res = await fetch('https://discord.com/api/v10/attachments/refresh-urls', {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({ attachment_urls: expiredUrls }),
    })
    if (!res.ok) return map
    const data = (await res.json()) as { refreshed_urls: Array<{ original: string; refreshed: string }> }
    for (const entry of data.refreshed_urls ?? []) {
      map.set(entry.original, entry.refreshed)
    }
  } catch {
    // best-effort: if refresh fails, return empty map and let frontend handle broken imgs
  }
  return map
}

function applyRefreshedUrls(
  msgs: RawDiscordMessage[],
  urlMap: Map<string, string>,
): RawDiscordMessage[] {
  if (urlMap.size === 0) return msgs
  return msgs.map((m) => ({
    ...m,
    attachments: m.attachments.map((a: RawAttachment) => ({
      ...a,
      url: urlMap.get(a.url) ?? a.url,
    })),
    embeds: m.embeds.map((e: RawEmbed) => ({
      ...e,
      image: e.image ? (urlMap.get(e.image) ?? e.image) : undefined,
      thumbnail: e.thumbnail ? (urlMap.get(e.thumbnail) ?? e.thumbnail) : undefined,
    })),
  }))
}

// ── Route factory ────────────────────────────────────────────────────────────

export function createMessageRoutes(store: MessageStore, discordToken?: string) {
  return new Hono()
    .get('/', async (c) => {
      const channelId = c.req.query('channelId') || undefined
      const limit = Number(c.req.query('limit') ?? 200)
      let msgs = store.query(channelId, limit)

      // Refresh expired Discord CDN URLs if we have a token
      if (discordToken) {
        const expired = collectExpiredUrls(msgs)
        if (expired.length > 0) {
          const urlMap = await refreshDiscordUrls(expired, discordToken)
          msgs = applyRefreshedUrls(msgs, urlMap)
        }
      }

      return c.json(msgs)
    })
    .get('/channels', (c) => {
      return c.json(store.distinctChannels())
    })
}
