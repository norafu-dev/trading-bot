import { logger } from '../../core/logger.js'
import type { AccountBalance, TradePosition, TradingAccountConfig } from '../../../../shared/types.js'
import { createCcxtInstance } from '../trading/ccxt-pool.js'

/**
 * Periodic broker poller — keeps a fresh `AccountBalance` + `positions[]`
 * snapshot in memory so the PositionSizer / GuardPipeline never blocks
 * on a 500 ms exchange round-trip when a signal arrives.
 *
 * Design choices:
 *   - One CCXT client per account, opened on first refresh, closed on
 *     `stop()`. CCXT's `loadMarkets` is heavy; reusing the client across
 *     polls is the only sane way.
 *   - Refresh interval defaults to 30 s. Aggressive enough that a signal
 *     arriving 30 s after equity changes still sees a recent snapshot,
 *     gentle enough not to hammer the exchange.
 *   - Sequentially polls accounts (1 at a time) so a slow account doesn't
 *     block another's refresh, but bursts of activity don't hammer all
 *     exchanges simultaneously.
 *   - Caches the LAST KNOWN GOOD snapshot per account. A failed refresh
 *     keeps the previous snapshot rather than nulling it — the engine
 *     prefers a slightly stale snapshot over no snapshot at all.
 *
 * Future enhancement (Phase 4b): emit `account.snapshot` events when the
 * snapshot changes meaningfully (>1% equity move) so the dashboard can
 * react without polling.
 */

export interface AccountSnapshot {
  balance: AccountBalance
  positions: TradePosition[]
}

export interface ISnapshotService {
  /** Read-only — returns the latest cached snapshot for `accountId`, or null. */
  get(accountId: string): AccountSnapshot | null
  /** Force-refresh a single account ahead of schedule. Resolves to the new snapshot. */
  refresh(accountId: string): Promise<AccountSnapshot | null>
  /** Stop background polling and release CCXT clients. */
  stop(): Promise<void>
}

export class SnapshotService implements ISnapshotService {
  private readonly snapshots = new Map<string, AccountSnapshot>()
  private readonly clients = new Map<string, ReturnType<typeof createCcxtInstance>>()
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false  // single-flight lock — prevents overlapping ticks

  constructor(
    /** Returns the current list of enabled trading accounts. */
    private readonly listAccounts: () => Promise<TradingAccountConfig[]>,
    private readonly intervalMs: number = 30_000,
  ) {}

  start(): void {
    if (this.timer) return
    // Fire once immediately so the engine has a snapshot ASAP after boot,
    // then settle into the interval cadence.
    void this.tick()
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
  }

  get(accountId: string): AccountSnapshot | null {
    return this.snapshots.get(accountId) ?? null
  }

  async refresh(accountId: string): Promise<AccountSnapshot | null> {
    const accounts = await this.listAccounts()
    const account = accounts.find((a) => a.id === accountId && a.enabled)
    if (!account) return null
    return this.refreshOne(account)
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    for (const client of this.clients.values()) {
      await client.close?.().catch(() => undefined)
    }
    this.clients.clear()
  }

  // ── internal ────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const accounts = await this.listAccounts()
      for (const account of accounts) {
        if (!account.enabled) continue
        await this.refreshOne(account)
      }
    } catch (err) {
      logger.warn({ err }, 'SnapshotService.tick failed')
    } finally {
      this.polling = false
    }
  }

  private async refreshOne(account: TradingAccountConfig): Promise<AccountSnapshot | null> {
    let client = this.clients.get(account.id)
    if (!client) {
      try {
        client = createCcxtInstance(account)
        await client.loadMarkets()
        this.clients.set(account.id, client)
      } catch (err) {
        logger.warn({ err, accountId: account.id }, 'SnapshotService: failed to create CCXT client')
        return this.snapshots.get(account.id) ?? null
      }
    }

    try {
      const [rawBalance, rawPositions] = await Promise.all([
        client.fetchBalance(),
        client.fetchPositions(),
      ])

      const balance = parseBalance(account.id, rawBalance as Record<string, Record<string, unknown>>)
      const positions = parsePositions(rawPositions as unknown[])
      const snapshot: AccountSnapshot = { balance, positions }
      this.snapshots.set(account.id, snapshot)
      return snapshot
    } catch (err) {
      logger.warn(
        { err, accountId: account.id },
        'SnapshotService: poll failed, keeping previous snapshot',
      )
      return this.snapshots.get(account.id) ?? null
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseBalance(accountId: string, raw: Record<string, Record<string, unknown>>): AccountBalance {
  const free = parseFloat(String(raw.free?.USDT ?? raw.free?.USD ?? 0))
  const used = parseFloat(String(raw.used?.USDT ?? raw.used?.USD ?? 0))
  const total = parseFloat(String(raw.total?.USDT ?? raw.total?.USD ?? 0))
  const baseCurrency = raw.free?.USDT !== undefined ? 'USDT' : 'USD'
  return {
    accountId,
    baseCurrency,
    netLiquidation: String(total),
    totalCashValue: String(free),
    unrealizedPnl: '0',
    realizedPnl: '0',
    initMarginReq: String(used),
    fetchedAt: new Date().toISOString(),
  }
}

function parsePositions(raw: unknown[]): TradePosition[] {
  const out: TradePosition[] = []
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue
    const pos = p as Record<string, unknown>
    const symbol = typeof pos.symbol === 'string' ? pos.symbol : null
    const contractsNum = Number(pos.contracts ?? pos.amount ?? 0)
    if (!symbol || !Number.isFinite(contractsNum) || contractsNum === 0) continue

    const sideStr = String(pos.side ?? '').toLowerCase()
    const side: 'long' | 'short' =
      sideStr === 'long' || sideStr === 'short' ? sideStr : contractsNum > 0 ? 'long' : 'short'

    out.push({
      symbol,
      side,
      quantity: String(Math.abs(contractsNum)),
      entryPrice: String(pos.entryPrice ?? 0),
      markPrice: String(pos.markPrice ?? 0),
      marketValue: String(pos.notional ?? 0),
      unrealizedPnl: String(pos.unrealizedPnl ?? 0),
      realizedPnl: String(pos.realizedPnl ?? 0),
      currency: typeof pos.quote === 'string' ? pos.quote : 'USDT',
    })
  }
  return out
}
