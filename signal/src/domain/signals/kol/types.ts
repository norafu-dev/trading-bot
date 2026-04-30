/**
 * @todo Before the dashboard batch: lift the `parsingStrategy` discriminated
 *   union into `shared/types.ts` so `SharedKolConfig` and the signal domain's
 *   `KolConfig` share the same shape. Currently this file `Omit`s three fields
 *   from `SharedKolConfig` and redefines them as a discriminated union, meaning
 *   the dashboard (which reads `SharedKolConfig` directly) sees a looser type
 *   that could allow writes inconsistent with what the signal domain expects.
 *
 * @todo After the shared type is lifted: have the dashboard use the same Zod
 *   schema for client-side validation, preventing the edit → write-back →
 *   signal-domain crash scenario.
 */

import type { ClassificationLabel } from '../parsing/common/labels.js'
import type { KolConfig as SharedKolConfig } from '../../../../../shared/types.js'

/**
 * Which parsing strategy the pipeline should use for a KOL's messages.
 *
 * - 'regex_structured'  Bot KOLs with machine-generated, fixed-format messages.
 * - 'llm_text'          Human KOLs whose signals are natural-language text.
 * - 'llm_vision'        Human KOLs who put key data (TPs, SL) inside chart images.
 * - 'hybrid'            Try regex first; fall back to LLM when regex fails.
 */
export type ParserType = 'regex_structured' | 'llm_text' | 'llm_vision' | 'hybrid'

/**
 * A labelled example used to ground the LLM classifier or extractor in this
 * KOL's specific signal style.
 *
 * Stored in kols.json and hot-reloaded; updates take effect on the next parse
 * call without a process restart.
 *
 * Design note — why `inputText` / `inputImages` instead of a raw `MessageBundle`:
 * Few-shot examples are teaching material for the LLM. They must be clean,
 * pre-processed text, never raw metadata (messageId, authorId, timestamps).
 * Embedding metadata would pollute the LLM's reasoning about the trade signal.
 * The conversion from `MessageBundle` to `inputText` is the prompt-builder's
 * job (batch 5), not the config layer's.
 *
 * Design note — why `expected.data` is `unknown`:
 * Few-shot extraction examples may include intentional teaching counter-examples
 * with incomplete fields (showing the LLM what NOT to do). Strict Zod validation
 * at load time would block valid instructional examples. Consuming code applies
 * `signalExtractSchema` / `positionUpdateExtractSchema` to the extracted data
 * at runtime, not at config-load time.
 */
export interface FewShotExample {
  /** Human-readable annotation note. Not included in LLM prompts. */
  description?: string

  /**
   * Pre-flattened input text: `content` + embed title/description/fields
   * combined into a single plain-text string.
   * Produced by `FlattenMessageContent` (parsing/common/message-content.ts).
   */
  inputText: string

  /** Chart screenshot images for vision-capable parsers. */
  inputImages?: Array<{ url: string; contentType: string }>

  /**
   * Expected output for this example.
   * Discriminated on `kind` to prevent mixing classifier and extractor examples
   * in the same array.
   */
  expected:
    | { kind: 'classification'; label: ClassificationLabel; reasoning?: string }
    | { kind: 'extraction'; targetKind: 'signal' | 'update'; data: unknown }
}

/**
 * KOL-specific hints that inform how the LLM parses this KOL's messages.
 * Everything here is data — none of it is hard-coded in parser logic.
 *
 * Updating these hints via the dashboard hot-reloads without restarting
 * the process.
 */
export interface ParsingHints {
  /**
   * Free-text description of this KOL's posting style.
   * Injected into the extractor's system prompt.
   * Example: "Posts concise structured setups. Always includes $ before
   *   symbols. TPs are in the chart image."
   */
  style: string

  /**
   * Domain-specific vocabulary mapping for this KOL's jargon.
   * Helps the LLM resolve uncommon abbreviations.
   * Example: { "CMP": "current market price", "BE": "breakeven" }
   */
  vocabulary?: Record<string, string>

  /**
   * Whether chart/screenshot images are needed for accurate extraction.
   * - 'required' → always pass images to the extractor
   * - 'optional' → pass images when present, skip when absent
   * - 'ignore'   → never pass images (text is always sufficient)
   */
  imagePolicy?: 'required' | 'optional' | 'ignore'

  /**
   * KOL-specific few-shot examples for the classifier stage.
   * Each entry must have `expected.kind === 'classification'`.
   * Merged with the shared example pool when building the classifier prompt.
   */
  classifierExamples?: FewShotExample[]

  /**
   * KOL-specific few-shot examples for the extractor stage.
   * Each entry must have `expected.kind === 'extraction'`.
   * Demonstrate the expected field values for this KOL's style.
   */
  extractorExamples?: FewShotExample[]

  /**
   * Default field values applied when the LLM leaves a field null.
   * Useful when a KOL always trades with the same leverage or contract type.
   */
  fieldDefaults?: {
    contractType?: 'perpetual' | 'spot'
    leverage?: number
    side?: 'long' | 'short'
  }
}

/**
 * Base KOL fields shared across all parsing strategies.
 * The three strategy-specific fields (parsingStrategy, parsingHints,
 * regexConfigName) are omitted here and reinstated as a discriminated union
 * in `KolConfig` below.
 */
type KolConfigBase = Omit<SharedKolConfig, 'parsingStrategy' | 'parsingHints' | 'regexConfigName'>

/**
 * Full KOL configuration as used throughout the signal pipeline.
 *
 * Discriminated on `parsingStrategy` so the TypeScript compiler enforces
 * that each strategy receives its required configuration at compile time:
 * - 'regex_structured'        → `regexConfigName` is required
 * - 'llm_text' | 'llm_vision' → `parsingHints` is required
 * - 'hybrid'                  → both `regexConfigName` and `parsingHints` are required
 *
 * A misconfigured KOL (e.g., regex strategy without a config name) is a
 * type error, not a runtime crash. Batch 4's Dispatcher relies on this
 * narrowing when selecting the correct parser implementation.
 */
export type KolConfig = KolConfigBase & (
  | {
      /**
       * Deterministic parsing for machine-generated, fixed-format messages.
       * Requires a named RegexConfig registered in the parser's config registry.
       *
       * `regexConfigName` references a named `RegexConfig` instance.
       * The `RegexConfig` type itself is defined in `parsing/regex/types.ts`
       * (created in batch 4). The `KolRegistry` does NOT validate that this
       * name resolves to an existing config — that check runs in the Dispatcher's
       * startup health check (batch 4). Batches 1–3 do not need to know about
       * `RegexConfig` existence.
       */
      parsingStrategy: 'regex_structured'
      regexConfigName: string
      parsingHints?: undefined
    }
  | {
      /**
       * LLM-based parsing for human KOLs.
       * - 'llm_text':   all signal data comes from message text
       * - 'llm_vision': key values (TPs, entry) are inside chart screenshots
       */
      parsingStrategy: 'llm_text' | 'llm_vision'
      parsingHints: ParsingHints
      regexConfigName?: undefined
    }
  | {
      /**
       * Regex-first with LLM fallback.
       * Both `regexConfigName` and `parsingHints` are required so the fallback
       * path has full context.
       */
      parsingStrategy: 'hybrid'
      regexConfigName: string
      parsingHints: ParsingHints
    }
)

/**
 * Live KOL registry.
 *
 * Loads KOL configs from disk (kols.json) and watches for file changes.
 * When the file changes, registered `onChange` handlers fire so parsers and
 * classifiers can pick up new hints without a process restart.
 *
 * All read methods are synchronous (data is kept in memory after initial load).
 */
export interface IKolRegistry {
  /**
   * Look up a KOL by Discord authorId.
   * Returns null when the KOL is unknown or disabled.
   *
   * **Immutable snapshot guarantee**: the returned reference is a snapshot of
   * the config at the moment of this call. Subsequent hot-reloads or explicit
   * config updates do NOT mutate the returned object. Code that captures this
   * reference (e.g., a `ParseContext` created at dispatch time) will always
   * see the config that was current when the context was created.
   *
   * Config updates only affect contexts created after the reload completes.
   * This prevents mid-parse LLM prompt changes that would corrupt the
   * session log's record of what prompt was actually used.
   */
  get(kolId: string): KolConfig | null

  /**
   * Return all registered KOL configs (enabled and disabled).
   *
   * Each element is an immutable snapshot — same guarantee as `get()`.
   * The array itself is a new copy each call; mutating it has no effect on
   * the registry's internal state.
   */
  list(): KolConfig[]

  /**
   * Register a callback that fires whenever a KOL's config is updated.
   * Called with the affected kolId and the new config value.
   * Supports multiple subscribers; called in registration order.
   */
  onChange(handler: (kolId: string, newConfig: KolConfig) => void): void
}
