import type { RawMessage } from '../../ingestion/types.js'

/**
 * Flattens a `RawMessage`'s `content` and `embeds` into a single plain-text
 * string suitable for LLM input.
 *
 * This type alias is the shared contract for all message-flattening logic in
 * the parsing pipeline. The implementation lives in Batch 5 (LLM infrastructure
 * / prompt-builder). Every parser, classifier, and extractor that needs a text
 * representation of a message MUST depend on this type rather than inlining
 * its own derivation — avoiding subtle inconsistencies between pipeline stages.
 *
 * Specified behaviour of the implementation (enforced in Batch 5):
 * - If `content` is non-empty, include it first.
 * - For each embed: include `title` (if present), `description` (if present),
 *   and all `fields` as "name: value" lines.
 * - Join sections with newlines; trim trailing whitespace.
 * - Never throws; returns an empty string for a fully empty message.
 */
export type FlattenMessageContent = (message: RawMessage) => string
