import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import {
  loadJsonConfig,
  watchJsonConfig,
  ConfigFileNotFoundError,
  ConfigParseError,
  ConfigValidationError,
} from '../config.js'

const testSchema = z.object({
  name: z.string(),
  count: z.number().int().positive(),
})

let testDir: string

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'trading-bot-test-cfg-'))
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('loadJsonConfig', () => {
  it('loads and validates a valid config file', async () => {
    const filePath = join(testDir, 'test.json')
    await writeFile(filePath, JSON.stringify({ name: 'alpha', count: 5 }))
    const config = await loadJsonConfig(filePath, testSchema)
    expect(config.name).toBe('alpha')
    expect(config.count).toBe(5)
  })

  it('throws ConfigFileNotFoundError when file is missing', async () => {
    const filePath = join(testDir, 'nonexistent.json')
    await expect(loadJsonConfig(filePath, testSchema)).rejects.toBeInstanceOf(
      ConfigFileNotFoundError,
    )
  })

  it('throws ConfigParseError when file is not valid JSON', async () => {
    const filePath = join(testDir, 'bad.json')
    await writeFile(filePath, '{ invalid json }')
    await expect(loadJsonConfig(filePath, testSchema)).rejects.toBeInstanceOf(
      ConfigParseError,
    )
  })

  it('throws ConfigValidationError when schema validation fails', async () => {
    const filePath = join(testDir, 'invalid.json')
    await writeFile(filePath, JSON.stringify({ name: 'ok', count: -1 }))
    await expect(loadJsonConfig(filePath, testSchema)).rejects.toBeInstanceOf(
      ConfigValidationError,
    )
  })

  it('ConfigValidationError message identifies the failing field', async () => {
    const filePath = join(testDir, 'invalid.json')
    await writeFile(filePath, JSON.stringify({ name: 'ok', count: 'not-a-number' }))
    try {
      await loadJsonConfig(filePath, testSchema)
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError)
      expect((err as Error).message).toContain('count')
    }
  })
})

describe('watchJsonConfig', () => {
  it('calls onChange when file is updated with valid config', async () => {
    const filePath = join(testDir, 'watched.json')
    await writeFile(filePath, JSON.stringify({ name: 'initial', count: 1 }))

    const received: Array<{ name: string; count: number }> = []
    const errors: Error[] = []

    const watcher = watchJsonConfig(filePath, testSchema, (cfg) => received.push(cfg), (err) => errors.push(err))

    await writeFile(filePath, JSON.stringify({ name: 'updated', count: 2 }))
    // Allow debounce + fs.watch to fire
    await new Promise((r) => setTimeout(r, 200))

    watcher.close()

    // At least one onChange call with the updated value
    const last = received.at(-1)
    if (last) {
      expect(last.name).toBe('updated')
      expect(last.count).toBe(2)
    }
    expect(errors).toHaveLength(0)
  })

  it('calls onError and does NOT call onChange when updated file is invalid', async () => {
    const filePath = join(testDir, 'watched2.json')
    await writeFile(filePath, JSON.stringify({ name: 'ok', count: 1 }))

    const received: unknown[] = []
    const errors: Error[] = []

    const watcher = watchJsonConfig(filePath, testSchema, (cfg) => received.push(cfg), (err) => errors.push(err))

    await writeFile(filePath, '{ broken json }')
    await new Promise((r) => setTimeout(r, 200))

    watcher.close()

    expect(received).toHaveLength(0)
    expect(errors.length).toBeGreaterThan(0)
  })
})
