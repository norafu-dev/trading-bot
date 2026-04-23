import { Hono } from 'hono'
import ccxt from 'ccxt'
import { z } from 'zod'
import type {
  BrokerConfigField,
  BrokerTypeInfo,
  TradingAccountConfig,
} from '../../../shared/types.js'
import {
  readTradingAccountsConfig,
  writeTradingAccountsConfig,
  tradingAccountConfigSchema,
} from '../domain/trading/config-store.js'

const CCXT_CREDENTIAL_LABELS: Record<string, {
  label: string
  type: BrokerConfigField['type']
  sensitive: boolean
  placeholder?: string
}> = {
  apiKey: { label: 'API Key', type: 'password', sensitive: true },
  secret: { label: 'API Secret', type: 'password', sensitive: true },
  uid: { label: 'User ID', type: 'text', sensitive: false },
  accountId: { label: 'Account ID', type: 'text', sensitive: false },
  login: { label: 'Login', type: 'text', sensitive: false },
  password: {
    label: 'Passphrase',
    type: 'password',
    sensitive: true,
  },
  twofa: { label: '2FA Secret', type: 'password', sensitive: true },
  privateKey: {
    label: 'Private Key',
    type: 'password',
    sensitive: true,
  },
  walletAddress: {
    label: 'Wallet Address',
    type: 'text',
    sensitive: false,
  },
  token: { label: 'Token', type: 'password', sensitive: true },
}

const sensitivePattern = /key|secret|password|token/i

function mask(value: string): string {
  if (value.length <= 4) return '****'
  return `****${value.slice(-4)}`
}

function maskSecrets<T extends Record<string, unknown>>(input: T): T {
  const out = { ...input }
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'string' && v.length > 0 && sensitivePattern.test(k)) {
      ;(out as Record<string, unknown>)[k] = mask(v)
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      ;(out as Record<string, unknown>)[k] = maskSecrets(v as Record<string, unknown>)
    }
  }
  return out
}

function unmaskSecrets(
  body: Record<string, unknown>,
  existing: Record<string, unknown>,
): void {
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === 'string' && v.startsWith('****') && typeof existing[k] === 'string') {
      body[k] = existing[k]
    } else if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      existing[k] &&
      typeof existing[k] === 'object'
    ) {
      unmaskSecrets(v as Record<string, unknown>, existing[k] as Record<string, unknown>)
    }
  }
}

const BROKER_TYPES: BrokerTypeInfo[] = [{
  type: 'ccxt',
  name: 'CCXT (Crypto)',
  description: 'Unified API for crypto exchanges like Binance, Bybit, OKX, Hyperliquid, etc.',
  badge: 'CC',
  badgeColor: 'text-accent',
  fields: [
    { name: 'exchange', type: 'select', label: 'Exchange', required: true, options: [] },
    { name: 'sandbox', type: 'boolean', label: 'Sandbox Mode', default: false },
    { name: 'demoTrading', type: 'boolean', label: 'Demo Trading', default: false },
  ],
  guardCategory: 'crypto',
}]

const testConnectionSchema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  type: z.literal('ccxt'),
  enabled: z.boolean().default(true),
  guards: z.array(z.object({
    type: z.string(),
    options: z.record(z.string(), z.unknown()).default({}),
  })).default([]),
  brokerConfig: z.record(z.string(), z.unknown()),
})

type CcxtExchangeCtor = new (
  params?: Record<string, unknown>,
) => {
  requiredCredentials?: Record<string, boolean>
  checkRequiredCredentials: () => void
  setSandboxMode: (enabled: boolean) => void
  enableDemoTrading?: (enabled: boolean) => void
  loadMarkets: () => Promise<unknown>
  fetchBalance: () => Promise<unknown>
  close?: () => Promise<void>
}

export function createTradingConfigRoutes() {
  return new Hono()
    .get('/broker-types', (c) => c.json({ brokerTypes: BROKER_TYPES }))
    .get('/ccxt/exchanges', (c) => {
      const exchanges = (ccxt as unknown as { exchanges?: string[] }).exchanges ?? []
      return c.json({ exchanges })
    })
    .get('/ccxt/exchanges/:name/credentials', (c) => {
      const name = c.req.param('name')
      const exchanges = ccxt as unknown as Record<string, CcxtExchangeCtor>
      const ExchangeClass = exchanges[name]
      if (!ExchangeClass) return c.json({ error: `Unknown exchange: ${name}` }, 404)

      try {
        const inst = new ExchangeClass()
        const required = inst.requiredCredentials ?? {}
        const fields: BrokerConfigField[] = []
        for (const [key, needed] of Object.entries(required)) {
          if (!needed) continue
          const meta = CCXT_CREDENTIAL_LABELS[key]
          if (!meta) continue
          fields.push({
            name: key,
            type: meta.type,
            label: meta.label,
            required: true,
            sensitive: meta.sensitive,
            placeholder: meta.placeholder,
          })
        }
        return c.json({ fields })
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
      }
    })
    .get('/', async (c) => {
      try {
        const accounts = await readTradingAccountsConfig()
        return c.json({ accounts: accounts.map((acc) => maskSecrets({ ...acc })) })
      } catch (err) {
        return c.json({ error: String(err) }, 500)
      }
    })
    .put('/accounts/:id', async (c) => {
      try {
        const id = c.req.param('id')
        const body = await c.req.json()
        if (typeof body !== 'object' || !body) {
          return c.json({ error: 'Invalid body' }, 400)
        }
        if ((body as Record<string, unknown>).id !== id) {
          return c.json({ error: 'Body id must match URL id' }, 400)
        }

        const mutable = { ...(body as Record<string, unknown>) }
        const accounts = await readTradingAccountsConfig()
        const existing = accounts.find((a) => a.id === id)
        if (existing) {
          unmaskSecrets(mutable, existing as unknown as Record<string, unknown>)
        }

        const validated = tradingAccountConfigSchema.parse(mutable) as TradingAccountConfig
        const idx = accounts.findIndex((a) => a.id === id)
        if (idx >= 0) accounts[idx] = validated
        else accounts.push(validated)

        await writeTradingAccountsConfig(accounts)
        return c.json(validated)
      } catch (err) {
        if (err instanceof z.ZodError) {
          return c.json({ error: 'Validation failed', details: err.flatten() }, 400)
        }
        return c.json({ error: String(err) }, 500)
      }
    })
    .delete('/accounts/:id', async (c) => {
      try {
        const id = c.req.param('id')
        const accounts = await readTradingAccountsConfig()
        const filtered = accounts.filter((a) => a.id !== id)
        if (filtered.length === accounts.length) {
          return c.json({ error: `Account "${id}" not found` }, 404)
        }
        await writeTradingAccountsConfig(filtered)
        return c.json({ success: true })
      } catch (err) {
        return c.json({ error: String(err) }, 500)
      }
    })
    .post('/test-connection', async (c) => {
      let exchange: {
        close?: () => Promise<void>
      } | null = null
      try {
        const body = await c.req.json()
        const mutable = { ...(body as Record<string, unknown>) }
        const maybeId = typeof mutable.id === 'string' ? mutable.id : undefined
        if (maybeId) {
          const accounts = await readTradingAccountsConfig()
          const existing = accounts.find((a) => a.id === maybeId)
          if (existing) {
            unmaskSecrets(mutable, existing as unknown as Record<string, unknown>)
          }
        }

        const parsed = testConnectionSchema.parse({
          ...mutable,
          id: maybeId ?? '__test__',
        })

        const brokerConfig = parsed.brokerConfig
        const exchangeName = brokerConfig.exchange
        if (typeof exchangeName !== 'string' || !exchangeName) {
          return c.json({ success: false, error: 'brokerConfig.exchange is required' }, 400)
        }

        const exchanges = ccxt as unknown as Record<string, CcxtExchangeCtor>
        const ExchangeClass = exchanges[exchangeName]
        if (!ExchangeClass) {
          return c.json({ success: false, error: `Unknown exchange: ${exchangeName}` }, 400)
        }

        const credentials: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(brokerConfig)) {
          if (k === 'exchange' || k === 'sandbox' || k === 'demoTrading') continue
          if (v !== undefined) credentials[k] = v
        }
        if (brokerConfig.options && typeof brokerConfig.options === 'object') {
          credentials.options = brokerConfig.options
        }
        if (exchangeName === 'bitget') {
          const options =
            credentials.options && typeof credentials.options === 'object'
              ? { ...(credentials.options as Record<string, unknown>) }
              : {}
          if (options.defaultType === undefined) {
            options.defaultType = 'swap'
          }
          credentials.options = options
        }

        const instance = new ExchangeClass(credentials)
        exchange = instance

        if (brokerConfig.sandbox === true) {
          instance.setSandboxMode(true)
        }
        if (brokerConfig.demoTrading === true && typeof instance.enableDemoTrading === 'function') {
          instance.enableDemoTrading(true)
        }

        instance.checkRequiredCredentials()
        await instance.loadMarkets()
        const account = await instance.fetchBalance()
        return c.json({ success: true, account })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return c.json({ success: false, error: msg }, 400)
      } finally {
        try {
          await exchange?.close?.()
        } catch {
          // best effort
        }
      }
    })
}
