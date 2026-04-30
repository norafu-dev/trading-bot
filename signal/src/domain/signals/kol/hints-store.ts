/**
 * FewShotExample deserialization helpers.
 *
 * TODO(B5): Implement when the prompt-builder (Batch 5) needs to load
 * and transform FewShotExample arrays from KolConfig.parsingHints into
 * prompt-ready structures.
 *
 * Current state: KolRegistry validates FewShotExample arrays at load time
 * via `fewShotExampleSchema` in `kol/schema.ts`. No additional
 * deserialization is required before Batch 5.
 *
 * When implemented, this module will:
 * - Convert `inputImages` URLs to base64 for LLM API payloads
 * - Filter examples by `expected.kind` ('classification' vs 'extraction')
 * - Merge KOL-specific examples with the shared example pool
 */
