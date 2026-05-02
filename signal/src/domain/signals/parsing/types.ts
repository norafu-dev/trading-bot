import type { ZodSchema } from 'zod'
import type { MessageBundle } from '../ingestion/aggregator/types.js'
import type { KolConfig } from '../kol/types.js'
import type { Signal, PositionUpdate } from '../../../../../shared/types.js'
import type { ClassificationLabel } from './common/labels.js'

// ── Session Logger ───────────────────────────────────────────────────────────

/**
 * A single LLM API call record, persisted to
 * `data/sessions/llm/{YYYY-MM-DD}/{bundleId}.jsonl`.
 *
 * Multiple calls for the same bundle (classifier + extractor) are appended to
 * the same file. This log is the gold-standard dataset for prompt iteration.
 */
export interface LlmCallRecord {
  /** ULID — unique per-call primary key. */
  recordId: string
  /** The bundle this call was processing. */
  bundleId: string
  kolId: string
  /** Which stage of the LLM pipeline produced this call. */
  phase: 'classify' | 'extract'

  model: string
  provider: 'openrouter'
  /** ISO 8601 timestamp when the call was initiated. */
  timestamp: string
  /** Total wall-clock time for the round-trip in milliseconds. */
  latencyMs: number

  request: {
    system: string
    messages: Array<{
      role: 'user' | 'assistant' | 'system'
      /** String for text-only, structured object for multimodal content. */
      content: string | unknown
    }>
    /** JSON Schema form of the Zod schema passed to generateObject, if any. */
    schema?: unknown
    temperature?: number
    maxTokens?: number
  }

  response:
    | { ok: true; data: unknown; rawCompletion: string }
    | { ok: false; errorCode: string; errorMessage: string; rawCompletion?: string }

  tokensUsed: {
    prompt: number
    completion: number
    total: number
  }

  /** Estimated cost in USD if the provider reports it. */
  costUsd?: number
}

/**
 * Append-only logger for LLM call records.
 * Writes one `LlmCallRecord` per line to the per-bundle JSONL file.
 */
export interface ISessionLogger {
  logCall(record: LlmCallRecord): Promise<void>
}

// ── LLM Provider ─────────────────────────────────────────────────────────────

/**
 * Single chat message exchanged with the LLM.
 * `content` is `string` for text-only and an array of structured parts for
 * multimodal content (e.g. text + image_url blocks).
 */
export type LlmMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string | unknown
}

/**
 * Input to the classifier stage.
 *
 * The caller (`Classifier`) pre-builds the full chat payload — `systemPrompt`
 * and `messages` — so that the same array can be both sent to the provider
 * and recorded verbatim in the session log. The provider does not rebuild
 * messages: that would let the audit log diverge from what was actually sent.
 */
export interface ClassifyInput {
  bundle: MessageBundle
  kol: KolConfig
  systemPrompt: string
  /** Pre-built chat messages (few-shots + the live bundle), in send order. */
  messages: LlmMessage[]
  fewShots: ClassifyFewShot[]
}

export interface ClassifyFewShot {
  /** Simplified text representation of the bundle's messages. */
  messageText: string
  expectedLabel: ClassificationLabel
  reasoning?: string
}

/**
 * Output from the classifier stage.
 *
 * `model` and `tokensUsed` are reported by the provider and flow back to the
 * `SessionLogger`. The provider must populate them — otherwise audit records
 * cannot be used for prompt iteration or cost analysis.
 */
export interface ClassifyOutput {
  classification: ClassificationLabel
  /** Confidence in this classification [0, 1]. */
  confidence: number
  /** LLM's chain-of-thought reasoning. */
  reasoning: string
  /** Model identifier used for this call (e.g. "google/gemini-2.5-flash"). */
  model: string
  /** Token usage reported by the provider. Zero only when truly unavailable. */
  tokensUsed: { prompt: number; completion: number }
  rawResponse: unknown
}

/**
 * Input to the extractor stage.
 *
 * Like `ClassifyInput`, the caller pre-builds `systemPrompt` and `messages`
 * so the audit log records the exact payload sent.
 */
export interface ExtractInput {
  bundle: MessageBundle
  kol: KolConfig
  targetKind: 'signal' | 'update'
  schema: ZodSchema
  systemPrompt: string
  /** Pre-built chat messages (text-only or multimodal), in send order. */
  messages: LlmMessage[]
  /**
   * Modality the caller actually included. The provider does not infer this
   * — it trusts what the caller declares so the value flows unchanged into
   * `Signal.extractedFrom` / `PositionUpdate.extractedFrom`.
   */
  extractedFrom: 'text_only' | 'image_only' | 'text_and_image'
}

/** Output from the extractor stage before Zod validation. */
export interface ExtractOutput {
  /** Raw data returned by the LLM, before schema validation. */
  data: unknown
  confidence: number
  reasoning: string
  /** Echoed back from `ExtractInput.extractedFrom` — what was actually sent. */
  extractedFrom: 'text_only' | 'image_only' | 'text_and_image'
  /** Per-field confidence for price-sensitive fields. */
  priceFieldConfidence?: Record<string, 'high' | 'medium' | 'low'>
  /** Model identifier used for this call. */
  model: string
  rawResponse: unknown
  tokensUsed: { prompt: number; completion: number }
}

/**
 * Abstract LLM provider used by the classifier and extractor.
 *
 * Two methods — not one — because classify and extract can use different
 * models (small model for classification, large/vision model for extraction).
 * The provider implementation knows which model to use for which task.
 */
export interface ILlmProvider {
  classify(input: ClassifyInput): Promise<ClassifyOutput>
  extract(input: ExtractInput): Promise<ExtractOutput>
}

// ── ParseContext ─────────────────────────────────────────────────────────────

/**
 * Minimal context required by all parsers, including pure regex parsers.
 * Assembled by the dispatcher and passed to `IParser.parse()`.
 *
 * Parsers must not hold state between calls — all dependencies are
 * injected here per-call so implementations can be stateless.
 */
export interface BaseParseContext {
  bundle: MessageBundle
  kol: KolConfig
  now: Date
}

/**
 * Context for LLM-based parsers (`llm_text`, `llm_vision`, `hybrid`).
 * Extends `BaseParseContext` with required LLM infrastructure.
 *
 * Both fields are required (not optional) because:
 * - `llmProvider`: without it, an LLM parser cannot make any API calls.
 * - `sessionLogger`: every LLM call must be logged for prompt auditability;
 *   silently skipping the log would corrupt the gold-standard training dataset.
 *
 * The dispatcher guarantees these are present before calling any LLM parser.
 * Regex parsers receive `BaseParseContext` only and never see these fields.
 */
export interface LlmParseContext extends BaseParseContext {
  llmProvider: ILlmProvider
  sessionLogger: ISessionLogger
  /**
   * Optional live-market price service. When present, the Extractor will
   * pre-fetch a price hint for the most likely symbol detected in the
   * bundle text and inject it into the system prompt so the LLM can
   * unit-normalise shorthand (KOL writes "7.67" → 76700 when BTC trades
   * in the tens of thousands).
   *
   * Optional because tests / dev boots without exchange connectivity must
   * still work; in that case the LLM extracts without the hint, exactly
   * as before Layer 2.
   */
  priceService?: import('../../../connectors/market/types.js').IPriceService
}

// ── Classifier / Extractor ───────────────────────────────────────────────────

/**
 * The classifier stage of the LLM pipeline.
 * Determines which downstream path a bundle takes without extracting fields.
 */
export interface IClassifier {
  classify(ctx: LlmParseContext): Promise<ClassifyOutput>
}

/** Metadata attached to every extractor result. */
export interface ExtractMeta {
  latencyMs: number
  model: string
  tokensUsed: { prompt: number; completion: number }
  /**
   * Modality used. Echoed from `ExtractInput.extractedFrom` (caller's claim
   * about what it actually sent). LlmParser uses this — not any LLM-self-reported
   * value — so the field reflects ground truth, not the model's introspection.
   */
  extractedFrom: 'text_only' | 'image_only' | 'text_and_image'
}

/** Typed result from the extractor, after Zod schema validation. */
export type ExtractResult<T> =
  | { ok: true; data: T; meta: ExtractMeta }
  | { ok: false; error: ParseError; meta: ExtractMeta }

/**
 * The extractor stage of the LLM pipeline.
 * Produces structured data conforming to the given Zod schema.
 */
export interface IExtractor {
  extract<T>(
    ctx: LlmParseContext,
    kind: 'signal' | 'update',
    schema: ZodSchema<T>,
  ): Promise<ExtractResult<T>>
}

// ── ParseResult ──────────────────────────────────────────────────────────────

/**
 * Why a bundle was discarded without producing a Signal or PositionUpdate.
 * Each variant is a first-class event in the system — not a silent drop.
 */
export type DiscardReason =
  | 'not_a_signal'          // Classifier judged this non-actionable (chitchat, education, etc.)
  | 'low_confidence'        // LLM confidence below the configured threshold
  | 're_entry_hint'         // Extractor returned updateType 're_entry_hint'; informational only
  | 'update_unclassifiable' // Extractor returned updateType 'other'; could not classify update
  | 'duplicate_signal'      // Content hash matches a recently parsed signal
  | 'update_no_link'        // Is a valid update but UpdateLinker could not associate it with a signal

/**
 * Structured error produced when the parser attempted to extract but failed.
 * Distinct from `discarded`: a `failed` result indicates a recoverable or
 * permanent infrastructure/logic error, not a legitimate non-signal message.
 */
export interface ParseError {
  code:
    | 'llm_timeout'
    | 'llm_invalid_output'
    | 'regex_no_match'
    | 'schema_validation'
    | 'unknown'
  message: string
  /**
   * True if retrying the same bundle might succeed (e.g., transient timeout).
   * False for permanent errors (e.g., schema mismatch, empty input).
   */
  retriable: boolean
  cause?: unknown
}

/**
 * Metadata present on every ParseResult regardless of outcome.
 * The dashboard uses this to display "how was this bundle processed?"
 */
export interface ParseMeta {
  /** Which parser implementation handled this bundle. */
  parserName: string
  bundleId: string
  kolId: string
  /** ISO 8601 — when parse() was called. */
  startedAt: string
  /** ISO 8601 — when parse() returned. */
  completedAt: string
  /** LLM call records for this parse run, if any were made. */
  llmCalls?: LlmCallRecord[]
}

/**
 * The discriminated union returned by every `IParser.parse()` call.
 *
 * The four `kind` values are exhaustive and non-negotiable:
 * - `signal`    → new trade intent, forward to risk/approval pipeline
 * - `update`    → position update, forward to UpdateLinker
 * - `discarded` → legitimate non-signal, record and stop
 * - `failed`    → parser error, alert ops, optionally retry
 *
 * `parse()` must NEVER throw for business-logic failures and must NEVER
 * return null. Only true bugs (null pointer, etc.) may propagate as exceptions.
 */
export type ParseResult =
  | { kind: 'signal'; signal: Signal; meta: ParseMeta }
  | { kind: 'update'; update: PositionUpdate; meta: ParseMeta }
  | { kind: 'discarded'; reason: DiscardReason; meta: ParseMeta }
  | { kind: 'failed'; error: ParseError; meta: ParseMeta }

// ── IParser ──────────────────────────────────────────────────────────────────

/**
 * The core parsing interface, generic over context type.
 *
 * `TCtx` defaults to `BaseParseContext` so callers that do not care about
 * the distinction can use `IParser` without a type argument.
 *
 * - `IParser<BaseParseContext>` — regex-only parsers (`regex_structured`)
 * - `IParser<LlmParseContext>`  — LLM parsers (`llm_text`, `llm_vision`, `hybrid`)
 *
 * Implementations must be stateless — the same instance may be called
 * concurrently for multiple bundles.
 */
export interface IParser<TCtx extends BaseParseContext = BaseParseContext> {
  /**
   * Parser identifier. Must match a `parsingStrategy` value in `KolConfig`.
   * Examples: 'regex_structured', 'llm_text', 'llm_vision', 'hybrid'
   */
  readonly name: string

  /**
   * Parse a bundle and return a result.
   *
   * Invariants:
   * - Never returns null or undefined.
   * - Never throws for business-logic failures.
   * - Always returns within a reasonable timeout (implementation must enforce this).
   */
  parse(ctx: TCtx): Promise<ParseResult>
}

// ── IParserRegistry ──────────────────────────────────────────────────────────

/**
 * Bucketed registry for `IParser` implementations.
 *
 * Two buckets, typed separately so the dispatcher always receives the correct
 * context type without casting:
 *
 * - **Base bucket** (`registerBase` / `getBase` / `listBase`):
 *   Regex-only parsers (`IParser<BaseParseContext>`). These parsers require only
 *   `bundle`, `kol`, and `now` — no LLM infrastructure.
 *
 * - **LLM bucket** (`registerLlm` / `getLlm` / `listLlm`):
 *   LLM parsers (`IParser<LlmParseContext>`). These parsers require the full
 *   `LlmParseContext` including `llmProvider` and `sessionLogger`.
 *   The `hybrid` parser belongs here: it needs LLM context for its fallback path.
 *
 * Rationale for separate buckets over a single registry with runtime guards:
 * The dispatcher constructs context before calling `get`, so bucket membership
 * must be known at call site. A single `get(name)` returning `IParser` would
 * force the dispatcher to cast or guard at runtime, hiding a class of bugs where
 * an LLM parser is accidentally called with only `BaseParseContext`.
 *
 * No cross-bucket enumeration is provided intentionally: the dispatcher always
 * knows which kind of parser it is constructing context for.
 */
export interface IParserRegistry {
  /** Register a regex-only parser. Throws if `name` is already registered. */
  registerBase(parser: IParser<BaseParseContext>): void

  /** Register an LLM parser. Throws if `name` is already registered. */
  registerLlm(parser: IParser<LlmParseContext>): void

  /**
   * Look up a regex-only parser by name.
   * Throws if no parser is registered under `name` in the base bucket.
   */
  getBase(name: string): IParser<BaseParseContext>

  /**
   * Look up an LLM parser by name.
   * Throws if no parser is registered under `name` in the LLM bucket.
   */
  getLlm(name: string): IParser<LlmParseContext>

  /** Return all registered regex-only parsers. */
  listBase(): IParser<BaseParseContext>[]

  /** Return all registered LLM parsers (including hybrid). */
  listLlm(): IParser<LlmParseContext>[]

  /**
   * Startup health check. Called once by `main` (or the Dispatcher constructor)
   * after all parsers are registered and before the first bundle is dispatched.
   *
   * Validates that every enabled KOL's `parsingStrategy` resolves to a
   * registered parser in the correct bucket:
   * - `regex_structured` KOLs → name must exist in the base bucket
   * - `llm_text` / `llm_vision` / `hybrid` KOLs → name must exist in the LLM bucket
   *
   * This method only checks that a parser *instance* is registered under the
   * strategy name. It does NOT validate that a `regex_structured` KOL's
   * `regexConfigName` resolves to an existing `RegexConfig` — that is
   * `RegexConfigRegistry`'s responsibility (Batch 4).
   *
   * Throws `ParserRegistryHealthCheckError` on the first failure, with the
   * error message identifying: which KOL ID, which strategy name, which bucket
   * was searched. Callers should treat this as a fatal startup error.
   */
  healthCheck(kols: ReadonlyArray<KolConfig>): void
}
