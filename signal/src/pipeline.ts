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
import { computePriceCheck } from './domain/signals/price-check.js'
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
import { BTC_STAR_CONFIG } from './domain/signals/parsing/regex/configs/btc-star.js'
import { RegexStructuredParser } from './domain/signals/parsing/regex/regex-parser.js'
import { ParserRegistry } from './domain/signals/parsing/registry.js'
import type { ILlmProvider, ISessionLogger } from './domain/signals/parsing/types.js'
import { SignalIndexBuilder } from './domain/signals/persistence/signal-index-builder.js'
import { SignalStore } from './domain/signals/persistence/signal-store.js'
import { ResultRouter } from './domain/signals/routing/result-router.js'
import { CopyTradingEngine } from './domain/copy-trading/engine.js'
import type { IOperationStore } from './domain/copy-trading/operation-store.js'
import { OperationStore } from './domain/copy-trading/operation-store.js'
import { ApprovalService } from './domain/copy-trading/approval/approval-service.js'
import { ApprovalTimeouts } from './domain/copy-trading/approval/approval-timeouts.js'
import { BrokerDispatcher } from './domain/copy-trading/execution/broker-dispatcher.js'
import { CcxtCryptoBroker } from './domain/copy-trading/execution/crypto-broker.js'
import { OrderExecutor } from './domain/copy-trading/execution/order-executor.js'
import { loadExecutionConfig } from './core/execution-config.js'
import { createCcxtInstance } from './domain/trading/ccxt-pool.js'
import { loadTelegramConfig } from './core/telegram-config.js'
import { TelegramClient } from './connectors/telegram/client.js'
import { TelegramNotifier } from './connectors/telegram/notifier.js'
import { TelegramListener } from './connectors/telegram/listener.js'
import { SnapshotService } from './domain/copy-trading/snapshot-service.js'
import { DEFAULT_GUARD_CONFIGS, resolveGuards } from './domain/copy-trading/guards/registry.js'
import { readTradingAccountsConfig } from './domain/trading/config-store.js'

// ── Aggregator defaults — override per-KOL via kols.json aggregatorOverrides ─
//
// Tuned from a 30-day analysis of three monitored channels (Apr–May 2026):
//   - 95th-percentile intra-cluster gap across "real signal" clusters was
//     ~75s for the most multi-message KOL (image + caption + zh translation).
//   - 60s catches 94% of those signals as one bundle while keeping the
//     dispatch latency budget under a minute.
// Per-KOL overrides via KolConfig.aggregatorOverrides stretch this for
// slow writers (Trader Cash style: reply + edit, p95 ≈ 270s).
const DEFAULT_IDLE_TIMEOUT_MS = 60_000
const DEFAULT_MAX_DURATION_MS = 240_000

// ── Public surface ──────────────────────────────────────────────────────────

export interface SignalPipeline {
  /** Forward a Discord message into the parsing pipeline. */
  handleDiscordMessage(msg: RawDiscordMessage): Promise<void>

  /**
   * Force-close every open aggregator window immediately, dispatching their
   * bundles through the parser → router chain. Used by the "replay this
   * message" dev tool so the operator doesn't have to wait the full
   * idleTimeoutMs to see results. Returns when all dispatches finish.
   *
   * Unlike shutdown(), this leaves the EventLog handle and KolRegistry
   * watcher running — the pipeline keeps accepting new messages.
   */
  flush(): Promise<void>

  /** Flush in-flight bundles AND release all resources. SIGINT/SIGTERM only. */
  shutdown(): Promise<void>

  /**
   * The single OperationStore instance — exposed so HTTP routes can read /
   * append status-changes against the same backing file the engine writes.
   */
  operationStore: IOperationStore

  /**
   * The single EventLog handle — exposed so HTTP routes can emit
   * `operation.status-changed` etc. through the same dual-write log the
   * pipeline uses.
   */
  eventLog: EventLog

  /**
   * Shared status-transition service. Wired into HTTP routes so the
   * dashboard PUT and the Telegram callback both push transitions through
   * one validation + persistence path.
   */
  approvalService: ApprovalService
}

/**
 * Optional collaborators wired in by main.ts.
 *
 * - `priceService`: live-market quote source. Used to compute
 *   `Signal.priceCheck` (live-market sanity layer) AND to inject a
 *   price hint into the extractor system prompt for unit normalisation.
 * - `imageFetcher`: downloads Discord CDN images and feeds them to the
 *   LLM as `data:` URLs. Discord blocks LLM-provider IPs, so vision
 *   without this is broken.
 *
 * Both are optional — dev boots without exchange / network access still
 * need to function. Their absence degrades silently: no price-check, no
 * vision support, but the rest of the pipeline runs as before.
 */
export interface PipelineDeps {
  priceService?: import('./connectors/market/types.js').IPriceService
  imageFetcher?: import('./connectors/discord/image-fetcher.js').IImageFetcher
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
  // Bot-format KOL configs. Each one corresponds to a single channel run
  // by a specific bot (chain-tracker, bridge translator, etc). Add new
  // ones here and the dispatcher's healthCheck will verify the matching
  // KOL exists with parsingStrategy='regex_structured' and regexConfigName.
  regexConfigRegistry.register(BTC_STAR_CONFIG)

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
    deps.priceService,
    deps.imageFetcher,
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

  // ── 7. Copy-trading engine (sizer + guards + operation store + snapshot)
  // Wired BEFORE the router so the router can hold a reference to the
  // engine's `process` method as its copy-trading hook.
  const operationStore = new OperationStore(PATHS.operationsLog)
  const snapshotService = new SnapshotService(readTradingAccountsConfig)
  snapshotService.start()

  const guards = resolveGuards(DEFAULT_GUARD_CONFIGS)
  const engine = new CopyTradingEngine({
    listAccounts: readTradingAccountsConfig,
    snapshots: snapshotService,
    store: operationStore,
    events: eventLog,
    guards,
    guardStateFile: PATHS.guardStateFile,
  })
  await engine.loadGuardState()
  logger.info(
    { guards: guards.map((g) => g.name) },
    'Pipeline: copy-trading engine ready',
  )

  // ── 7b. Approval service — shared by routes, telegram, and timeouts
  const approvalService = new ApprovalService(operationStore, eventLog)

  // ── 7c. Telegram approval surface — best-effort. If config is missing
  // or the bot can't be reached, the rest of the pipeline still runs and
  // the dashboard remains the only approval surface.
  const telegramConfig = await loadTelegramConfig()
  let telegramNotifier: TelegramNotifier | null = null
  let telegramListener: TelegramListener | null = null
  if (telegramConfig.enabled && telegramConfig.botToken && telegramConfig.chatId !== 0) {
    const tgClient = new TelegramClient({ botToken: telegramConfig.botToken })
    telegramNotifier = new TelegramNotifier({
      client: tgClient,
      chatId: telegramConfig.chatId,
      events: eventLog,
      store: operationStore,
      kolRegistry,
      ...(deps.priceService && { priceService: deps.priceService }),
    })
    telegramListener = new TelegramListener({
      client: tgClient,
      chatId: telegramConfig.chatId,
      approvals: approvalService,
    })
    await telegramNotifier.start()
    await telegramListener.start()
    logger.info(
      { chatId: telegramConfig.chatId, timeoutSeconds: telegramConfig.approvalTimeoutSeconds },
      'Pipeline: Telegram approval surface enabled',
    )
  } else {
    logger.warn(
      'Pipeline: Telegram approval surface disabled (missing token/chatId or enabled=false). Dashboard remains the sole approval surface.',
    )
  }

  // ── 7d. Auto-reject pending operations after approvalTimeoutSeconds
  // Runs even when Telegram is off — the timeout is a business rule, not
  // a connector concern.
  const approvalTimeouts = new ApprovalTimeouts({
    store: operationStore,
    events: eventLog,
    approvals: approvalService,
    timeoutSeconds: telegramConfig.approvalTimeoutSeconds,
  })
  await approvalTimeouts.start()

  // ── 7e. Broker dispatcher — turns approved operations into broker
  // orders. Reads ExecutionConfig per operation, so dashboard flips of
  // dry-run ↔ live take effect immediately. We instantiate the broker
  // lazily against the first enabled CCXT account at execute time
  // (rather than at boot) so a config change to accounts.json doesn't
  // require a restart.
  const accounts0 = await readTradingAccountsConfig()
  const ccxtAccount = accounts0.find((a) => a.enabled && a.type === 'ccxt')
  let brokerDispatcher: BrokerDispatcher | null = null
  if (ccxtAccount) {
    const exchange = createCcxtInstance(ccxtAccount)
    const broker = new CcxtCryptoBroker(exchange)
    const executor = new OrderExecutor({
      broker,
      loadExecutionConfig,
    })
    brokerDispatcher = new BrokerDispatcher({
      store: operationStore,
      events: eventLog,
      approvals: approvalService,
      executor,
    })
    brokerDispatcher.start()
    const cfg = await loadExecutionConfig()
    logger.info(
      { mode: cfg.mode, account: ccxtAccount.id, exchange: ccxtAccount.brokerConfig.exchange },
      `Pipeline: broker dispatcher ready (${cfg.mode === 'live' ? 'LIVE TRADING' : 'dry-run'})`,
    )
  } else {
    logger.warn(
      'Pipeline: no enabled CCXT account — broker dispatcher disabled. Approved operations will sit in `approved` state forever.',
    )
  }

  // ── 8. Result router (linker + index + store + events + copy-trading hook)
  const linker = new UpdateLinker([
    new ByExternalIdStrategy(),
    new ByKolSymbolStrategy(),
  ])
  const router = new ResultRouter(signalStore, linker, signalIndex, eventLog, async (signal) => {
    const kol = kolRegistry.get(signal.kolId)
    if (!kol) return  // shouldn't happen — author filter ran before — but be safe
    await engine.process(signal, kol)
  })

  // ── 9. Aggregator: bundle close → dispatcher → router
  const aggregator = new MessageAggregator({
    idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
    maxDurationMs: DEFAULT_MAX_DURATION_MS,
    perKolOverrides: collectAggregatorOverrides(kolRegistry),
  })
  aggregator.onBundleClosed(async (bundle: MessageBundle) => {
    try {
      const result = await dispatcher.dispatch(bundle)
      // Attach a live-market price check before routing. We only do this
      // for `signal` results — `update` records and discards/failures don't
      // need the check (updates inherit context from their linked signal).
      if (result.kind === 'signal' && deps.priceService) {
        try {
          const check = await computePriceCheck(result.signal, deps.priceService)
          if (check) result.signal.priceCheck = check
        } catch (err) {
          // Price-check failures must NEVER block a signal — log and move on.
          logger.warn(
            { err, signalId: result.signal.id, symbol: result.signal.symbol },
            'Pipeline: priceCheck threw; routing signal without it',
          )
        }
      }
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

  // Hot-reload aggregator overrides on every kols.json change. The aggregator
  // reads its perKolOverrides map every time it opens a window, so the very
  // next message after a save uses the new value — no restart needed.
  // Already-open windows keep their existing timers; that's fine because the
  // window the operator just edited is unlikely to be open at the moment of
  // the edit.
  kolRegistry.onChange((kolId) => {
    aggregator.updatePerKolOverrides(collectAggregatorOverrides(kolRegistry))
    logger.info(
      { kolId },
      'KolRegistry: KOL config changed — aggregator overrides hot-reloaded',
    )
  })

  // ── 10. Pre-pipeline (filters)
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

  // ── 11. The handler exposed back to main.ts
  return {
    async handleDiscordMessage(msg: RawDiscordMessage): Promise<void> {
      try {
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

    async flush(): Promise<void> {
      logger.info('Pipeline: forced flush requested')
      await aggregator.flushAll()
    },

    async shutdown(): Promise<void> {
      logger.info('Pipeline: flushing in-flight bundles…')
      await aggregator.flushAll()
      if (brokerDispatcher) brokerDispatcher.stop()
      await approvalTimeouts.stop()
      if (telegramListener) await telegramListener.stop()
      if (telegramNotifier) await telegramNotifier.stop()
      await snapshotService.stop()
      await eventLog.close()
      kolRegistry.close()
    },

    operationStore,
    eventLog,
    approvalService,
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
