/**
 * Render an `Operation` as a Telegram approval card.
 *
 * Two outputs:
 *   - `text`         Markdown-formatted body, balancing density and skim-ability
 *   - `replyMarkup`  inline keyboard with Approve / Reject buttons
 *
 * Why we build text + keyboard here rather than in the notifier:
 *   - the post-approval edits (success / failed / timeout) need the same
 *     header but a different footer; centralising the formatter keeps
 *     them visually consistent
 *   - the renderer is the only file that needs to know our Markdown-escape
 *     rules and callback_data encoding
 *
 * Callback data format: `op:<approve|reject>:<operationId>`
 *   - 64-byte limit (Telegram). ULID = 26 chars; "op:approve:" = 11; total 37.
 *   - colon-separated for trivial parsing without JSON overhead.
 */

import type { KolConfig, Operation, OperationSpec } from '../../../../shared/types.js'
import type { TgInlineKeyboardMarkup } from './client.js'

export interface ApprovalCard {
  text: string
  replyMarkup: TgInlineKeyboardMarkup
}

/**
 * Optional fresh-quote snapshot taken at the moment the approval card
 * is rendered. Lets the card show "signal-time vs approval-time" drift
 * — particularly useful for market orders where the signal might be
 * 2-3 minutes old and the price has moved meaningfully.
 *
 * `null` (price service unavailable, symbol unresolvable) is acceptable —
 * the renderer falls back to op.priceCheck (signal-time snapshot) so
 * distances are still shown, just less fresh.
 */
export interface LiveQuoteSnapshot {
  price: string
  source: string
  fetchedAt: string
}

export interface ParsedCallbackData {
  action: 'approve' | 'reject'
  operationId: string
}

const CALLBACK_PREFIX = 'op'

export function encodeCallback(action: 'approve' | 'reject', operationId: string): string {
  return `${CALLBACK_PREFIX}:${action}:${operationId}`
}

export function parseCallback(data: string): ParsedCallbackData | null {
  const parts = data.split(':')
  if (parts.length !== 3 || parts[0] !== CALLBACK_PREFIX) return null
  const action = parts[1]
  if (action !== 'approve' && action !== 'reject') return null
  if (!parts[2]) return null
  return { action, operationId: parts[2] }
}

/**
 * Build the pending-approval card. Called once per operation when the
 * engine emits `operation.created` with status === 'pending'.
 *
 * `liveNow` is an optional fresh quote pulled by the notifier right
 * before sending the card; when present it drives the price-aid line
 * AND a "signal-time vs now" drift metric. When absent the card falls
 * back to op.priceCheck (snapshot from signal parsing time).
 */
export function renderApprovalCard(
  op: Operation,
  kol: KolConfig | undefined,
  liveNow?: LiveQuoteSnapshot,
): ApprovalCard {
  return {
    text: renderPendingText(op, kol, liveNow),
    replyMarkup: {
      inline_keyboard: [
        [
          { text: '✅ 批准', callback_data: encodeCallback('approve', op.id) },
          { text: '❌ 拒绝', callback_data: encodeCallback('reject', op.id) },
        ],
      ],
    },
  }
}

/**
 * Body for an operation that already finished its decision phase. No
 * keyboard — the buttons go away once a decision is recorded so the
 * user can't double-tap a stale card.
 */
export function renderResolvedText(
  op: Operation,
  kol: KolConfig | undefined,
  decision: {
    by: 'dashboard' | 'telegram' | 'engine' | 'broker'
    actor?: string  // username on telegram, free-form elsewhere
    at: string
    reason?: string
  },
): string {
  const head = renderHeader(op, kol)
  const body = renderBody(op)
  const footer = renderResolutionFooter(op, decision)
  return [head, body, footer].filter(Boolean).join('\n\n')
}

// ── Internals ──────────────────────────────────────────────────────────────

function renderPendingText(
  op: Operation,
  kol: KolConfig | undefined,
  liveNow?: LiveQuoteSnapshot,
): string {
  return [renderHeader(op, kol), renderBody(op, liveNow), renderPendingFooter(op)]
    .filter(Boolean)
    .join('\n\n')
}

function renderHeader(op: Operation, kol: KolConfig | undefined): string {
  const kolLabel = kol?.label ?? op.kolId.slice(0, 8)
  const statusEmoji = STATUS_EMOJI[op.status]
  const statusLabel = STATUS_LABEL[op.status]
  return `${statusEmoji} *${escape(statusLabel)}* — ${escape(kolLabel)}`
}

function renderBody(op: Operation, liveNow?: LiveQuoteSnapshot): string {
  const spec = op.spec
  if (spec.action !== 'placeOrder') {
    return `_${escape(spec.action)}_`
  }
  const sideEmoji = spec.side === 'long' ? '📈' : '📉'
  const sideLabel = spec.side === 'long' ? '做多' : '做空'
  const contractLabel = spec.contractType === 'perpetual' ? '永续' : '现货'
  const lines: string[] = []

  // Symbol + side + leverage
  const headerBits: string[] = [
    `${sideEmoji} *${escape(spec.symbol)}*`,
    `\`${sideLabel}\``,
    `\`${contractLabel}\``,
  ]
  if (spec.leverage !== undefined) headerBits.push(`\`${spec.leverage}×\``)
  lines.push(headerBits.join(' '))

  // Order type + price
  if (spec.orderType === 'limit' && spec.price) {
    lines.push(`入场：\`${escape(spec.price)}\` (限价)`)
  } else {
    lines.push('入场：市价')
  }

  // Size
  const unit = spec.size.unit === 'absolute' ? 'USDT' : spec.size.unit
  lines.push(`规模：\`${escape(spec.size.value)} ${escape(unit)}\``)

  // SL / TP
  if (spec.stopLoss?.price) {
    lines.push(`止损：\`${escape(spec.stopLoss.price)}\``)
  }
  if (spec.takeProfits && spec.takeProfits.length > 0) {
    const tps = spec.takeProfits
      .map((tp) => `止盈${tp.level}：\`${escape(tp.price)}\``)
      .join('  ')
    lines.push(tps)
  }

  // Sizing context — small, so the human knows what equity assumption was used
  if (op.sizingContext) {
    lines.push(
      `_按权益 ${escape(op.sizingContext.equity)} USDT × ${escape(op.sizingContext.effectiveRiskPercent)}% 测算_`,
    )
  }

  // Live-price decision aid — distance from "now" to entry / SL / each
  // TP, plus signal-time-vs-now drift. The single most useful piece of
  // info before approving: "has the price moved since the signal? is
  // the R/R still attractive?". Prefers fresh `liveNow` (notifier-time
  // quote); falls back to op.priceCheck (signal-time snapshot).
  const priceAid = renderPriceAid(spec, op.priceCheck, liveNow)
  if (priceAid) lines.push(priceAid)

  return lines.join('\n')
}

/**
 * Build the live-price decision panel. Two layers:
 *   - HEADER: which price we're using as "now", plus "signal-time vs now"
 *     drift if both snapshots are available. Drift is what tells the
 *     operator whether the signal has gone stale while waiting.
 *   - DISTANCES: from "now" to entry (limit only) / each TP / SL.
 *     Sign convention: TP / entry framed in the trade's favourable
 *     direction so positive = good. SL framed raw (negative = stop is
 *     on the losing side, e.g. "-13%" = you're 13% from getting stopped).
 *
 * Returns null when neither liveNow nor op.priceCheck has a usable price.
 */
function renderPriceAid(
  spec: Extract<OperationSpec, { action: 'placeOrder' }>,
  signalSnap: Operation['priceCheck'],
  liveNow: LiveQuoteSnapshot | undefined,
): string | null {
  // Pick the freshest price for distance math; default to signalSnap.
  const refPriceStr = liveNow?.price ?? signalSnap?.currentPrice
  const refSource = liveNow?.source ?? signalSnap?.source
  if (!refPriceStr) return null
  const live = Number(refPriceStr)
  if (!Number.isFinite(live) || live <= 0) return null

  const headerBits: string[] = [
    liveNow
      ? `*实时* \`${escape(refPriceStr)}\` (${escape(refSource ?? 'live')})`
      : `*信号时* \`${escape(refPriceStr)}\` (${escape(refSource ?? 'snap')})`,
  ]

  // Drift from signal time to now — tells you if the signal aged poorly.
  if (liveNow && signalSnap) {
    const t0 = Number(signalSnap.currentPrice)
    if (Number.isFinite(t0) && t0 > 0) {
      const drift = ((live - t0) / t0) * 100
      // Frame drift in the trade's favourable direction so a
      // "+1%" reads as "price has moved 1% in your favour while the
      // signal sat in the queue", and "-1.5%" as "moved against you".
      const dirSign = spec.side === 'long' ? 1 : -1
      const framedDrift = drift * dirSign
      headerBits.push(
        `信号时 \`${escape(signalSnap.currentPrice)}\` → 已${framedDrift >= 0 ? '顺' : '逆'} ${formatSignedPct(framedDrift)}`,
      )
    }
  }

  const dirSign = spec.side === 'long' ? 1 : -1
  const distances: string[] = []
  // Entry — meaningful only for limit orders. KOL's specified entry
  // price vs current market.
  if (spec.orderType === 'limit' && spec.price) {
    const entry = Number(spec.price)
    if (Number.isFinite(entry) && entry > 0) {
      // For a long limit waiting for pullback (entry < live), pct < 0
      // means "price still needs to drop X% before we fill" — the
      // canonical patient setup. Frame raw signed so the reader sees
      // direction at a glance.
      const pct = ((entry - live) / live) * 100
      distances.push(`距入场 ${formatSignedPct(pct)}`)
    }
  }
  // TPs — favourable side (positive = price needs to move that much
  // in your favour to hit the target).
  for (const tp of spec.takeProfits ?? []) {
    const v = Number(tp.price)
    if (!Number.isFinite(v) || v <= 0) continue
    const pct = ((v - live) / live) * 100 * dirSign
    distances.push(`TP${tp.level} ${formatSignedPct(pct)}`)
  }
  // SL — raw signed. Negative percent = you're that close to stop-out
  // on a market entry. "−13%" should visually scream the worst case.
  if (spec.stopLoss?.price) {
    const v = Number(spec.stopLoss.price)
    if (Number.isFinite(v) && v > 0) {
      const pct = ((v - live) / live) * 100 * dirSign
      distances.push(`SL ${formatSignedPct(pct)}`)
    }
  }

  const lines: string[] = [headerBits.join('\n')]
  if (distances.length > 0) {
    lines.push(`_${escape(distances.join(' · '))}_`)
  }
  return lines.join('\n')
}

function formatSignedPct(p: number): string {
  if (!Number.isFinite(p)) return '?'
  const sign = p >= 0 ? '+' : ''
  return `${sign}${p.toFixed(1)}%`
}

function renderPendingFooter(op: Operation): string {
  // Show only failed guards in the pending card; passed guards are noise here.
  const failed = op.guardResults.filter((g) => !g.passed)
  if (failed.length === 0) {
    return `_id_ \`${escape(op.id)}\``
  }
  const guardLines = failed.map((g) => `• ${escape(g.name)}：${escape(g.reason ?? '（无理由）')}`)
  return `*风控提示：*\n${guardLines.join('\n')}\n\n_id_ \`${escape(op.id)}\``
}

function renderResolutionFooter(
  op: Operation,
  decision: {
    by: 'dashboard' | 'telegram' | 'engine' | 'broker'
    actor?: string
    at: string
    reason?: string
  },
): string {
  const byLabel = BY_LABEL[decision.by]
  const who = decision.actor ? `${byLabel}（${decision.actor}）` : byLabel
  const lines = [
    `_由 ${escape(who)} 于 ${escape(formatTime(decision.at))} 决策_`,
  ]
  if (decision.reason) lines.push(`_理由：_ ${escape(decision.reason)}`)
  lines.push(`_id_ \`${escape(op.id)}\``)
  return lines.join('\n')
}

const STATUS_EMOJI: Record<Operation['status'], string> = {
  pending: '⏳',
  approved: '✅',
  rejected: '❌',
  executed: '🟢',
  failed: '⚠️',
}

const STATUS_LABEL: Record<Operation['status'], string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
  executed: '已执行',
  failed: '执行失败',
}

const BY_LABEL: Record<'dashboard' | 'telegram' | 'engine' | 'broker', string> = {
  dashboard: 'Dashboard',
  telegram: 'Telegram',
  engine: '引擎自动',
  broker: '交易所',
}

/**
 * Telegram Markdown (legacy) escape: only `_*[\`` are special. We use
 * the legacy mode (parse_mode: 'Markdown') because it's more lenient
 * about underscores in plain text — symbols like `BTC/USDT:USDT` won't
 * try to start an italic block.
 */
function escape(s: string): string {
  return s.replace(/[*_`[\]]/g, (c) => `\\${c}`)
}

/**
 * Localised approval-card timestamps. We render in `Asia/Shanghai`
 * (operator's home timezone) rather than UTC so a glance at the card
 * matches wall-clock without mental conversion. Switch the constant
 * if the operator relocates; or read from config in a future iteration.
 */
const CARD_TIMEZONE = 'Asia/Shanghai'
const CARD_TIMEZONE_LABEL = 'CST'

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: CARD_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? ''
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')} ${CARD_TIMEZONE_LABEL}`
}
