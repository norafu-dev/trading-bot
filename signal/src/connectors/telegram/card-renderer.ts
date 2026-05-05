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

import type { KolConfig, Operation } from '../../../../shared/types.js'
import type { TgInlineKeyboardMarkup } from './client.js'

export interface ApprovalCard {
  text: string
  replyMarkup: TgInlineKeyboardMarkup
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
 */
export function renderApprovalCard(op: Operation, kol: KolConfig | undefined): ApprovalCard {
  return {
    text: renderPendingText(op, kol),
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

function renderPendingText(op: Operation, kol: KolConfig | undefined): string {
  return [renderHeader(op, kol), renderBody(op), renderPendingFooter(op)]
    .filter(Boolean)
    .join('\n\n')
}

function renderHeader(op: Operation, kol: KolConfig | undefined): string {
  const kolLabel = kol?.label ?? op.kolId.slice(0, 8)
  const statusEmoji = STATUS_EMOJI[op.status]
  const statusLabel = STATUS_LABEL[op.status]
  return `${statusEmoji} *${escape(statusLabel)}* — ${escape(kolLabel)}`
}

function renderBody(op: Operation): string {
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

  return lines.join('\n')
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
