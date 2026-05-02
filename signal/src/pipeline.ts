/**
 * Pipeline assembler — wires every domain module into a single
 * `handleDiscordMessage` callback for the Discord listener.
 *
 * Wiring topology:
 *   Discord listener → handleDiscordMessage
 *     → MessageStore.append (existing raw archive)
 *     → toRawMessage (RawDiscordMessage → RawMessage)
 *     → MessagePrePipeline.process
 *         (drops noise / non-create / unknown-author / duplicates)
 *     → MessageAggregator.ingest
 *         (windows messages by KOL+channel; emits MessageBundle on close)
 *     → ParserDispatcher.dispatch
 *         (routes bundle to the parser matching kol.parsingStrategy)
 *     → ResultRouter.route
 *         (persists Signal/PositionUpdate, links updates, emits events)
 *
 * Crash recovery: SignalIndexBuilder.rebuild() runs once before any
 * dispatch happens, so the in-memory open-signal index reflects whatever
 * state was on disk at the time the previous process exited.
 */

import type { RawAttachment, RawDiscordMessage, RawEmbed, RawReference } from '../../shared/types.js'
import { createEventLog, type EventLog } from './core/event-log.js'
import { loadLlmConfig } from './core/llm-config.js'
import { logger } from './core/logger.js'
import { PATHS } from './core/paths.js'
import type { MessageBundle } from './domain/signals/ingestion/aggregator/types.js'
import { MessageAggregator } from './domain/signals/ingestion/aggregator/index.js'
import { createDefaultPrePipeline } from './domain/signals/ingestion/pre-pipeline/index.js'
import type { FilterContext } from './domain/signals/ingestion/pre-pipeline/types.js'
import type { RawMessage } from './domain/signals/ingestion/types.js'
import { KolRegistry } from './domain/signals/kol/registry.js'
import { SignalIndex } from './domain/signals/linking/signal-index.js'
import { ByExternalIdStrategy } from './domain/signals/linking/strategies/by-external-id.js'
import { ByKolSymbolStrategy } from './domain/signals/linking/strategies/by-kol-symbol.js'
import { UpdateLinker } from './domain/signals/linking/update-linker.js'
import { ParserDispatcher } from './domain/signals/parsing/dispatcher.js'
import { HybridParser } from './domain/signals/parsing/llm/hybrid-parser.js'
import { LlmParser } from './domain/signals/parsing/llm/llm-parser.js'
import { OpenRouterProvider } from './domain/signals/parsing/llm/provider/openrouter-provider.js'
import { SessionLogger } from './domain/signals/parsing/llm/session-logger.js'
import { RegexConfigRegistry } from './domain/signals/parsing/regex/config-registry.js'
import { RegexStructuredParser } from './domain/signals/parsing/regex/regex-parser.js'
import { ParserRegistry } from './domain/signals/parsing/registry.js'
import type { ILlmProvider, ISessionLogger } from './domain/signals/parsing/types.js'
import { SignalIndexBuilder } from './domain/signals/persistence/signal-index-builder.js'
import { SignalStore } from './domain/signals/persistence/signal-store.js'
import { ResultRouter } from './domain/signals/routing/result-router.js'

// ── Aggregator defaults — override per-KOL via kols.json aggregatorOverrides ─

const DEFAULT_IDLE_TIMEOUT_MS = 30_000
const DEFAULT_MAX_DURATION_MS = 120_000

// ── Public surface ──────────────────────────────────────────────────────────

export interface SignalPipeline {
  /** Forward a Discord message into the parsing pipeline. */
  handleDiscordMessage(msg: RawDiscordMessage): Promise<void>

  /** Flush in-flight bundles. Call on graceful shutdown. */
  shutdown(): Promise<void>
}

export interface PipelineDeps {
  /**
   * Optional persistent raw-message archive callback. Called BEFORE the
   * pipeline runs so the source-of-truth message log captures every event,
   * even ones the pre-pipeline drops.
   */
  archiveRaw?: (msg: RawDiscordMessage) => Promise<void>
}

/**
 * Build the full ingestion → routing pipeline. Idempotent on the dependency
 * level: a second call would create a second EventLog file handle, so the
 * caller is expected to invoke this exactly once at boot time.
 */
export async function createPipeline(deps: PipelineDeps = {}): Promise<SignalPipeline> {
  // ── 1. KOL registry (must be loaded before parsers/dispatcher health-check)
  const kolRegistry = new KolRegistry()
  await kolRegistry.load()
  kolRegistry.watch()
  kolRegistry.onReloadFailed((err) => {
    logger.error({ err }, 'KolRegistry reload failed; keeping previous config')
  })

  // ── 2. Persistence layer
  const eventLog = await createEventLog({ logPath: PATHS.eventLog })
  const signalStore = new SignalStore(PATHS.signalsLog)
  const signalIndex = new SignalIndex()

  // ── 3. Crash recovery — rebuild open-signal index from disk
  const recoveryStats = await new SignalIndexBuilder(signalStore, signalIndex).rebuild()
  logger.info(
    {
      replayed: recoveryStats.replayed,
      opened: recoveryStats.opened,
      closed: recoveryStats.closed,
      openNow: signalIndex.size(),
    },
    'Pipeline: signal index recovered from disk',
  )

  // ── 4. Parser infrastructure
  const regexConfigRegistry = new RegexConfigRegistry()
  // (No regex configs are registered yet — all current KOLs use llm_text.
  //  When a bot-KOL is onboarded, register its config here, e.g.:
  //    regexConfigRegistry.register(WG_BOT_CONFIG)
  //  The dispatcher's healthCheck will then verify the registration.)

  const parserRegistry = new ParserRegistry()
  const regexParser = new RegexStructuredParser(regexConfigRegistry)
  parserRegistry.registerBase(regexParser)

  // ── 5. LLM provider — wired only when an API key is configured
  // Source priority: data/config/llm.json → env vars → empty.
  const llmConfig = await loadLlmConfig()
  let llmProvider: ILlmProvider | undefined
  let sessionLogger: ISessionLogger | undefined
  if (llmConfig.apiKey) {
    llmProvider = new OpenRouterProvider(
      llmConfig.classifyModel,
      llmConfig.extractModel,
      llmConfig.apiKey,
      llmConfig.baseUrl,
    )
    sessionLogger = new SessionLogger(PATHS.dataRoot)
    parserRegistry.registerLlm(new LlmParser('llm_text', llmConfig.confidenceThreshold))
    parserRegistry.registerLlm(new LlmParser('llm_vision', llmConfig.confidenceThreshold))
    parserRegistry.registerLlm(new HybridParser(regexParser, llmConfig.confidenceThreshold))
    logger.info(
      {
        classifyModel: llmConfig.classifyModel,
        extractModel: llmConfig.extractModel,
        baseUrl: llmConfig.baseUrl,
        confidenceThreshold: llmConfig.confidenceThreshold,
      },
      'Pipeline: OpenRouter LLM provider configured',
    )
  } else {
    logger.warn(
      'Pipeline: no LLM API key configured (set via dashboard /settings or OPENROUTER_API_KEY env). LLM strategies will fail with code=unknown until configured.',
    )
  }

  // ── 6. Dispatcher + health check
  const dispatcher = new ParserDispatcher(
    parserRegistry,
    regexConfigRegistry,
    kolRegistry,
    llmProvider,
    sessionLogger,
  )
  // Only health-check if we have the parsers a strategy requires; otherwise
  // skip so a dev-mode boot without OPENROUTER_API_KEY isn't fatal.
  if (llmProvider) {
    dispatcher.healthCheck(kolRegistry.list())
  } else {
    // Validate base parsers only (regex_structured / hybrid not registered yet;
    // we accept that LLM-strategy KOLs will produce failed results downstream).
    logger.info('Pipeline: skipping LLM health-check (no provider)')
  }

  // ── 7. Result router (linker + index + store + events)
  const linker = new UpdateLinker([
    new ByExternalIdStrategy(),
    new ByKolSymbolStrategy(),
  ])
  const router = new ResultRouter(signalStore, linker, signalIndex, eventLog)

  // ── 8. Aggregator: bundle close → dispatcher → router
  const aggregator = new MessageAggregator({
    idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
    maxDurationMs: DEFAULT_MAX_DURATION_MS,
    perKolOverrides: collectAggregatorOverrides(kolRegistry),
  })
  aggregator.onBundleClosed(async (bundle: MessageBundle) => {
    try {
      const result = await dispatcher.dispatch(bundle)
      await router.route(result)
    } catch (err) {
      logger.error(
        { err, bundleId: bundle.id, kolId: bundle.kolId },
        'Pipeline: bundle dispatch threw — routing as failed',
      )
      await router.route({
        kind: 'failed',
        error: {
          code: 'unknown',
          message: err instanceof Error ? err.message : String(err),
          retriable: false,
          cause: err,
        },
        meta: {
          parserName: 'dispatcher',
          bundleId: bundle.id,
          kolId: bundle.kolId,
          startedAt: bundle.openedAt,
          completedAt: new Date().toISOString(),
        },
      })
    }
  })

  // Hot-reload caveat: the MessageAggregator currently has no method to
  // update its per-KOL overrides at runtime, so a kols.json change touching
  // aggregatorOverrides only takes effect after a restart. We log it here
  // so operators aren't surprised; an aggregator API for runtime updates
  // can be added without touching this assembler.
  kolRegistry.onChange((kolId) => {
    logger.info(
      { kolId },
      'KolRegistry: KOL config changed (aggregator overrides apply on next restart)',
    )
  })

  // ── 9. Pre-pipeline (filters)
  const prePipeline = createDefaultPrePipeline()
  // Rolling cache of recently-seen messageIds, owned here per the
  // FilterContext contract (the duplicate filter reads, the orchestrator
  // prunes). LRU bound so the set never grows unbounded.
  const recentMessageIds = new Set<string>()
  const recentQueue: string[] = []
  const RECENT_LIMIT = 5_000
  function noteSeen(id: string): void {
    if (recentMessageIds.has(id)) return
    recentMessageIds.add(id)
    recentQueue.push(id)
    if (recentQueue.length > RECENT_LIMIT) {
      const evicted = recentQueue.shift()
      if (evicted !== undefined) recentMessageIds.delete(evicted)
    }
  }

  // ── 10. The handler exposed back to main.ts
  return {
    async handleDiscordMessage(msg: RawDiscordMessage): Promise<void> {
      try {
        if (deps.archiveRaw) await deps.archiveRaw(msg)

        const rawMessage = toRawMessage(msg)
        const ctx: FilterContext = {
          kolRegistry,
          recentMessageIds,
          now: new Date(),
        }
        const filterResult = await prePipeline.process(rawMessage, ctx)
        // Always note the message id so the next delivery of the same id is
        // caught by the DuplicateFilter — even if THIS delivery passed.
        noteSeen(rawMessage.messageId)
        if (!filterResult.pass) {
          // Filtered messages don't reach the aggregator, by design — and we
          // don't emit a parse.discarded event because the message never
          // entered the parsing pipeline.
          return
        }

        await aggregator.ingest(rawMessage)
      } catch (err) {
        logger.error(
          { err, messageId: msg.messageId, channelId: msg.channelId },
          'Pipeline: handleDiscordMessage failed',
        )
      }
    },

    async shutdown(): Promise<void> {
      logger.info('Pipeline: flushing in-flight bundles…')
      await aggregator.flushAll()
      await eventLog.close()
      kolRegistry.close()
    },
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert the listener's `RawDiscordMessage` (shared/types.ts) into the
 * ingestion-layer `RawMessage` (signal-domain). Differences:
 *   - listener has `receivedAt`, ingestion has `timestamp`
 *   - listener has `reference`, ingestion has `replyTo` (renamed + flattened)
 *   - listener never emits edits, so `eventType` is always 'create' here
 *   - attachment.contentType is required in ingestion but optional on the
 *     wire — fall back to 'application/octet-stream' so schema validation
 *     downstream doesn't fail on the rare attachment without a MIME hint.
 */
function toRawMessage(msg: RawDiscordMessage): RawMessage {
  return {
    messageId: msg.messageId,
    eventType: 'create',
    timestamp: msg.receivedAt,
    channelId: msg.channelId,
    authorId: msg.authorId,
    content: msg.content,
    embeds: msg.embeds.map(adaptEmbed),
    attachments: msg.attachments.map(adaptAttachment),
    ...(msg.reference && { replyTo: adaptReference(msg.reference) }),
  }
}

function adaptEmbed(e: RawEmbed) {
  // Embed shapes line up between the two type universes; just spread.
  return {
    fields: e.fields,
    ...(e.title !== undefined && { title: e.title }),
    ...(e.description !== undefined && { description: e.description }),
    ...(e.image !== undefined && { image: e.image }),
    ...(e.thumbnail !== undefined && { thumbnail: e.thumbnail }),
  }
}

function adaptAttachment(a: RawAttachment) {
  return {
    url: a.url,
    contentType: a.contentType ?? 'application/octet-stream',
    ...(a.name !== undefined && { name: a.name }),
    ...(a.width !== undefined && { width: a.width }),
    ...(a.height !== undefined && { height: a.height }),
  }
}

function adaptReference(r: RawReference) {
  return {
    messageId: r.messageId,
    authorId: r.authorId,
    contentSnippet: r.contentSnippet,
  }
}

/**
 * Build the per-KOL aggregator override map from the KOL registry's current
 * snapshot. Every KOL whose config carries `aggregatorOverrides` contributes
 * one entry; KOLs without overrides fall through to the global defaults.
 */
function collectAggregatorOverrides(
  kolRegistry: KolRegistry,
): Record<string, { idleTimeoutMs?: number; maxDurationMs?: number }> {
  const out: Record<string, { idleTimeoutMs?: number; maxDurationMs?: number }> = {}
  for (const k of kolRegistry.list()) {
    if (k.aggregatorOverrides) {
      out[k.id] = { ...k.aggregatorOverrides }
    }
  }
  return out
}
