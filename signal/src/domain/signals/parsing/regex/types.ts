import type { UpdateType } from '../common/update-schema.js'
import type { KolConfig } from '../../kol/types.js'

/**
 * A single regex field extractor.
 *
 * `pattern` is applied to the full flattened bundle text. The captured value
 * comes from the specified `group` (1-based, default 1).
 *
 * `valueMap` is applied after capture — useful for translating non-numeric
 * values to their canonical form (e.g., Chinese ordinals "一"→"1", "二"→"2").
 */
export interface FieldExtractor {
  /** Regex string (no leading/trailing slashes). Applied case-insensitively. */
  pattern: string
  /** Which capture group to use (1-based). Default: 1. */
  group?: number
  /** Optional post-capture value substitution map. */
  valueMap?: Record<string, string>
}

/**
 * Data-driven regex configuration for a single bot-format KOL.
 *
 * Stored in `data/config/regex-configs.json` — no patterns are hard-coded in
 * parser logic. The parser loads configs at startup and applies them uniformly.
 *
 * Pattern flags: case-insensitive. Patterns needing multiline behaviour must
 * use `[\s\S]` or explicit `\n` characters.
 */
export interface RegexConfig {
  /** Unique name. Matches `KolConfig.regexConfigName`. */
  name: string

  signal: {
    /**
     * Regex that must match for the text to be treated as a new signal.
     * Tried after all update detectors fail.
     */
    detector: string

    /**
     * Field extractors. Each extractor's `pattern` has at least one capture
     * group; `group` selects which group to use (default 1).
     * Missing extractors leave the corresponding Signal field absent.
     */
    fields: {
      /** Captures 'long' | 'short' (case-insensitive). */
      side?: FieldExtractor
      /** Raw symbol, e.g. "BTC", "GENIUS", "ASTEROIOD". */
      symbol?: FieldExtractor
      /** Single entry price as a Decimal string. Used when there is no range. */
      entryPrice?: FieldExtractor
      /** Lower bound of an entry price range. Decimal string. */
      entryRangeLow?: FieldExtractor
      /** Upper bound of an entry price range. Decimal string. */
      entryRangeHigh?: FieldExtractor
      /** Stop-loss price. Decimal string. */
      stopLossPrice?: FieldExtractor
      tp1?: FieldExtractor
      tp2?: FieldExtractor
      tp3?: FieldExtractor
      tp4?: FieldExtractor
      /** Leverage multiplier. Integer string. */
      leverage?: FieldExtractor
      /**
       * Risk as percent of account equity (for `size.type = 'percent'`).
       * E.g., captures "5.0" → `size = { type: 'percent', value: '5.0' }`.
       */
      riskPercent?: FieldExtractor
      /**
       * Discord message ID embedded in bot-format signal URLs, e.g.
       * `[SYMBOL](https://discord.com/channels/GUILD/CHANNEL/{msgId})`.
       * Populated only for bot KOLs that embed source links in signals.
       * Extracted into `Signal.linkedExternalMessageId`.
       */
      linkedExternalMessageId?: FieldExtractor
    }

    /** Fixed values applied to every Signal produced by this config. */
    defaults: {
      action: 'open' | 'close' | 'modify'
      entryType: 'market' | 'limit'
      contractType: 'perpetual' | 'spot'
    }
  }

  /**
   * Ordered update patterns. The parser tries each in order; the first
   * matching detector wins. Tried before the signal detector.
   *
   * `updateType` may be any `UpdateType` value including the extractor-
   * internal sentinels `'re_entry_hint'` and `'other'`. The parser
   * intercepts those and converts them to a `DiscardReason` before
   * assembling a `PositionUpdate`.
   */
  updates: Array<{
    detector: string
    updateType: UpdateType
    fields?: {
      linkedExternalMessageId?: FieldExtractor
      level?: FieldExtractor
      closedPercent?: FieldExtractor
      remainingPercent?: FieldExtractor
      newStopLoss?: FieldExtractor
      realizedPriceRef?: FieldExtractor
      realizedRR?: FieldExtractor
    }
  }>
}

export interface IRegexConfigRegistry {
  /** Register a config. Throws if `name` is already registered. */
  register(config: RegexConfig): void

  /**
   * Look up a config by name.
   * Returns null when no config is registered under that name.
   */
  get(name: string): RegexConfig | null

  /** Return all registered configs. */
  list(): RegexConfig[]

  /**
   * Validate that every enabled KOL with a `regex_structured` or `hybrid`
   * strategy has a registered config under `kol.regexConfigName`.
   *
   * Throws `RegexConfigMissingError` on the first failure.
   */
  healthCheck(kols: ReadonlyArray<KolConfig>): void
}
