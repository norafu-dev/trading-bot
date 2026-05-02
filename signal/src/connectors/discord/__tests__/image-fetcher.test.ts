import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageFetcher } from '../image-fetcher.js'

const PNG_HEADER = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_HEADER = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])

function fakeResponse(opts: {
  status?: number
  body?: Uint8Array
  contentType?: string | null
  contentLength?: string | null
}): Response {
  const body = opts.body ?? new Uint8Array(0)
  const headers = new Headers()
  if (opts.contentType !== null) headers.set('content-type', opts.contentType ?? 'image/png')
  if (opts.contentLength !== null && opts.contentLength !== undefined) {
    headers.set('content-length', opts.contentLength)
  }
  return new Response(body as BodyInit, { status: opts.status ?? 200, headers })
}

describe('ImageFetcher', () => {
  let originalFetch: typeof fetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('returns a data URL on a healthy 200 + PNG bytes', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse({ body: PNG_HEADER, contentType: 'image/png' }))
    const f = new ImageFetcher()
    const result = await f.fetchAsDataUrl('https://cdn.example/img.png')
    expect(result).toMatch(/^data:image\/png;base64,/)
    // Decoded base64 should equal the bytes we sent
    const base64 = result?.split(',')[1] ?? ''
    expect(Buffer.from(base64, 'base64')).toEqual(Buffer.from(PNG_HEADER))
  })

  it('caches by URL — second call hits cache, no second fetch', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeResponse({ body: PNG_HEADER }))
    globalThis.fetch = fetchSpy
    const f = new ImageFetcher()
    const a = await f.fetchAsDataUrl('https://cdn.example/img.png')
    const b = await f.fetchAsDataUrl('https://cdn.example/img.png')
    expect(a).toEqual(b)
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('returns null on non-2xx', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse({ status: 404 }))
    const f = new ImageFetcher()
    expect(await f.fetchAsDataUrl('https://cdn.example/missing.png')).toBeNull()
  })

  it('returns null on fetch network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND'))
    const f = new ImageFetcher()
    expect(await f.fetchAsDataUrl('https://nope.invalid/x.png')).toBeNull()
  })

  it('refuses images larger than maxBytes (Content-Length header)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse({ contentLength: '99999999', body: PNG_HEADER }))
    const f = new ImageFetcher({ maxBytes: 1024 }) // 1 KB cap
    expect(await f.fetchAsDataUrl('https://cdn.example/huge.png')).toBeNull()
  })

  it('refuses images larger than maxBytes (post-download fallback)', async () => {
    const big = new Uint8Array(2048)
    big.set(PNG_HEADER, 0)
    globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse({ contentType: null, body: big }))
    const f = new ImageFetcher({ maxBytes: 1024 })
    expect(await f.fetchAsDataUrl('https://cdn.example/x.png')).toBeNull()
  })

  it('prefers Content-Type over extension', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeResponse({ body: JPEG_HEADER, contentType: 'image/jpeg' }),
    )
    const f = new ImageFetcher()
    const r = await f.fetchAsDataUrl('https://cdn.example/x.png')  // .png ext, but JPEG content
    expect(r).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('falls back to URL extension when content-type is generic', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeResponse({ body: PNG_HEADER, contentType: 'application/octet-stream' }),
    )
    const f = new ImageFetcher()
    const r = await f.fetchAsDataUrl('https://cdn.example/IMG_3319.png')
    expect(r).toMatch(/^data:image\/png;base64,/)
  })

  it('falls back to magic-byte sniffing when both content-type and ext are absent', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeResponse({ body: JPEG_HEADER, contentType: null }),
    )
    const f = new ImageFetcher()
    const r = await f.fetchAsDataUrl('https://cdn.example/no-extension')
    expect(r).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('returns null when mime cannot be determined', async () => {
    const random = Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeResponse({ body: random, contentType: 'application/octet-stream' }),
    )
    const f = new ImageFetcher()
    const r = await f.fetchAsDataUrl('https://cdn.example/no-extension')
    expect(r).toBeNull()
  })

  it('strips query string before parsing extension', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeResponse({ body: PNG_HEADER, contentType: 'application/octet-stream' }),
    )
    const f = new ImageFetcher()
    const r = await f.fetchAsDataUrl('https://cdn.example/IMG_3319.png?ex=abc&hm=def')
    expect(r).toMatch(/^data:image\/png;base64,/)
  })

  it('LRU caps cache size and evicts oldest', async () => {
    let bodyCounter = 0
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      bodyCounter++
      return fakeResponse({ body: PNG_HEADER })
    })
    const f = new ImageFetcher({ cacheSize: 2 })
    await f.fetchAsDataUrl('a')
    await f.fetchAsDataUrl('b')
    await f.fetchAsDataUrl('c')          // evicts 'a'
    await f.fetchAsDataUrl('a')          // re-fetch
    expect(bodyCounter).toBe(4)
    // 'b' is still cached (was touched before 'a' was evicted? actually no —
    // 'b' wasn't accessed since insertion either, but 'a' was evicted before 'b').
    // Re-fetching 'b' should re-hit the network because it's been evicted by
    // inserting 'c' then 'a'.
    await f.fetchAsDataUrl('b')
    expect(bodyCounter).toBe(5)
  })

  it('aborts on timeout', async () => {
    globalThis.fetch = vi.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const sig = (init as RequestInit | undefined)?.signal
        if (sig) {
          sig.addEventListener('abort', () => reject(new Error('aborted')))
        }
      })
    })
    const f = new ImageFetcher({ timeoutMs: 50 })
    expect(await f.fetchAsDataUrl('https://cdn.example/slow.png')).toBeNull()
  })
})
