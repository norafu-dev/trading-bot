import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { KolConfig } from '../../../../../../shared/types.js'
import type { BaseParseContext, IParser, LlmParseContext, ParseResult } from '../types.js'
import { ParserRegistry, ParserRegistryHealthCheckError } from '../registry.js'

// ── Minimal stub parsers ───────────────────────────────────────────────────────

function makeBaseParser(name: string): IParser<BaseParseContext> {
  return {
    name,
    parse: async (): Promise<ParseResult> => {
      throw new Error('stub — not called in these tests')
    },
  }
}

function makeLlmParser(name: string): IParser<LlmParseContext> {
  return {
    name,
    parse: async (): Promise<ParseResult> => {
      throw new Error('stub — not called in these tests')
    },
  }
}

// ── Load fixture KOLs ─────────────────────────────────────────────────────────

function loadFixtureKols(file: 'kols-valid.json' | 'kols-invalid.json'): KolConfig[] {
  const p = resolve(__dirname, '../../../../../../samples/fixtures', file)
  return JSON.parse(readFileSync(p, 'utf-8')) as KolConfig[]
}

// ── Tests ─────────────────────────────────────────────────────────────────────

let registry: ParserRegistry

beforeEach(() => {
  registry = new ParserRegistry()
})

describe('ParserRegistry — registration', () => {
  it('registers and retrieves a base parser', () => {
    const parser = makeBaseParser('regex_structured')
    registry.registerBase(parser)
    expect(registry.getBase('regex_structured')).toBe(parser)
  })

  it('registers and retrieves an LLM parser', () => {
    const parser = makeLlmParser('llm_text')
    registry.registerLlm(parser)
    expect(registry.getLlm('llm_text')).toBe(parser)
  })

  it('throws on duplicate base registration', () => {
    registry.registerBase(makeBaseParser('regex_structured'))
    expect(() => registry.registerBase(makeBaseParser('regex_structured'))).toThrow(
      "Base parser 'regex_structured' is already registered",
    )
  })

  it('throws on duplicate LLM registration', () => {
    registry.registerLlm(makeLlmParser('llm_text'))
    expect(() => registry.registerLlm(makeLlmParser('llm_text'))).toThrow(
      "LLM parser 'llm_text' is already registered",
    )
  })

  it('throws when getting an unregistered base parser', () => {
    expect(() => registry.getBase('regex_structured')).toThrow(
      "No base parser registered under 'regex_structured'",
    )
  })

  it('throws when getting an unregistered LLM parser', () => {
    expect(() => registry.getLlm('llm_text')).toThrow(
      "No LLM parser registered under 'llm_text'",
    )
  })

  it('lists all base and LLM parsers', () => {
    registry.registerBase(makeBaseParser('regex_structured'))
    registry.registerLlm(makeLlmParser('llm_text'))
    registry.registerLlm(makeLlmParser('hybrid'))
    expect(registry.listBase()).toHaveLength(1)
    expect(registry.listLlm()).toHaveLength(2)
  })
})

describe('ParserRegistry.healthCheck() — using kols-valid.json fixture', () => {
  it('passes when all enabled KOL strategies are registered', () => {
    // fixture has: alpha(llm_text, enabled), beta(regex_structured, disabled), gamma(hybrid, enabled)
    registry.registerBase(makeBaseParser('regex_structured'))
    registry.registerLlm(makeLlmParser('llm_text'))
    registry.registerLlm(makeLlmParser('hybrid'))

    const kols = loadFixtureKols('kols-valid.json')
    expect(() => registry.healthCheck(kols)).not.toThrow()
  })

  it('skips disabled KOLs — passes even when their strategy is not registered', () => {
    // beta is disabled (regex_structured) — should not be checked
    registry.registerLlm(makeLlmParser('llm_text'))
    registry.registerLlm(makeLlmParser('hybrid'))

    const kols = loadFixtureKols('kols-valid.json')
    expect(() => registry.healthCheck(kols)).not.toThrow()
  })

  it('throws ParserRegistryHealthCheckError when an enabled KOL strategy is missing', () => {
    // alpha needs 'llm_text' — register only 'hybrid'
    registry.registerLlm(makeLlmParser('hybrid'))

    const kols = loadFixtureKols('kols-valid.json')
    expect(() => registry.healthCheck(kols)).toThrowError(ParserRegistryHealthCheckError)
  })

  it('error identifies the failing KOL id and strategy', () => {
    // gamma needs 'hybrid', which we don't register
    registry.registerBase(makeBaseParser('regex_structured'))
    registry.registerLlm(makeLlmParser('llm_text'))

    const kols = loadFixtureKols('kols-valid.json')
    let caught: ParserRegistryHealthCheckError | undefined
    try {
      registry.healthCheck(kols)
    } catch (e) {
      if (e instanceof ParserRegistryHealthCheckError) caught = e
    }
    expect(caught).toBeDefined()
    expect(caught?.kolId).toBe('fixture-kol-gamma')
    expect(caught?.strategy).toBe('hybrid')
    expect(caught?.bucket).toBe('llm')
  })

  it('passes with empty KOL list', () => {
    expect(() => registry.healthCheck([])).not.toThrow()
  })
})
