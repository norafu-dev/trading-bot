/**
 * Generic JSON config loader with optional hot-reload.
 * @adapted-from reference/OpenAlice/src/core/config.ts
 *   Lifted pattern: readFile + JSON.parse + Zod safeParse, ENOENT handling,
 *   mkdir-on-demand. The generic `loadJsonConfig` / `watchJsonConfig` API is
 *   new — OpenAlice's config.ts is monolithic (one function loads all of
 *   OpenAlice's specific schemas). This file provides a schema-agnostic
 *   loader usable by any config file in the project.
 *
 *   Intentionally NOT auto-seeding defaults when a file is missing.
 *   OpenAlice seeds defaults; we throw `ConfigFileNotFoundError` instead.
 *   Config files in this project are managed explicitly (dashboard or manual
 *   edits), not auto-created with defaults at runtime.
 *
 * Hot-reload uses `fs.watch` with a 50 ms debounce for Windows compatibility
 * (Windows fires multiple events per atomic write).
 */

import { readFile } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

// ==================== Errors ====================

export class ConfigFileNotFoundError extends Error {
  constructor(filePath: string) {
    super(`Config file not found: ${filePath}`)
    this.name = 'ConfigFileNotFoundError'
  }
}

export class ConfigParseError extends Error {
  constructor(filePath: string, detail: string) {
    super(`Config file is not valid JSON: ${filePath}\n  ${detail}`)
    this.name = 'ConfigParseError'
  }
}

export class ConfigValidationError extends Error {
  readonly zodError: z.ZodError

  constructor(filePath: string, zodError: z.ZodError) {
    const issues = zodError.errors
      .map((e) => `  ${e.path.join('.') || '(root)'}: ${e.message}`)
      .join('\n')
    super(`Config validation failed: ${filePath}\n${issues}`)
    this.name = 'ConfigValidationError'
    this.zodError = zodError
  }
}

// ==================== Loader ====================

/**
 * Load and validate a JSON config file synchronously using a Zod schema.
 *
 * Throws:
 * - `ConfigFileNotFoundError` if the file does not exist
 * - `ConfigParseError` if the file is not valid JSON
 * - `ConfigValidationError` if the parsed value fails Zod validation
 */
export async function loadJsonConfig<T>(
  filePath: string,
  schema: z.ZodType<T>,
): Promise<T> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch (err: unknown) {
    if (isENOENT(err)) throw new ConfigFileNotFoundError(filePath)
    throw err
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err: unknown) {
    throw new ConfigParseError(filePath, String(err))
  }

  const result = schema.safeParse(parsed)
  if (!result.success) {
    throw new ConfigValidationError(filePath, result.error)
  }

  return result.data
}

// ==================== Watcher ====================

export interface JsonConfigWatcher {
  /** Stop watching the file and clean up resources. */
  close(): void
}

const DEBOUNCE_MS = 50

/**
 * Watch a JSON config file for changes and call `onChange` with the new
 * validated config whenever the file is modified.
 *
 * If re-parsing or validation fails on a change event, `onError` is called
 * with the error and the previous config remains in effect.
 *
 * Returns a watcher handle; call `.close()` to stop watching.
 */
export function watchJsonConfig<T>(
  filePath: string,
  schema: z.ZodType<T>,
  onChange: (config: T) => void,
  onError: (err: Error) => void,
): JsonConfigWatcher {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const handle: FSWatcher = watch(
    dirname(filePath),
    { persistent: false },
    (eventType, filename) => {
      // dirname-level watch fires for any file in the dir; filter to our file
      if (filename !== null && !filePath.endsWith(filename)) return
      if (eventType !== 'change' && eventType !== 'rename') return

      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(async () => {
        try {
          const config = await loadJsonConfig(filePath, schema)
          onChange(config)
        } catch (err: unknown) {
          onError(err instanceof Error ? err : new Error(String(err)))
        }
      }, DEBOUNCE_MS)
    },
  )

  return {
    close() {
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      handle.close()
    },
  }
}

// ==================== Helpers ====================

function isENOENT(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
