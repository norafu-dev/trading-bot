import type { OperationGuard, GuardContext } from './types.js'

/**
 * Adapted from `reference/OpenAlice/src/domain/trading/guards/symbol-whitelist.ts`
 *
 * Differences from OpenAlice:
 *   - Uses `operation.spec.symbol` (broker-agnostic) instead of
 *     `operation.contract.symbol` (IBKR-typed).
 *   - Case-insensitive match + strips an optional quote suffix (so
 *     "BTC", "BTC/USDT", "BTC/USDT:USDT", "BTCUSDT" all whitelist as "BTC").
 *   - Empty list = allow all (instead of throwing). This matches the
 *     RiskConfig default — fresh installs work without manual setup.
 *
 * For trade operations, "no whitelist" means the entire universe is
 * allowed, which is fine for trusted KOLs. The user can tighten via
 * dashboard /settings.
 */
export class SymbolWhitelistGuard implements OperationGuard {
  readonly name = 'symbol-whitelist'
  private readonly allowedBases: Set<string>

  constructor(options: Record<string, unknown>) {
    const raw = options['symbols']
    const symbols = Array.isArray(raw) ? (raw.filter((s): s is string => typeof s === 'string')) : []
    this.allowedBases = new Set(symbols.map(normalizeBase))
  }

  check(ctx: GuardContext): string | null {
    if (this.allowedBases.size === 0) return null
    if (ctx.operation.spec.action !== 'placeOrder') return null

    const base = normalizeBase(ctx.operation.spec.symbol)
    if (this.allowedBases.has(base)) return null
    return `symbol ${ctx.operation.spec.symbol} (base "${base}") is not in the whitelist`
  }
}

/** Strip quote suffix and uppercase: "btc/usdt:usdt" → "BTC". */
function normalizeBase(raw: string): string {
  const upper = raw.trim().toUpperCase()
  if (!upper) return upper

  // Already in CCXT shape ("BTC/USDT" or "BTC/USDT:USDT") — take base
  const slash = upper.indexOf('/')
  if (slash > 0) return upper.slice(0, slash)

  // Exchange-flat ("BTCUSDT") — strip a known quote suffix
  for (const quote of ['USDT', 'USDC', 'BUSD']) {
    if (upper.endsWith(quote) && upper.length > quote.length) {
      return upper.slice(0, -quote.length)
    }
  }
  return upper
}
