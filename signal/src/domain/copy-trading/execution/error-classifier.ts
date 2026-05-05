/**
 * Classify CCXT (and generic) errors into actionable categories.
 *
 * The broker dispatcher uses these to:
 *   - decide whether to retry (network / rate-limit), or fail outright
 *     (bad credentials / insufficient margin / invalid order)
 *   - record a meaningful `reason` on the Operation when it transitions
 *     to `failed`, so the dashboard / Telegram card can show the human
 *     what went wrong without making them open the log file.
 *
 * CCXT exposes a hierarchy of error subclasses (NetworkError,
 * AuthenticationError, InsufficientFunds, …). We use `instanceof`
 * checks against ccxt's runtime classes when available, plus message
 * pattern fallbacks for exchanges that throw via raw Error.
 *
 * Categories:
 *   network       — ECONNRESET, fetch timeout, 5xx. RETRIABLE.
 *   rate-limit    — 429 / "Too Many Requests". RETRIABLE with backoff.
 *   auth          — bad apiKey / signature / IP whitelist. NOT RETRIABLE.
 *   insufficient  — not enough margin / balance for this order. NOT RETRIABLE.
 *   invalid-order — symbol typo, lot size below min, price too far,
 *                   leverage out of range. NOT RETRIABLE.
 *   exchange      — exchange-specific business rejection (e.g. Bitget
 *                   "modify order is not allowed"). NOT RETRIABLE.
 *   unknown       — anything else. NOT RETRIABLE — better to surface as
 *                   failed than silently retry into a real loss.
 */

import * as ccxt from 'ccxt'

export type ErrorCategory =
  | 'network'
  | 'rate-limit'
  | 'auth'
  | 'insufficient'
  | 'invalid-order'
  | 'exchange'
  | 'unknown'

export interface ClassifiedError {
  category: ErrorCategory
  retriable: boolean
  /** Short human-readable description, suitable for surfacing on the failed-op card. */
  message: string
  /** Original error reference, for log enrichment. */
  cause: unknown
}

const RETRIABLE: Record<ErrorCategory, boolean> = {
  network: true,
  'rate-limit': true,
  auth: false,
  insufficient: false,
  'invalid-order': false,
  exchange: false,
  unknown: false,
}

export function classifyError(err: unknown): ClassifiedError {
  // ccxt's error hierarchy — most specific first.
  if (err instanceof ccxt.AuthenticationError) {
    return make('auth', '认证失败（API key / signature / IP 白名单错误）', err)
  }
  if (err instanceof ccxt.InsufficientFunds) {
    return make('insufficient', '保证金不足', err)
  }
  if (err instanceof ccxt.InvalidOrder) {
    return make('invalid-order', `订单参数无效：${shortMessage(err)}`, err)
  }
  if (err instanceof ccxt.BadSymbol) {
    return make('invalid-order', `交易对无效：${shortMessage(err)}`, err)
  }
  if (err instanceof ccxt.RateLimitExceeded) {
    return make('rate-limit', '触发限频', err)
  }
  if (err instanceof ccxt.NetworkError) {
    return make('network', `网络异常：${shortMessage(err)}`, err)
  }
  if (err instanceof ccxt.ExchangeError) {
    // Generic ExchangeError catches business rejections that aren't a
    // more specific subclass. Bitget's "modify order is not allowed"
    // and similar fall here.
    return make('exchange', `交易所拒单：${shortMessage(err)}`, err)
  }

  // Non-ccxt errors — try a few message-pattern fallbacks. ccxt isn't
  // 100% consistent at wrapping low-level fetch errors as NetworkError.
  const message = shortMessage(err)
  if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(message)) {
    return make('network', `网络异常：${message}`, err)
  }
  if (/429|too many requests|rate limit/i.test(message)) {
    return make('rate-limit', '触发限频', err)
  }

  return make('unknown', `未分类错误：${message}`, err)
}

function make(category: ErrorCategory, message: string, cause: unknown): ClassifiedError {
  return { category, retriable: RETRIABLE[category], message, cause }
}

/**
 * Trim the error string to a single-line, dashboard-friendly snippet.
 * CCXT errors can include the full exchange JSON response; we cap at 200
 * chars so a "failed" operation card stays readable.
 */
function shortMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  return oneLine.length > 200 ? oneLine.slice(0, 197) + '…' : oneLine
}
