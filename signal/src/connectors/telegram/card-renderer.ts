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

/**
 * Pending-card body. Layout aim: each price level on its own line so the
 * operator can scan top-to-bottom without parsing dense tag soup. The
 * three groups, separated by blank lines:
 *
 *   1. Header — symbol + side + perp/spot + leverage badges
 *   2. Price ladder — entry first, then SL, then TPs in order. Each row
 *      pairs the absolute price with its distance from current market
 *      so "is this still attractive?" reads as a single eyeball motion.
 *   3. Footer line — sizing context (small, _italic_).
 *
 * Distance computation always uses the freshest available price
 * (liveNow → falls back to op.priceCheck). The signal-time-vs-now
 * "drift" panel was removed because in practice the two timestamps
 * are within seconds of each other (sizer pulls priceCheck → engine
 * emits → notifier renders, all in the same second), so the drift
 * always read 0% and added zero information.
 */
function renderBody(op: Operation, liveNow?: LiveQuoteSnapshot): string {
  const spec = op.spec
  if (spec.action !== 'placeOrder') {
    return `_${escape(spec.action)}_`
  }
  const sideEmoji = spec.side === 'long' ? '📈' : '📉'
  const sideLabel = spec.side === 'long' ? '做多' : '做空'
  const contractLabel = spec.contractType === 'perpetual' ? '永续' : '现货'
  const orderTypeLabel = spec.orderType === 'limit' ? '限价' : '市价'

  const sections: string[] = []

  // ── Header: symbol + key badges ─────────────────────────────────
  const headerBits: string[] = [
    `${sideEmoji} *${escape(spec.symbol)}*`,
    `\`${sideLabel}\``,
    `\`${contractLabel}\``,
    `\`${orderTypeLabel}\``,
  ]
  if (spec.leverage !== undefined) headerBits.push(`\`${spec.leverage}×\``)
  sections.push(headerBits.join(' '))

  // ── Price ladder: entry / SL / TPs, each annotated with distance ─
  // Use the freshest price we have for percentage math.
  const refPrice = pickRefPrice(op.priceCheck, liveNow)
  const ladder = renderPriceLadder(spec, refPrice)
  sections.push(ladder)

  // ── Footer: sizing context + (rare) signal-time drift ────────────
  const footerLines: string[] = []
  if (op.sizingContext) {
    const unit = spec.size.unit === 'absolute' ? 'USDT' : spec.size.unit
    footerLines.push(
      `_规模 ${escape(spec.size.value)} ${escape(unit)}  ·  权益 ${escape(op.sizingContext.equity)} USDT × ${escape(op.sizingContext.effectiveRiskPercent)}%_`,
    )
  }
  // Signal drift only mentioned when meaningfully large (> 0.3%) — sub-
  // 0.3% drifts are noise from the signal-time snapshot being taken
  // seconds before the approval-time fetch.
  const driftLine = renderDriftIfSignificant(spec, op.priceCheck, liveNow)
  if (driftLine) footerLines.push(driftLine)
  if (footerLines.length > 0) sections.push(footerLines.join('\n'))

  return sections.join('\n\n')
}

/**
 * Compose the price-ladder lines (entry / SL / TPs). When refPrice is
 * available each line is annotated with a signed % distance:
 *   - entry: raw signed (negative = price still needs to pull back to
 *            fill the limit; ≈0 = already at entry)
 *   - SL: framed in the trade's losing direction so the magnitude is
 *         "how much room until stop-out". 14% = comfortable buffer.
 *         A small negative (-1%) screams "you're about to get stopped".
 *   - TPs: framed in the favourable direction so positive = "this much
 *          upside left to capture". TP1 +0.4% means TP1 is right above
 *          current price — barely any reward left.
 */
function renderPriceLadder(
  spec: Extract<OperationSpec, { action: 'placeOrder' }>,
  refPrice: { price: number; source: string } | null,
): string {
  const lines: string[] = []
  const dirSign = spec.side === 'long' ? 1 : -1

  // Live price banner — gives the % column a referent.
  if (refPrice) {
    lines.push(`实时 \`${refPrice.price}\`  _(${escape(refPrice.source)})_`)
  }

  // Entry — for a limit order, show the KOL's specified price; for market,
  // align entry == live so distance is conceptually 0.
  if (spec.orderType === 'limit' && spec.price) {
    const entryNum = Number(spec.price)
    const distLabel = refPrice && Number.isFinite(entryNum) && entryNum > 0
      ? `  \`${formatSignedPct(((entryNum - refPrice.price) / refPrice.price) * 100)}\``
      : ''
    lines.push(`入场 \`${escape(spec.price)}\`${distLabel}`)
  } else {
    lines.push('入场 \`市价\`')
  }

  // SL
  if (spec.stopLoss?.price) {
    const slNum = Number(spec.stopLoss.price)
    const distLabel = refPrice && Number.isFinite(slNum) && slNum > 0
      ? `  \`${formatSignedPct(((slNum - refPrice.price) / refPrice.price) * 100 * dirSign)}\``
      : ''
    lines.push(`🛑 止损 \`${escape(spec.stopLoss.price)}\`${distLabel}`)
  }

  // TPs — one per line for readability
  for (const tp of spec.takeProfits ?? []) {
    const tpNum = Number(tp.price)
    const distLabel = refPrice && Number.isFinite(tpNum) && tpNum > 0
      ? `  \`${formatSignedPct(((tpNum - refPrice.price) / refPrice.price) * 100 * dirSign)}\``
      : ''
    lines.push(`🎯 TP${tp.level} \`${escape(tp.price)}\`${distLabel}`)
  }

  return lines.join('\n')
}

/**
 * Pick the freshest available reference price. Returns null when neither
 * snapshot is usable — caller renders a stripped-down ladder without
 * percentage annotations.
 */
function pickRefPrice(
  signalSnap: Operation['priceCheck'],
  liveNow: LiveQuoteSnapshot | undefined,
): { price: number; source: string } | null {
  const raw = liveNow?.price ?? signalSnap?.currentPrice
  const source = liveNow?.source ?? signalSnap?.source ?? 'live'
  if (!raw) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return { price: n, source }
}

/**
 * Show "信号时 X → 已顺/逆 Y%" only when the drift is large enough to
 * affect the decision. Below 0.3% we treat it as noise from sizing
 * latency and suppress.
 */
function renderDriftIfSignificant(
  spec: Extract<OperationSpec, { action: 'placeOrder' }>,
  signalSnap: Operation['priceCheck'],
  liveNow: LiveQuoteSnapshot | undefined,
): string | null {
  if (!liveNow || !signalSnap) return null
  const live = Number(liveNow.price)
  const t0 = Number(signalSnap.currentPrice)
  if (!Number.isFinite(live) || !Number.isFinite(t0) || live <= 0 || t0 <= 0) return null
  const drift = ((live - t0) / t0) * 100
  if (Math.abs(drift) < 0.3) return null
  const dirSign = spec.side === 'long' ? 1 : -1
  const framed = drift * dirSign
  return `_信号时 ${escape(signalSnap.currentPrice)} → 已${framed >= 0 ? '顺' : '逆'} ${formatSignedPct(framed)}_`
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
