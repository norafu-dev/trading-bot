import { Hono } from 'hono'
import { readTradingAccountsConfig } from '../domain/trading/config-store.js'
import { createCcxtInstance, type CcxtInstance } from '../domain/trading/ccxt-pool.js'
import type { AccountBalance, TradePosition } from '../../../shared/types.js'

export function createTradingRoutes() {
  return new Hono()

    /** List all enabled accounts (without sensitive credentials). */
    .get('/accounts', async (c) => {
      try {
        const accounts = await readTradingAccountsConfig()
        return c.json({
          accounts: accounts
            .filter((a) => a.enabled)
            .map((a) => ({
              id: a.id,
              label: a.label ?? a.id,
              type: a.type,
              exchange:
                typeof a.brokerConfig.exchange === 'string' ? a.brokerConfig.exchange : null,
            })),
        })
      } catch (err) {
        return c.json({ error: String(err) }, 500)
      }
    })

    /** Fetch account balance from the exchange. */
    .get('/accounts/:id/balance', async (c) => {
      const id = c.req.param('id')
      let inst: { close?: () => Promise<void> } | null = null
      try {
        const accounts = await readTradingAccountsConfig()
        const account = accounts.find((a) => a.id === id)
        if (!account) return c.json({ error: `Account "${id}" not found` }, 404)
        if (!account.enabled) return c.json({ error: `Account "${id}" is disabled` }, 400)

        inst = createCcxtInstance(account)
        const exchange = inst as Awaited<ReturnType<typeof createCcxtInstance>>

        await exchange.loadMarkets()
        const raw = (await exchange.fetchBalance()) as Record<string, Record<string, unknown>>

        const free = parseFloat(String(raw.free?.USDT ?? raw.free?.USD ?? 0))
        const used = parseFloat(String(raw.used?.USDT ?? raw.used?.USD ?? 0))
        const total = parseFloat(String(raw.total?.USDT ?? raw.total?.USD ?? 0))
        const baseCurrency = raw.free?.USDT !== undefined ? 'USDT' : 'USD'

        const balance: AccountBalance = {
          accountId: id,
          baseCurrency,
          netLiquidation: String(total),
          totalCashValue: String(free),
          unrealizedPnl: '0',
          realizedPnl: '0',
          initMarginReq: String(used),
          fetchedAt: new Date().toISOString(),
        }
        return c.json(balance)
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
      } finally {
        await inst?.close?.().catch(() => undefined)
      }
    })

    /** Aggregated equity across all enabled accounts. */
    .get('/equity', async (c) => {
      try {
        const accounts = await readTradingAccountsConfig()
        const enabled = accounts.filter((a) => a.enabled)

        const results = await Promise.all(
          enabled.map(async (account) => {
            let inst: { close?: () => Promise<void> } | null = null
            try {
              inst = createCcxtInstance(account)
              const ex = inst as CcxtInstance
              await ex.loadMarkets()
              const raw = (await ex.fetchBalance()) as Record<string, Record<string, unknown>>
              const free  = parseFloat(String(raw.free?.USDT  ?? raw.free?.USD  ?? 0))
              const used  = parseFloat(String(raw.used?.USDT  ?? raw.used?.USD  ?? 0))
              const total = parseFloat(String(raw.total?.USDT ?? raw.total?.USD ?? 0))

              // Aggregate unrealizedPnl from positions
              let unrealizedPnl = 0
              try {
                const rawPos = await ex.fetchPositions()
                for (const p of rawPos) {
                  const pos = p as Record<string, unknown>
                  unrealizedPnl += parseFloat(String(pos.unrealizedPnl ?? 0))
                }
              } catch { /* exchange may not support fetchPositions */ }

              return {
                id: account.id,
                label: account.label ?? account.id,
                exchange: String(account.brokerConfig.exchange ?? ''),
                equity: total,
                cash: free,
                usedMargin: used,
                unrealizedPnl,
                error: null as string | null,
              }
            } catch (err) {
              return {
                id: account.id,
                label: account.label ?? account.id,
                exchange: String(account.brokerConfig.exchange ?? ''),
                equity: 0, cash: 0, usedMargin: 0, unrealizedPnl: 0,
                error: err instanceof Error ? err.message : String(err),
              }
            } finally {
              await inst?.close?.().catch(() => undefined)
            }
          }),
        )

        const totalEquity      = results.reduce((s, r) => s + r.equity, 0)
        const totalCash        = results.reduce((s, r) => s + r.cash, 0)
        const totalUnrealizedPnl = results.reduce((s, r) => s + r.unrealizedPnl, 0)
        return c.json({ totalEquity, totalCash, totalUnrealizedPnl, accounts: results })
      } catch (err) {
        return c.json({ error: String(err) }, 500)
      }
    })

    /** Fetch open positions from the exchange. */
    .get('/accounts/:id/positions', async (c) => {
      const id = c.req.param('id')
      let inst: { close?: () => Promise<void> } | null = null
      try {
        const accounts = await readTradingAccountsConfig()
        const account = accounts.find((a) => a.id === id)
        if (!account) return c.json({ error: `Account "${id}" not found` }, 404)
        if (!account.enabled) return c.json({ error: `Account "${id}" is disabled` }, 400)

        inst = createCcxtInstance(account)
        const exchange = inst as Awaited<ReturnType<typeof createCcxtInstance>>

        await exchange.loadMarkets()

        let rawPositions: unknown[] = []
        try {
          rawPositions = await exchange.fetchPositions()
        } catch {
          // Exchange may not support fetchPositions; return empty list
        }

        const positions: TradePosition[] = []
        for (const p of rawPositions) {
          const pos = p as Record<string, unknown>
          const contracts = Math.abs(parseFloat(String(pos.contracts ?? 0)))
          const contractSize = parseFloat(String(pos.contractSize ?? 1))
          const quantity = contracts * contractSize
          if (quantity === 0) continue

          const markPrice = parseFloat(String(pos.markPrice ?? 0))
          positions.push({
            symbol: String(pos.symbol ?? ''),
            side: pos.side === 'long' ? 'long' : 'short',
            quantity: String(quantity),
            entryPrice: String(pos.entryPrice ?? 0),
            markPrice: String(markPrice),
            marketValue: String(quantity * markPrice),
            unrealizedPnl: String(pos.unrealizedPnl ?? 0),
            realizedPnl: String((pos as Record<string, unknown>).realizedPnl ?? 0),
            currency: String(pos.marginCurrency ?? pos.settle ?? 'USDT'),
          })
        }

        return c.json({ positions })
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
      } finally {
        await inst?.close?.().catch(() => undefined)
      }
    })
}
