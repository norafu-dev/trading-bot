import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { KolConfig } from '../../../../../../shared/types.js'
import type { IKolRegistry } from '../../kol/types.js'
import type {
  BaseParseContext,
  IParser,
  LlmParseContext,
  ParseResult,
} from '../types.js'
import { ParserRegistry } from '../registry.js'
import { RegexConfigRegistry, RegexConfigMissingError } from '../regex/config-registry.js'
import { ParserDispatcher } from '../dispatcher.js'
import { makeBundle, resetSeq, WG_BOT_CONFIG } from './helpers.js'
import { makeKolConfig } from '../../ingestion/__tests__/helpers.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function loadValidKols(): KolConfig[] {
  const p = resolve(__dirname, '../../../../../../samples/fixtures/kols-valid.json')
  return JSON.parse(readFileSync(p, 'utf-8')) as KolConfig[]
}

// ── Stub registry helpers ─────────────────────────────────────────────────────

function makeStubRegistry(
  kolId: string,
  overrides: Partial<KolConfig> = {},
): IKolRegistry {
  const kol = makeKolConfig({ id: kolId, ...overrides })
  return {
    get: (id: string) => (id === kolId ? kol : null),
    list: () => [kol],
    onChange: () => {},
    onReloadFailed: () => {},
    watch: () => {},
    close: () => {},
    load: async () => {},
  }
}

function makeBaseParser(name: string): IParser<BaseParseContext> {
  return {
    name,
    parse: async (): Promise<ParseResult> => ({
      kind: 'discarded',
      reason: 'not_a_signal',
      meta: {
        parserName: name,
        bundleId: 'b',
        kolId: 'k',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    }),
  }
}

function makeLlmParser(name: string): IParser<LlmParseContext> {
  return {
    name,
    parse: async (): Promise<ParseResult> => ({
      kind: 'discarded',
      reason: 'not_a_signal',
      meta: {
        parserName: name,
        bundleId: 'b',
        kolId: 'k',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    }),
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => { resetSeq() })

describe('ParserDispatcher — routing', () => {
  it('routes regex_structured KOL to base parser', async () => {
    const called: string[] = []
    const baseParser: IParser<BaseParseContext> = {
      name: 'regex_structured',
      parse: async (): Promise<ParseResult> => {
        called.push('base')
        return {
          kind: 'discarded', reason: 'not_a_signal',
          meta: { parserName: 'regex_structured', bundleId: 'b', kolId: 'k',
            startedAt: '', completedAt: '' },
        }
      },
    }

    const parserRegistry = new ParserRegistry()
    parserRegistry.registerBase(baseParser)
    const configRegistry = new RegexConfigRegistry()
    const kolRegistry = makeStubRegistry('kol-bot', {
      parsingStrategy: 'regex_structured' as const,
      regexConfigName: 'wg-bot',
    })

    const dispatcher = new ParserDispatcher(parserRegistry, configRegistry, kolRegistry)
    await dispatcher.dispatch(makeBundle('signal text', { kolId: 'kol-bot' }))

    expect(called).toContain('base')
  })

  it('returns discarded(not_a_signal) for an unknown KOL', async () => {
    const parserRegistry = new ParserRegistry()
    const configRegistry = new RegexConfigRegistry()
    const emptyKolRegistry: IKolRegistry = {
      get: () => null,
      list: () => [],
      onChange: () => {},
      onReloadFailed: () => {},
      watch: () => {},
      close: () => {},
      load: async () => {},
    }

    const dispatcher = new ParserDispatcher(parserRegistry, configRegistry, emptyKolRegistry)
    const result = await dispatcher.dispatch(makeBundle('text', { kolId: 'unknown-kol' }))

    expect(result.kind).toBe('discarded')
    if (result.kind === 'discarded') expect(result.reason).toBe('not_a_signal')
  })

  it('returns failed when LLM strategy KOL has no llmProvider', async () => {
    const parserRegistry = new ParserRegistry()
    parserRegistry.registerLlm(makeLlmParser('llm_text'))
    const configRegistry = new RegexConfigRegistry()
    const kolRegistry = makeStubRegistry('kol-human', {
      parsingStrategy: 'llm_text' as const,
      parsingHints: { style: 'natural language' },
    })

    // No llmProvider / sessionLogger passed
    const dispatcher = new ParserDispatcher(parserRegistry, configRegistry, kolRegistry)
    const result = await dispatcher.dispatch(makeBundle('LONG BTC', { kolId: 'kol-human' }))

    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.error.code).toBe('unknown')
      expect(result.error.retriable).toBe(false)
    }
  })
})

describe('ParserDispatcher.healthCheck() — using kols-valid.json fixture', () => {
  it('passes when all required parsers and regex configs are registered', () => {
    const parserRegistry = new ParserRegistry()
    parserRegistry.registerBase(makeBaseParser('regex_structured'))
    parserRegistry.registerLlm(makeLlmParser('llm_text'))
    parserRegistry.registerLlm(makeLlmParser('hybrid'))

    // gamma uses 'bot-v2', beta (disabled) uses 'bot-v1'
    const configRegistry = new RegexConfigRegistry()
    configRegistry.register({ ...WG_BOT_CONFIG, name: 'bot-v2' })
    // bot-v1 not registered — beta is disabled, so it should be skipped

    const kolRegistry: IKolRegistry = {
      get: () => null,
      list: () => loadValidKols(),
      onChange: () => {},
      onReloadFailed: () => {},
      watch: () => {},
      close: () => {},
      load: async () => {},
    }

    const dispatcher = new ParserDispatcher(parserRegistry, configRegistry, kolRegistry)
    expect(() => dispatcher.healthCheck(loadValidKols())).not.toThrow()
  })

  it('throws when a required RegexConfig is missing for an enabled KOL', () => {
    const parserRegistry = new ParserRegistry()
    parserRegistry.registerBase(makeBaseParser('regex_structured'))
    parserRegistry.registerLlm(makeLlmParser('llm_text'))
    parserRegistry.registerLlm(makeLlmParser('hybrid'))

    // gamma (enabled, hybrid) needs 'bot-v2' — not registered
    const configRegistry = new RegexConfigRegistry()

    const kolRegistry: IKolRegistry = {
      get: () => null,
      list: () => loadValidKols(),
      onChange: () => {},
      onReloadFailed: () => {},
      watch: () => {},
      close: () => {},
      load: async () => {},
    }

    const dispatcher = new ParserDispatcher(parserRegistry, configRegistry, kolRegistry)
    expect(() => dispatcher.healthCheck(loadValidKols())).toThrowError(RegexConfigMissingError)
  })
})

describe('RegexConfigRegistry.healthCheck()', () => {
  it('passes when all enabled regex KOLs have their config registered', () => {
    const configRegistry = new RegexConfigRegistry()
    configRegistry.register({ ...WG_BOT_CONFIG, name: 'bot-v2' })

    // kols-valid.json: gamma (hybrid, bot-v2, enabled), beta (regex, bot-v1, disabled)
    expect(() => configRegistry.healthCheck(loadValidKols())).not.toThrow()
  })

  it('throws RegexConfigMissingError for missing config name', () => {
    const configRegistry = new RegexConfigRegistry()
    // Register nothing — gamma needs bot-v2

    expect(() => configRegistry.healthCheck(loadValidKols())).toThrowError(RegexConfigMissingError)
  })

  it('error identifies the failing KOL and missing config name', () => {
    const configRegistry = new RegexConfigRegistry()

    let caught: RegexConfigMissingError | undefined
    try {
      configRegistry.healthCheck(loadValidKols())
    } catch (e) {
      if (e instanceof RegexConfigMissingError) caught = e
    }
    expect(caught?.kolId).toBe('fixture-kol-gamma')
    expect(caught?.regexConfigName).toBe('bot-v2')
  })

  it('registers and retrieves a config correctly', () => {
    const configRegistry = new RegexConfigRegistry()
    configRegistry.register(WG_BOT_CONFIG)
    expect(configRegistry.get('wg-bot')).toBe(WG_BOT_CONFIG)
    expect(configRegistry.get('missing')).toBeNull()
  })

  it('throws on duplicate registration', () => {
    const configRegistry = new RegexConfigRegistry()
    configRegistry.register(WG_BOT_CONFIG)
    expect(() => configRegistry.register(WG_BOT_CONFIG)).toThrow(
      "RegexConfig 'wg-bot' is already registered",
    )
  })
})
