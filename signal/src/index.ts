import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { MessageStore } from './domain/signals/message-store.js'
import { DiscordListener } from './connectors/discord/listener.js'
import { createKolChannelRoutes } from './routes/kols.js'
import { createDiscordRoutes } from './routes/discord.js'
import { createMessageRoutes } from './routes/messages.js'

const PORT = Number(process.env.PORT ?? 3001)
const DISCORD_TOKEN = process.env.DISCORD_TOKEN

// ---- Bootstrap ----
const messageStore = new MessageStore()
await messageStore.init()

let listener: DiscordListener | null = null
if (DISCORD_TOKEN) {
  listener = new DiscordListener({
    token: DISCORD_TOKEN,
    onMessage: async (msg) => {
      await messageStore.append(msg)
    },
  })
  void listener.start()
} else {
  console.warn('[Signal] DISCORD_TOKEN not set — Discord listener disabled')
}

// ---- App ----
const app = new Hono()
app.use('*', cors())

app.route('/api', createKolChannelRoutes(listener))
app.route('/api/discord', createDiscordRoutes(listener, messageStore))
app.route('/api/messages', createMessageRoutes(messageStore))

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[Signal] Server running on http://localhost:${info.port}`)
})
