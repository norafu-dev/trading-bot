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
import { createPipeline } from './pipeline.js'
import { logger } from './core/logger.js'

const PORT = Number(process.env.PORT ?? 3001)
const DISCORD_TOKEN = process.env.DISCORD_TOKEN

// ---- Bootstrap ----
const messageStore = new MessageStore()
await messageStore.init()

// Compose the entire ingestion → parsing → routing pipeline. archiveRaw is
// wired to the existing MessageStore so the source-of-truth raw message log
// is unchanged from before Batch 7. Crash recovery (SignalIndexBuilder.rebuild)
// runs inside createPipeline before any dispatch can happen.
const pipeline = await createPipeline({
  archiveRaw: (msg) => messageStore.append(msg),
})

let listener: DiscordListener | null = null
if (DISCORD_TOKEN) {
  listener = new DiscordListener({
    token: DISCORD_TOKEN,
    onMessage: pipeline.handleDiscordMessage,
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

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[Signal] Server running on http://localhost:${info.port}`)
})
