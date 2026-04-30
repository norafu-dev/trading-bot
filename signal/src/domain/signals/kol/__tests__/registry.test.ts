import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { KolRegistry } from '../registry.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const FIXTURES_DIR = resolve(__dirname, '../../../../../../samples/fixtures')
const VALID_FIXTURE = join(FIXTURES_DIR, 'kols-valid.json')
const INVALID_FIXTURE = join(FIXTURES_DIR, 'kols-invalid.json')

let testDir: string

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'trading-bot-test-reg-'))
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('KolRegistry.load()', () => {
  it('loads a valid kols.json and makes entries available via get()', async () => {
    const filePath = join(testDir, 'kols.json')
    await copyFile(VALID_FIXTURE, filePath)

    const registry = new KolRegistry(filePath)
    await registry.load()

    const alpha = registry.get('fixture-kol-alpha')
    expect(alpha).not.toBeNull()
    expect(alpha!.label).toBe('Alpha')
    expect(alpha!.parsingStrategy).toBe('llm_text')
  })

  it('returns null for an unknown kolId', async () => {
    const filePath = join(testDir, 'kols.json')
    await copyFile(VALID_FIXTURE, filePath)

    const registry = new KolRegistry(filePath)
    await registry.load()

    expect(registry.get('does-not-exist')).toBeNull()
  })

  it('throws with KOL ID in message when parsingHints is missing for llm_text', async () => {
    const filePath = join(testDir, 'kols.json')
    await copyFile(INVALID_FIXTURE, filePath)

    const registry = new KolRegistry(filePath)
    await expect(registry.load()).rejects.toThrow('invalid-missing-hints')
  })

  it('throws a message identifying the failing field', async () => {
    const filePath = join(testDir, 'kols.json')
    await copyFile(INVALID_FIXTURE, filePath)

    const registry = new KolRegistry(filePath)
    try {
      await registry.load()
      expect.fail('should have thrown')
    } catch (err) {
      expect((err as Error).message).toContain('parsingHints')
    }
  })

  it('throws when kols.json is not a JSON array', async () => {
    const filePath = join(testDir, 'kols.json')
    await writeFile(filePath, JSON.stringify({ not: 'an array' }))

    const registry = new KolRegistry(filePath)
    await expect(registry.load()).rejects.toThrow('JSON array')
  })
})

describe('KolRegistry.list()', () => {
  it('returns all KOL configs', async () => {
    const filePath = join(testDir, 'kols.json')
    await copyFile(VALID_FIXTURE, filePath)

    const registry = new KolRegistry(filePath)
    await registry.load()

    const all = registry.list()
    expect(all).toHaveLength(3)
    expect(all.map((k) => k.id)).toContain('fixture-kol-alpha')
  })
})

// ── DEC-007: Immutable snapshot contract ────────────────────────────────────

describe('DEC-007 — immutable snapshot', () => {
  it('mutating a get() result does not affect the registry internal state', async () => {
    const filePath = join(testDir, 'kols.json')
    await copyFile(VALID_FIXTURE, filePath)

    const registry = new KolRegistry(filePath)
    await registry.load()

    const snapshot1 = registry.get('fixture-kol-alpha')!
    // Mutate the returned snapshot
    ;(snapshot1 as Record<string, unknown>)['label'] = 'HACKED'
    // Re-fetch — must still be original value
    const snapshot2 = registry.get('fixture-kol-alpha')!
    expect(snapshot2.label).toBe('Alpha')
  })

  it('mutating a list() result does not affect the registry internal state', async () => {
    const filePath = join(testDir, 'kols.json')
    await copyFile(VALID_FIXTURE, filePath)

    const registry = new KolRegistry(filePath)
    await registry.load()

    const [first] = registry.list()
    ;(first as Record<string, unknown>)['label'] = 'MUTATED'

    const fresh = registry.get(first.id)!
    expect(fresh.label).not.toBe('MUTATED')
  })

  it('mutating nested parsingHints does not affect registry internal state', async () => {
    const filePath = join(testDir, 'kols.json')
    await copyFile(VALID_FIXTURE, filePath)

    const registry = new KolRegistry(filePath)
    await registry.load()

    const snap = registry.get('fixture-kol-alpha')!
    if (snap.parsingStrategy === 'llm_text') {
      snap.parsingHints.classifierExamples = [
        {
          inputText: 'injected',
          expected: { kind: 'classification', label: 'chitchat' },
        },
      ]
    }

    const fresh = registry.get('fixture-kol-alpha')!
    if (fresh.parsingStrategy === 'llm_text') {
      expect(fresh.parsingHints.classifierExamples ?? []).toHaveLength(0)
    }
  })
})

// ── Hot-reload ────────────────────────────────────────────────────────────────

describe('KolRegistry hot-reload', () => {
  it('calls all onChange handlers when a KOL config changes', async () => {
    const filePath = join(testDir, 'kols.json')
    await copyFile(VALID_FIXTURE, filePath)

    const registry = new KolRegistry(filePath)
    await registry.load()

    const calls1: string[] = []
    const calls2: string[] = []
    registry.onChange((kolId) => calls1.push(kolId))
    registry.onChange((kolId) => calls2.push(kolId))

    registry.watch()

    // Write an updated version with riskMultiplier changed
    const updated = JSON.parse(
      await (await import('node:fs/promises')).readFile(VALID_FIXTURE, 'utf-8'),
    ) as Array<Record<string, unknown>>
    updated[0] = { ...updated[0], riskMultiplier: 99 }
    await writeFile(filePath, JSON.stringify(updated, null, 2))

    await new Promise((r) => setTimeout(r, 200))
    registry.close()

    expect(calls1).toContain('fixture-kol-alpha')
    expect(calls2).toContain('fixture-kol-alpha')
  })

  it('keeps old config valid and calls onReloadFailed when reload fails validation', async () => {
    const filePath = join(testDir, 'kols.json')
    await copyFile(VALID_FIXTURE, filePath)

    const registry = new KolRegistry(filePath)
    await registry.load()

    const errors: Error[] = []
    registry.onReloadFailed((err) => errors.push(err))
    registry.watch()

    // Write an invalid config
    await copyFile(INVALID_FIXTURE, filePath)
    await new Promise((r) => setTimeout(r, 200))
    registry.close()

    // Old config still valid
    expect(registry.get('fixture-kol-alpha')).not.toBeNull()
    // Error was reported
    expect(errors.length).toBeGreaterThan(0)
  })
})
