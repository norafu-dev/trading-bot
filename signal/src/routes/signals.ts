import { Hono } from 'hono'
import { readFile } from 'node:fs/promises'
import { PATHS } from '../core/paths.js'
import type { Signal, PositionUpdate } from '../../../shared/types.js'

/**
 * Read-only access to the signal/update timeline written by ResultRouter.
 *
 * Single endpoint: `GET /api/signals?limit=200&kolId=...&since=ISO8601`.
 * Returns the most recent records first. Each entry is tagged with `kind`
 * so the dashboard can render signals and updates differently.
 */

type StoredRecord =
  | { kind: 'signal'; record: Signal }
  | { kind: 'update'; record: PositionUpdate }

export function createSignalRoutes() {
  return new Hono()
    .get('/', async (c) => {
      const limit = Math.min(Number(c.req.query('limit') ?? 200), 1000)
      const kolId = c.req.query('kolId') ?? undefined
      const sinceISO = c.req.query('since') ?? undefined
      const sinceMs = sinceISO ? Date.parse(sinceISO) : 0

      const records = await readAll()

      // Newest-first; the file is append-only so insertion order = chronological.
      records.reverse()

      const filtered: StoredRecord[] = []
      for (const r of records) {
        if (kolId && r.record.kolId !== kolId) continue
        if (sinceMs > 0) {
          const ts = r.kind === 'signal' ? r.record.parsedAt : r.record.receivedAt
          if (Date.parse(ts) < sinceMs) continue
        }
        filtered.push(r)
        if (filtered.length >= limit) break
      }

      return c.json({
        records: filtered,
        total: records.length,
        limit,
      })
    })
    .get('/:id', async (c) => {
      const id = c.req.param('id')
      const records = await readAll()

      const signal = records.find(
        (r): r is { kind: 'signal'; record: Signal } => r.kind === 'signal' && r.record.id === id,
      )
      if (!signal) return c.json({ error: `Signal ${id} not found` }, 404)

      // Linked updates: any update whose linkedSignalId matches.
      const updates = records
        .filter(
          (r): r is { kind: 'update'; record: PositionUpdate } =>
            r.kind === 'update' && r.record.linkedSignalId === id,
        )
        .map((r) => r.record)

      return c.json({ signal: signal.record, updates })
    })
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function readAll(): Promise<StoredRecord[]> {
  let raw: string
  try {
    raw = await readFile(PATHS.signalsLog, 'utf-8')
  } catch (err) {
    if (isENOENT(err)) return []
    throw err
  }

  const out: StoredRecord[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as StoredRecord
      if (parsed.kind === 'signal' || parsed.kind === 'update') {
        out.push(parsed)
      }
    } catch {
      // Skip malformed lines — store-side already logs these.
    }
  }
  return out
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
