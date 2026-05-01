import { Hono } from 'hono'
import { readFile } from 'node:fs/promises'
import { PATHS } from '../core/paths.js'

/**
 * Read-only access to the event-log JSONL.
 *
 * `GET /api/events?limit=100&type=signal.parsed&page=1`
 * Returns newest-first. The dashboard uses this for the live event ticker
 * and for filtering by event type (parse.discarded, update.unlinked, etc.).
 */

interface StoredEvent {
  seq: number
  ts: number
  type: string
  payload: unknown
}

export function createEventRoutes() {
  return new Hono().get('/', async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 100), 1000)
    const type = c.req.query('type') ?? undefined
    const page = Math.max(1, Number(c.req.query('page') ?? 1))

    const all = await readAll()
    const matching = type ? all.filter((e) => e.type === type) : all

    // Newest first
    matching.reverse()

    const start = (page - 1) * limit
    const entries = matching.slice(start, start + limit)
    const totalPages = Math.max(1, Math.ceil(matching.length / limit))

    return c.json({
      entries,
      total: matching.length,
      page,
      pageSize: limit,
      totalPages,
    })
  })
}

async function readAll(): Promise<StoredEvent[]> {
  let raw: string
  try {
    raw = await readFile(PATHS.eventLog, 'utf-8')
  } catch (err) {
    if (isENOENT(err)) return []
    throw err
  }

  const out: StoredEvent[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as StoredEvent)
    } catch {
      // skip malformed
    }
  }
  return out
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
