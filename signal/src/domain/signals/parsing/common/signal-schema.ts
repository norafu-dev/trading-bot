import { z } from 'zod'

/**
 * Zod schema for the fields an extractor (LLM or regex) can populate.
 *
 * This is what gets passed to `generateObject` as the output schema.
 * Pipeline metadata that is added AFTER extraction (id, kolId, bundleId,
 * parsedAt, parserType, rawText, messageId, channelId) is NOT in this schema.
 *
 * Naming conventions:
 * - All price / quantity / percentage values are Decimal strings ("73289",
 *   "0.13754"). Never plain numbers. Parser code must never use `number` for
 *   financial values.
 * - `symbol` is preserved exactly as the KOL wrote it — no CCXT normalisation.
 *   "BTC", "HYPE", "GENIUS", "ASTEROIOD" are all valid.
 */
export const signalExtractSchema = z.object({
  /**
   * Trade intent.
   * - 'open'   → new position or adding to an existing one
   * - 'close'  → KOL is explicitly closing (not via stop loss)
   * - 'modify' → KOL is changing parameters of an existing open position
   */
  action: z.enum(['open', 'close', 'modify']),

  /** 'long' for bullish, 'short' for bearish. Omit for spot-only signals. */
  side: z.enum(['long', 'short']).optional(),

  /**
   * Raw symbol exactly as the KOL wrote it.
   * Examples: "BTC", "HYPE", "GENIUS", "ASTEROIOD", "HUSDT".
   * The broker layer is responsible for CCXT normalisation and typo mapping.
   */
  symbol: z.string().min(1),

  /** 'spot' for non-margin spot trades; 'perpetual' for futures/perps. */
  contractType: z.enum(['perpetual', 'spot']).optional(),

  entry: z
    .object({
      type: z.enum(['market', 'limit']),
      /**
       * Entry price as a Decimal string.
       * Omitted for market orders or when only a range is given.
       */
      price: z.string().optional(),
      /** Lower bound of an entry range (e.g., "76640"). Decimal string. */
      priceRangeLow: z.string().optional(),
      /** Upper bound of an entry range. Decimal string. */
      priceRangeHigh: z.string().optional(),
    })
    .optional(),

  stopLoss: z
    .object({
      /**
       * Fixed stop-loss price as a Decimal string.
       * May be absent when the stop is conditional (see `condition`).
       */
      price: z.string().optional(),
      /**
       * Human-readable conditional stop description.
       * Example: "1H close under 0.0256"
       * Set when the KOL specifies a candlestick-close condition rather than
       * an absolute price.
       */
      condition: z.string().optional(),
    })
    .optional(),

  /**
   * Take-profit levels, ordered by level number (1 = first TP).
   * Multiple TPs are common (KOLs often scale out in tranches).
   * All prices are Decimal strings.
   */
  takeProfits: z
    .array(
      z.object({
        /** 1-based level index. TP1 = 1, TP2 = 2, etc. */
        level: z.number().int().min(1),
        price: z.string(),
      }),
    )
    .optional(),

  /** Intended position size, when the KOL specifies one. */
  size: z
    .object({
      /**
       * 'percent' → percentage of account equity (e.g., "5" means 5%).
       * 'absolute' → specific notional amount in quote currency.
       */
      type: z.enum(['percent', 'absolute']),
      value: z.string(),
    })
    .optional(),

  /** Leverage multiplier (1 = no leverage / spot). */
  leverage: z.number().int().min(1).optional(),

  /**
   * LLM's self-assessed confidence in this extraction [0, 1].
   * RegexParser always sets 1.0 (deterministic match).
   * Values below the configured threshold cause the result to be discarded.
   */
  confidence: z.number().min(0).max(1),

  // NOTE: `extractedFrom` is intentionally NOT in this schema.
  // The provider declares which modalities it sent (via ExtractInput.extractedFrom);
  // that value flows back through ExtractMeta and onto Signal.extractedFrom.
  // Asking the LLM to self-report introduces a second source of truth that can
  // disagree with what was actually sent.

  /**
   * Flag raised when the extractor detects suspicious price unit mismatch.
   * Example: entry 7101 vs TP 0.008138 implies a ~1e6x unit discrepancy.
   *
   * When `detected: true`, downstream guards force the signal into manual
   * approval regardless of other confidence scores.
   */
  unitAnomaly: z
    .object({
      detected: z.boolean(),
      /** LLM's observation, e.g. "entry 7101 与 TP 0.008138 单位差约 1e6". */
      description: z.string(),
    })
    .optional(),

  /** Any qualifying notes from the KOL's message worth preserving. */
  notes: z.string().optional(),

  /**
   * LLM chain-of-thought reasoning that produced this extraction.
   * Stored for prompt-engineering audits only; never displayed to end users.
   * Min 20 chars: a one-word "ok" reasoning is useless for prompt iteration.
   */
  reasoning: z.string().min(20).optional(),
})

/** TypeScript type inferred from `signalExtractSchema`. */
export type SignalExtract = z.infer<typeof signalExtractSchema>
