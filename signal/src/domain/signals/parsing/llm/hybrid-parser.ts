import type {
  IParser,
  LlmParseContext,
  ParseResult,
} from '../types.js'
import type { RegexStructuredParser } from '../regex/regex-parser.js'
import { LlmParser } from './llm-parser.js'

/**
 * Hybrid parser: tries regex first, falls back to LLM when regex cannot
 * produce a definitive result.
 *
 * Fallback rules:
 *   regex returns signal | update             → return as-is (fast path)
 *   regex returns failed(regex_no_match)      → try LLM
 *   regex returns discarded(update_unclassifiable) → try LLM
 *   regex returns failed(unknown)             → return error (config problem, LLM cannot help)
 *   regex returns discarded(other reason)     → return discard (e.g. duplicate, re_entry_hint)
 */
export class HybridParser implements IParser<LlmParseContext> {
  readonly name = 'hybrid'
  private readonly llmParser: LlmParser

  constructor(
    private readonly regexParser: RegexStructuredParser,
    confidenceThreshold?: number,
  ) {
    this.llmParser = new LlmParser('llm_text', confidenceThreshold)
  }

  async parse(ctx: LlmParseContext): Promise<ParseResult> {
    const regexResult = await this.regexParser.parse(ctx)

    // Fast path: regex produced a definitive result
    if (regexResult.kind === 'signal' || regexResult.kind === 'update') {
      return regexResult
    }

    // Config error — LLM cannot recover from a missing/misconfigured RegexConfig
    if (
      regexResult.kind === 'failed' &&
      regexResult.error.code === 'unknown'
    ) {
      return regexResult
    }

    // Discard reasons other than update_unclassifiable are final
    if (
      regexResult.kind === 'discarded' &&
      regexResult.reason !== 'update_unclassifiable'
    ) {
      return regexResult
    }

    // Fallback to LLM for regex_no_match or update_unclassifiable
    return this.llmParser.parse(ctx)
  }
}
