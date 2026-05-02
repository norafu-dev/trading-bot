/**
 * Discord attachment URL refresh.
 *
 * Discord CDN URLs include a signed `ex` (expiry) parameter — they 404
 * once expired (~24 h after issue). The official `/attachments/refresh-urls`
 * endpoint takes a list of stale URLs and returns the same content paths
 * with fresh signatures. Requires a logged-in Discord token (selfbot).
 *
 * Used by:
 *   - `routes/messages.ts` — refreshes URLs before serving them to the
 *     dashboard so `<img>` tags don't 404
 *   - `image-fetcher.ts` — refreshes before downloading the bytes for
 *     vision LLM input, since the stale URLs return 404 even from our
 *     residential / VPS process
 */

/**
 * `?ex=HEX` carries the Unix expiry timestamp (seconds) as lowercase hex.
 * `now > expiresAt` ⇒ already 404 / will 404 imminently.
 *
 * Returns false when the URL has no `ex=` param at all (some non-attachment
 * Discord URLs don't carry one — assume not-stale).
 */
export function cdnUrlExpired(url: string): boolean {
  const m = url.match(/[?&]ex=([0-9a-f]+)/i)
  if (!m) return false
  const expiresAtSec = parseInt(m[1], 16)
  if (!Number.isFinite(expiresAtSec) || expiresAtSec <= 0) return false
  return Date.now() / 1000 > expiresAtSec
}

/**
 * Calls `POST /api/v10/attachments/refresh-urls` with a batch of expired
 * URLs and returns a `original → refreshed` map. Failures (network, auth,
 * 4xx/5xx) collapse to an empty map — the caller should fall back to the
 * original URL and let the downstream consumer decide what to do.
 *
 * Best-effort by design: this is plumbing for "try harder before giving
 * up", never a critical path.
 */
export async function refreshDiscordUrls(
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
    const data = (await res.json()) as {
      refreshed_urls?: Array<{ original: string; refreshed: string }>
    }
    for (const entry of data.refreshed_urls ?? []) {
      map.set(entry.original, entry.refreshed)
    }
  } catch {
    // best-effort
  }
  return map
}

/**
 * Convenience for callers with a single URL to refresh. Returns the
 * refreshed URL, or null when the API said no.
 */
export async function refreshOne(url: string, token: string): Promise<string | null> {
  const map = await refreshDiscordUrls([url], token)
  return map.get(url) ?? null
}
