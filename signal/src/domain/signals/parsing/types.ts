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
 * Input to the classifier stage.
 * The provider receives a pre-built prompt and returns a structured label.
 */
export interface ClassifyInput {
  bundle: MessageBundle
  kol: KolConfig
  systemPrompt: string
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
 * The `rawResponse` is stored in the session log for audit purposes.
 */
export interface ClassifyOutput {
  classification: ClassificationLabel
  /** Confidence in this classification [0, 1]. */
  confidence: number
  /** LLM's chain-of-thought reasoning. */
  reasoning: string
  rawResponse: unknown
}

/** Input to the extractor stage. */
export interface ExtractInput {
  bundle: MessageBundle
  kol: KolConfig
  targetKind: 'signal' | 'update'
  schema: ZodSchema
  /** Whether to include image attachments in the request. */
  includeImages: boolean
}

/** Output from the extractor stage before Zod validation. */
export interface ExtractOutput {
  /** Raw data returned by the LLM, before schema validation. */
  data: unknown
  confidence: number
  reasoning: string
  extractedFrom: 'text_only' | 'image_only' | 'text_and_image'
  /** Per-field confidence for price-sensitive fields. */
  priceFieldConfidence?: Record<string, 'high' | 'medium' | 'low'>
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

// ── Classifier / Extractor ───────────────────────────────────────────────────

/**
 * The classifier stage of the LLM pipeline.
 * Determines which downstream path a bundle takes without extracting fields.
 */
export interface IClassifier {
  classify(ctx: ParseContext): Promise<ClassifyOutput>
}

/** Metadata attached to every extractor result. */
export interface ExtractMeta {
  latencyMs: number
  model: string
  tokensUsed: { prompt: number; completion: number }
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
    ctx: ParseContext,
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
  | 'not_a_signal'      // Classifier judged this non-actionable (chitchat, education, etc.)
  | 'low_confidence'    // LLM confidence below the configured threshold
  | 're_entry_hint'     // Informal re-entry suggestion; informational only, no trade action
  | 'duplicate_signal'  // Content hash matches a recently parsed signal
  | 'update_no_link'    // Is a valid update but UpdateLinker could not associate it with a signal

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

// ── ParseContext ─────────────────────────────────────────────────────────────

/**
 * Everything a parser needs to produce a `ParseResult`.
 * Assembled by the dispatcher and passed to `IParser.parse()`.
 *
 * Parsers must not hold state between calls — any stateful dependencies
 * (LLM provider, session logger) are injected here per-call.
 */
export interface ParseContext {
  bundle: MessageBundle
  kol: KolConfig
  now: Date
  /** Injected for LLM-based parsers. Absent for pure regex parsers. */
  llmProvider?: ILlmProvider
  /** Injected for any parser that makes LLM calls. */
  sessionLogger?: ISessionLogger
}

// ── IParser ──────────────────────────────────────────────────────────────────

/**
 * The core parsing interface.
 *
 * Implementations: `RegexStructuredParser`, `LlmParser`, `HybridParser`.
 * All are registered in the `ParserRegistry` under their `name`.
 *
 * Implementations must be stateless — the same instance may be called
 * concurrently for multiple bundles.
 */
export interface IParser {
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
  parse(ctx: ParseContext): Promise<ParseResult>
}

// ── ParserRegistry / Dispatcher ──────────────────────────────────────────────

/**
 * Registry for `IParser` implementations.
 * Parsers are registered once at startup and looked up by name at dispatch time.
 */
export interface IParserRegistry {
  register(parser: IParser): void
  /** Throws if no parser is registered under `name`. */
  get(name: string): IParser
  list(): IParser[]
}
