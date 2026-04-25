/**
 * Public API surface of the signals domain module.
 *
 * External callers (routes, copy-trading engine, event bus) should import
 * from this file rather than reaching into subdirectories. Internal modules
 * within the signals domain import directly from their sibling files.
 */

// ── Ingestion layer ──────────────────────────────────────────────────────────
export type { Attachment, RawMessage, IRawMessageStore } from './ingestion/types.js'
export { attachmentSchema, rawEmbedSchema, rawMessageSchema } from './ingestion/types.js'

export type {
  AggregatorConfig,
  BundleCloseReason,
  MessageBundle,
  IMessageAggregator,
} from './ingestion/aggregator/types.js'

export type {
  FilterContext,
  FilterDropReason,
  FilterResult,
  IMessageFilter,
  IMessagePrePipeline,
} from './ingestion/pre-pipeline/types.js'

// ── KOL registry ─────────────────────────────────────────────────────────────
export type {
  ParserType,
  ParsingHints,
  FewShotExample,
  KolConfig,
  IKolRegistry,
} from './kol/types.js'
export { kolConfigSchema } from './kol/schema.js'
export type { KolConfigSchema } from './kol/schema.js'

// ── Parsing layer ─────────────────────────────────────────────────────────────
export type { ClassificationLabel } from './parsing/common/labels.js'
export type { FlattenMessageContent } from './parsing/common/message-content.js'

export { signalExtractSchema } from './parsing/common/signal-schema.js'
export type { SignalExtract } from './parsing/common/signal-schema.js'

export { positionUpdateExtractSchema, updateTypeSchema } from './parsing/common/update-schema.js'
export type { PositionUpdateExtract, UpdateType } from './parsing/common/update-schema.js'

export type {
  LlmCallRecord,
  ISessionLogger,
  ClassifyInput,
  ClassifyFewShot,
  ClassifyOutput,
  ExtractInput,
  ExtractOutput,
  ILlmProvider,
  IClassifier,
  ExtractMeta,
  ExtractResult,
  IExtractor,
  DiscardReason,
  ParseError,
  ParseMeta,
  ParseResult,
  ParseContext,
  IParser,
  IParserRegistry,
} from './parsing/types.js'

// ── Linking layer ─────────────────────────────────────────────────────────────
export type { LinkStrategy, LinkResult, ILinkStrategy, ISignalIndex } from './linking/types.js'
