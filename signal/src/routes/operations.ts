import { Hono } from 'hono'
import { readFile } from 'node:fs/promises'
import { PATHS } from '../core/paths.js'
import type { Operation } from '../../../shared/types.js'

/**
 * Read-only access to the copy-trading engine's `Operation` log.
 *
 *   GET /api/operations?limit=200&kolId=...&status=...
 *
 * Returns newest-first. The dashboard `/operations` page polls this
 * to display the sizer + guard pipeline output for every signal.
 */

interface StoredRecord {
  kind: 'operation'
  record: Operation
}

export function createOperationsRoutes() {
  return new Hono().get('/', async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 200), 1000)
    const kolId = c.req.query('kolId') ?? undefined
    const status = c.req.query('status') ?? undefined

    const records = await readAll()
    records.reverse()  // newest first

    const filtered: Operation[] = []
    for (const r of records) {
      if (kolId && r.record.kolId !== kolId) continue
      if (status && r.record.status !== status) continue
      filtered.push(r.record)
      if (filtered.length >= limit) break
    }

    return c.json({
      operations: filtered,
      total: records.length,
      limit,
    })
  })
}

async function readAll(): Promise<StoredRecord[]> {
  let raw: string
  try {
    raw = await readFile(PATHS.operationsLog, 'utf-8')
  } catch (err) {
    if (isENOENT(err)) return []
    throw err
  }
  const out: StoredRecord[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as StoredRecord
      if (parsed.kind === 'operation') out.push(parsed)
    } catch {
      // skip malformed
    }
  }
  return out
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
