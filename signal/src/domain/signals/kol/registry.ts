/**
 * KolRegistry — live KOL config registry with hot-reload.
 *
 * Implements `IKolRegistry` from `./types.ts`.
 *
 * Responsibilities:
 * - Load `kols.json` on startup, validate each entry with `kolConfigSchema`.
 * - Watch for file changes (fs.watch + 50 ms debounce, Windows-compatible).
 * - On reload success: update internal map, call onChange handlers for
 *   each KOL whose config changed.
 * - On reload failure: keep existing config valid, call onReloadFailed
 *   handlers with the error. Never silently swallow failures.
 *
 * DEC-007 — immutable snapshot contract:
 * `get()` and `list()` return `structuredClone()` copies. Node 22 provides
 * native structuredClone which handles nested arrays (e.g.
 * parsingHints.classifierExamples). Shallow freeze would be insufficient.
 */

import { readFile } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import type { IKolRegistry, KolConfig } from './types.js'
import { kolConfigSchema } from './schema.js'
import { PATHS } from '../../../core/paths.js'

const DEBOUNCE_MS = 50

export class KolRegistry implements IKolRegistry {
  private configs = new Map<string, KolConfig>()
  private changeHandlers: Array<(kolId: string, newConfig: KolConfig) => void> = []
  private reloadFailedHandlers: Array<(err: Error) => void> = []
  private watcher: FSWatcher | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly filePath: string = PATHS.kolsFile) {}

  /**
   * Load and validate kols.json. Must be called once before using the registry.
   * Throws with a precise error message if any KOL fails schema validation.
   */
  async load(): Promise<void> {
    const configs = await this.parseFile()
    this.configs = new Map(configs.map((c) => [c.id, c]))
  }

  // ── IKolRegistry ────────────────────────────────────────────────────────────

  /**
   * Return an immutable snapshot of the KOL config, or null if unknown.
   * Hot-reloads do not mutate the returned object. (DEC-007)
   */
  get(kolId: string): KolConfig | null {
    const config = this.configs.get(kolId)
    return config ? structuredClone(config) : null
  }

  /**
   * Return all KOL configs as immutable snapshots. (DEC-007)
   * The returned array is a new copy; mutations do not affect the registry.
   */
  list(): KolConfig[] {
    return Array.from(this.configs.values()).map((c) => structuredClone(c))
  }

  /** Register a callback invoked on each KOL config change after hot-reload. */
  onChange(handler: (kolId: string, newConfig: KolConfig) => void): void {
    this.changeHandlers.push(handler)
  }

  // ── Hot-reload ────────────────────────────────────────────────────────────

  /**
   * Start watching `filePath` for changes.
   * Call `close()` to stop watching before process exit.
   */
  watch(): void {
    if (this.watcher) return

    this.watcher = watch(this.filePath, { persistent: false }, (eventType) => {
      if (eventType !== 'change' && eventType !== 'rename') return
      if (this.debounceTimer) clearTimeout(this.debounceTimer)
      this.debounceTimer = setTimeout(() => void this.reload(), DEBOUNCE_MS)
    })
  }

  /**
   * Register a callback invoked when a hot-reload fails validation.
   * The old config remains in effect. Multiple handlers supported.
   */
  onReloadFailed(handler: (err: Error) => void): void {
    this.reloadFailedHandlers.push(handler)
  }

  /** Stop watching and release the file handle. */
  close(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.watcher?.close()
    this.watcher = null
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async reload(): Promise<void> {
    let newConfigs: KolConfig[]
    try {
      newConfigs = await this.parseFile()
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      for (const handler of this.reloadFailedHandlers) {
        try { handler(error) } catch { /* swallow */ }
      }
      return
    }

    const newMap = new Map(newConfigs.map((c) => [c.id, c]))

    // Fire onChange for each KOL that was added or changed.
    for (const [kolId, newConfig] of newMap) {
      const oldConfig = this.configs.get(kolId)
      const changed =
        !oldConfig || JSON.stringify(oldConfig) !== JSON.stringify(newConfig)
      if (changed) {
        this.configs.set(kolId, newConfig)
        const snapshot = structuredClone(newConfig)
        for (const handler of this.changeHandlers) {
          try { handler(kolId, snapshot) } catch { /* swallow */ }
        }
      }
    }

    // Remove KOLs that were deleted from the file (no onChange for removals).
    for (const kolId of this.configs.keys()) {
      if (!newMap.has(kolId)) {
        this.configs.delete(kolId)
      }
    }
  }

  /**
   * Read and validate kols.json.
   * Throws a human-readable error identifying the first failing KOL.
   *   KOL validation failed: KOL "1417528451589476555"
   *     Field: parsingHints.style
   *     Issue: Required
   */
  private async parseFile(): Promise<KolConfig[]> {
    const raw = await readFile(this.filePath, 'utf-8')

    let items: unknown
    try {
      items = JSON.parse(raw)
    } catch (err: unknown) {
      throw new Error(`kols.json is not valid JSON: ${String(err)}`)
    }

    if (!Array.isArray(items)) {
      throw new Error(`kols.json must be a JSON array, got ${typeof items}`)
    }

    const results: KolConfig[] = []
    for (const item of items) {
      const result = kolConfigSchema.safeParse(item)
      if (!result.success) {
        const id =
          typeof item === 'object' && item !== null && 'id' in item
            ? String((item as Record<string, unknown>)['id'])
            : 'unknown'
        const issues = result.error.errors
          .map((e) => `  Field: ${e.path.join('.') || '(root)'}\n  Issue: ${e.message}`)
          .join('\n')
        throw new Error(`KOL validation failed: KOL "${id}"\n${issues}`)
      }
      results.push(result.data as KolConfig)
    }

    return results
  }
}
