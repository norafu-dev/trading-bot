import type { IImageFetcher } from '../../../connectors/discord/image-fetcher.js'
import type { IPriceService } from '../../../connectors/market/types.js'
import type { MessageBundle } from '../ingestion/aggregator/types.js'
import type { KolConfig, IKolRegistry } from '../kol/types.js'
import type {
  BaseParseContext,
  ILlmProvider,
  IParserRegistry,
  ISessionLogger,
  LlmParseContext,
  ParseMeta,
  ParseResult,
} from './types.js'
import type { IRegexConfigRegistry } from './regex/types.js'

/**
 * Routes a `MessageBundle` to the correct parser implementation based on the
 * originating KOL's `parsingStrategy`.
 *
 * - `regex_structured` → fetches a base-bucket parser, builds `BaseParseContext`
 * - `llm_text` / `llm_vision` / `hybrid` → fetches an LLM-bucket parser, builds
 *   `LlmParseContext` (requires `llmProvider` and `sessionLogger`)
 *
 * `healthCheck()` must be called once after all parsers are registered and before
 * the first bundle is dispatched.
 */
export class ParserDispatcher {
  constructor(
    private readonly registry: IParserRegistry,
    private readonly regexConfigRegistry: IRegexConfigRegistry,
    private readonly kolRegistry: IKolRegistry,
    private readonly llmProvider?: ILlmProvider,
    private readonly sessionLogger?: ISessionLogger,
    /**
     * Optional — when present the LlmParseContext gains a `priceService`
     * field that the Extractor uses to inject a live price hint into the
     * system prompt for unit normalisation. Layer 2 of price-check.
     */
    private readonly priceService?: IPriceService,
    /**
     * Optional — when present the Extractor pre-downloads attachment /
     * embed images and feeds them to the LLM as `data:` URLs (Discord's
     * CDN blocks LLM-provider IPs, so URLs sent verbatim 404).
     */
    private readonly imageFetcher?: IImageFetcher,
  ) {}

  async dispatch(bundle: MessageBundle): Promise<ParseResult> {
    const now = new Date()
    const kol = this.kolRegistry.get(bundle.kolId)

    if (!kol) {
      return {
        kind: 'discarded',
        reason: 'not_a_signal',
        meta: buildMeta('dispatcher', bundle, now),
      }
    }

    const strategy = kol.parsingStrategy ?? 'llm_text'
    const baseCtx: BaseParseContext = { bundle, kol, now }

    if (strategy === 'regex_structured') {
      const parser = this.registry.getBase('regex_structured')
      return parser.parse(baseCtx)
    }

    if (!this.llmProvider || !this.sessionLogger) {
      return {
        kind: 'failed',
        error: {
          code: 'unknown',
          message: `Strategy '${strategy}' requires an LLM provider and session logger, but none were provided to the dispatcher`,
          retriable: false,
        },
        meta: buildMeta(strategy, bundle, now),
      }
    }

    const llmCtx: LlmParseContext = {
      ...baseCtx,
      llmProvider: this.llmProvider,
      sessionLogger: this.sessionLogger,
      ...(this.priceService && { priceService: this.priceService }),
      ...(this.imageFetcher && { imageFetcher: this.imageFetcher }),
    }
    const parser = this.registry.getLlm(strategy)
    return parser.parse(llmCtx)
  }

  /**
   * Full startup health check.
   * 1. Validates every enabled KOL's `parsingStrategy` resolves to a registered
   *    parser in the correct bucket (`IParserRegistry.healthCheck`).
   * 2. Validates every enabled regex/hybrid KOL's `regexConfigName` resolves to
   *    a registered `RegexConfig` (`IRegexConfigRegistry.healthCheck`).
   *
   * Throws on the first failure. Call once after registration.
   */
  healthCheck(kols: ReadonlyArray<KolConfig>): void {
    this.registry.healthCheck(kols)
    this.regexConfigRegistry.healthCheck(kols)
  }
}

function buildMeta(parserName: string, bundle: MessageBundle, now: Date): ParseMeta {
  const ts = now.toISOString()
  return { parserName, bundleId: bundle.id, kolId: bundle.kolId, startedAt: ts, completedAt: ts }
}
