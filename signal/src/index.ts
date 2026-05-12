import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { MessageStore } from './domain/signals/message-store.js'
import { DiscordListener } from './connectors/discord/listener.js'
import { createKolChannelRoutes } from './routes/kols.js'
import { createDiscordRoutes } from './routes/discord.js'
import { createMessageRoutes } from './routes/messages.js'
import { createTradingConfigRoutes } from './routes/trading-config.js'
import { createTradingRoutes } from './routes/trading.js'
import { createSignalRoutes } from './routes/signals.js'
import { createEventRoutes } from './routes/events.js'
import { createLlmConfigRoutes } from './routes/llm-config.js'
import { createPipelineRoutes } from './routes/pipeline.js'
import { createMarketRoutes } from './routes/market.js'
import { createOperationsRoutes } from './routes/operations.js'
import { createRiskConfigRoutes } from './routes/risk-config.js'
import { createTelegramConfigRoutes } from './routes/telegram-config.js'
import { createExecutionConfigRoutes } from './routes/execution-config.js'
import { CcxtPriceService } from './connectors/market/price-service.js'
import { ImageFetcher } from './connectors/discord/image-fetcher.js'
import { createPipeline } from './pipeline.js'
import { logger } from './core/logger.js'

const PORT = Number(process.env.PORT ?? 3001)
const DISCORD_TOKEN = process.env.DISCORD_TOKEN

// ---- Bootstrap ----
const messageStore = new MessageStore()
await messageStore.init()

// Public-API price service — no auth, used by the price-check sanity layer
// (catch laypress unit anomalies / stale signal points) and by the dashboard
// /api/market/price route.
const priceService = new CcxtPriceService({ exchangeName: 'binance' })

// Image fetcher — pulls Discord CDN images into base64 data URLs so the
// vision LLM doesn't see Discord's IP-blocked URL. Also auto-refreshes
// expired Discord URLs via the official attachment refresh endpoint
// (passing the selfbot token). Without the token, stale URLs simply fail.
const imageFetcher = new ImageFetcher({ discordToken: DISCORD_TOKEN })

// Compose the entire ingestion → parsing → routing pipeline. Crash recovery
// (SignalIndexBuilder.rebuild) runs inside createPipeline before any dispatch
// can happen.
const pipeline = await createPipeline({ priceService, imageFetcher })

let listener: DiscordListener | null = null
if (DISCORD_TOKEN) {
  listener = new DiscordListener({
    token: DISCORD_TOKEN,
    onMessage: async (msg) => {
      // Archive every raw message first so the source-of-truth log captures
      // even pre-pipeline-dropped events. Note: the dev-tool inject route
      // bypasses this on purpose — replaying a historical message must NOT
      // append a duplicate to messages.jsonl.
      await messageStore.append(msg)
      await pipeline.handleDiscordMessage(msg)
    },
  })
  void listener.start()
} else {
  logger.warn('DISCORD_TOKEN not set — Discord listener disabled (pipeline still ready for direct dispatch)')
}

// Graceful shutdown: flush any open MessageBundle windows before exiting so
// we don't lose messages that haven't yet hit the parser.
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutdown signal received — flushing pipeline')
  await pipeline.shutdown()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

// ---- App ----
const app = new Hono()
app.use('*', cors())

app.route('/api', createKolChannelRoutes(listener))
app.route('/api/discord', createDiscordRoutes(listener, messageStore))
app.route('/api/messages', createMessageRoutes(messageStore, DISCORD_TOKEN))
app.route('/api/trading/config', createTradingConfigRoutes())
app.route('/api/trading', createTradingRoutes())
app.route('/api/signals', createSignalRoutes())
app.route('/api/events', createEventRoutes())
app.route('/api/config/llm', createLlmConfigRoutes())
app.route('/api/pipeline', createPipelineRoutes(pipeline, messageStore))
app.route('/api/market', createMarketRoutes(priceService))
app.route('/api/operations', createOperationsRoutes(pipeline.operationStore, pipeline.approvalService, pipeline.eventLog, pipeline.resubmitService))
app.route('/api/config/risk', createRiskConfigRoutes())
app.route('/api/config/telegram', createTelegramConfigRoutes())
app.route('/api/config/execution', createExecutionConfigRoutes())

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[Signal] Server running on http://localhost:${info.port}`)
})
