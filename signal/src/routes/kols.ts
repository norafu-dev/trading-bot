import { Hono } from 'hono'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PATHS } from '../core/paths.js'
import {
  readKols,
  writeKols,
  readChannels,
  writeChannels,
  createKolSchema,
  updateKolSchema,
  createChannelSchema,
  updateChannelSchema,
} from '../domain/signals/kol-store.js'
import type { DiscordListener } from '../connectors/discord/listener.js'

const AVATARS_DIR = resolve(PATHS.dataRoot, 'avatars')

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}
const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
}

function autoReload(listener: DiscordListener | null) {
  if (listener) void listener.reloadConfig()
}

export function createKolChannelRoutes(listener: DiscordListener | null) {
  return new Hono()
    // ==================== KOLs ====================
    .get('/kols', async (c) => {
      return c.json(await readKols())
    })
    .post('/kols', async (c) => {
      const body = await c.req.json()
      const parsed = createKolSchema.safeParse(body)
      if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
      const kols = await readKols()
      if (kols.find((k) => k.id === parsed.data.id)) {
        return c.json({ error: `KOL "${parsed.data.id}" already exists` }, 409)
      }
      const newKol = { ...parsed.data, addedAt: new Date().toISOString() }
      await writeKols([...kols, newKol])
      autoReload(listener)
      return c.json(newKol, 201)
    })
    .put('/kols/:id', async (c) => {
      const id = c.req.param('id')
      const body = await c.req.json()
      const parsed = updateKolSchema.safeParse(body)
      if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
      const kols = await readKols()
      const idx = kols.findIndex((k) => k.id === id)
      if (idx === -1) return c.json({ error: `KOL "${id}" not found` }, 404)
      // Deep-merge parsingHints so callers that only edit a subset of hint
      // fields (e.g. dashboard editing `style` + `imagePolicy`) don't blow away
      // unrelated fields the signal domain owns (classifierExamples,
      // extractorExamples, vocabulary, fieldDefaults). Other top-level fields
      // remain a plain shallow merge — replacing a scalar like riskMultiplier
      // is the obvious PUT semantics.
      const existing = kols[idx]
      const incoming = parsed.data
      const mergedHints =
        incoming.parsingHints !== undefined
          ? { ...(existing.parsingHints ?? {}), ...incoming.parsingHints }
          : existing.parsingHints
      kols[idx] = {
        ...existing,
        ...incoming,
        ...(mergedHints !== undefined && { parsingHints: mergedHints }),
      }
      await writeKols(kols)
      autoReload(listener)
      return c.json(kols[idx])
    })
    .delete('/kols/:id', async (c) => {
      const id = c.req.param('id')
      const kols = await readKols()
      const filtered = kols.filter((k) => k.id !== id)
      if (filtered.length === kols.length) {
        return c.json({ error: `KOL "${id}" not found` }, 404)
      }
      await writeKols(filtered)
      autoReload(listener)
      return c.body(null, 204)
    })

    // ---- Avatar upload ----
    .post('/kols/:id/avatar', async (c) => {
      const id = c.req.param('id')
      const kols = await readKols()
      const idx = kols.findIndex((k) => k.id === id)
      if (idx === -1) return c.json({ error: `KOL "${id}" not found` }, 404)

      const formData = await c.req.formData()
      const file = formData.get('avatar')
      if (!file || !(file instanceof File)) {
        return c.json({ error: 'Missing avatar field (must be a file)' }, 400)
      }

      const mimeType = file.type || 'image/jpeg'
      const ext = MIME_TO_EXT[mimeType] ?? 'jpg'
      await mkdir(AVATARS_DIR, { recursive: true })
      const filename = `${id}.${ext}`
      const filepath = resolve(AVATARS_DIR, filename)
      const bytes = await file.arrayBuffer()
      await writeFile(filepath, Buffer.from(bytes))

      kols[idx] = { ...kols[idx], avatarPath: `avatars/${filename}` }
      await writeKols(kols)
      autoReload(listener)
      return c.json(kols[idx])
    })

    // ---- Avatar read ----
    .get('/kols/:id/avatar', async (c) => {
      const id = c.req.param('id')
      const kols = await readKols()
      const kol = kols.find((k) => k.id === id)
      if (!kol?.avatarPath) return c.json({ error: 'No avatar' }, 404)

      try {
        const filepath = resolve(PATHS.dataRoot, kol.avatarPath)
        const data = await readFile(filepath)
        const ext = kol.avatarPath.split('.').pop()?.toLowerCase() ?? 'jpg'
        const contentType = EXT_TO_MIME[ext] ?? 'image/jpeg'
        return new Response(data, {
          headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' },
        })
      } catch {
        return c.json({ error: 'Avatar file missing' }, 404)
      }
    })

    // ==================== Channels ====================
    .get('/channels', async (c) => {
      return c.json(await readChannels())
    })
    .post('/channels', async (c) => {
      const body = await c.req.json()
      const parsed = createChannelSchema.safeParse(body)
      if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
      const channels = await readChannels()
      if (channels.find((ch) => ch.id === parsed.data.id)) {
        return c.json({ error: `Channel "${parsed.data.id}" already exists` }, 409)
      }
      const newCh = { ...parsed.data, addedAt: new Date().toISOString() }
      await writeChannels([...channels, newCh])
      autoReload(listener)
      return c.json(newCh, 201)
    })
    .put('/channels/:id', async (c) => {
      const id = c.req.param('id')
      const body = await c.req.json()
      const parsed = updateChannelSchema.safeParse(body)
      if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
      const channels = await readChannels()
      const idx = channels.findIndex((ch) => ch.id === id)
      if (idx === -1) return c.json({ error: `Channel "${id}" not found` }, 404)
      channels[idx] = { ...channels[idx], ...parsed.data }
      await writeChannels(channels)
      autoReload(listener)
      return c.json(channels[idx])
    })
    .delete('/channels/:id', async (c) => {
      const id = c.req.param('id')
      const channels = await readChannels()
      const filtered = channels.filter((ch) => ch.id !== id)
      if (filtered.length === channels.length) {
        return c.json({ error: `Channel "${id}" not found` }, 404)
      }
      await writeChannels(filtered)
      autoReload(listener)
      return c.body(null, 204)
    })
}
