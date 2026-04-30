import type { KolConfig } from '../kol/types.js'
import type {
  BaseParseContext,
  IParser,
  IParserRegistry,
  LlmParseContext,
} from './types.js'

export class ParserRegistryHealthCheckError extends Error {
  constructor(
    message: string,
    public readonly kolId: string,
    public readonly strategy: string,
    public readonly bucket: 'base' | 'llm',
  ) {
    super(message)
    this.name = 'ParserRegistryHealthCheckError'
  }
}

const BASE_STRATEGIES = new Set(['regex_structured'])
const LLM_STRATEGIES = new Set(['llm_text', 'llm_vision', 'hybrid'])

export class ParserRegistry implements IParserRegistry {
  private readonly base = new Map<string, IParser<BaseParseContext>>()
  private readonly llm = new Map<string, IParser<LlmParseContext>>()

  registerBase(parser: IParser<BaseParseContext>): void {
    if (this.base.has(parser.name)) {
      throw new Error(`Base parser '${parser.name}' is already registered`)
    }
    this.base.set(parser.name, parser)
  }

  registerLlm(parser: IParser<LlmParseContext>): void {
    if (this.llm.has(parser.name)) {
      throw new Error(`LLM parser '${parser.name}' is already registered`)
    }
    this.llm.set(parser.name, parser)
  }

  getBase(name: string): IParser<BaseParseContext> {
    const parser = this.base.get(name)
    if (!parser) throw new Error(`No base parser registered under '${name}'`)
    return parser
  }

  getLlm(name: string): IParser<LlmParseContext> {
    const parser = this.llm.get(name)
    if (!parser) throw new Error(`No LLM parser registered under '${name}'`)
    return parser
  }

  listBase(): IParser<BaseParseContext>[] {
    return Array.from(this.base.values())
  }

  listLlm(): IParser<LlmParseContext>[] {
    return Array.from(this.llm.values())
  }

  healthCheck(kols: ReadonlyArray<KolConfig>): void {
    for (const kol of kols) {
      if (!kol.enabled) continue

      const strategy = kol.parsingStrategy ?? 'llm_text'

      if (BASE_STRATEGIES.has(strategy)) {
        if (!this.base.has(strategy)) {
          throw new ParserRegistryHealthCheckError(
            `KOL '${kol.id}' uses strategy '${strategy}' but no base parser is registered under that name`,
            kol.id,
            strategy,
            'base',
          )
        }
      } else if (LLM_STRATEGIES.has(strategy)) {
        if (!this.llm.has(strategy)) {
          throw new ParserRegistryHealthCheckError(
            `KOL '${kol.id}' uses strategy '${strategy}' but no LLM parser is registered under that name`,
            kol.id,
            strategy,
            'llm',
          )
        }
      }
    }
  }
}
