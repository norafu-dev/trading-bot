import type { MessageBundle } from '../../ingestion/aggregator/types.js'
import type { RawMessage } from '../../ingestion/types.js'
import type { RegexConfig } from '../regex/types.js'

// ── Bundle factory ────────────────────────────────────────────────────────────

let seq = 0
export function resetSeq(): void { seq = 0 }

/** Build a single-message bundle from a raw text string. */
export function makeBundle(
  text: string,
  overrides: Partial<MessageBundle & { messageId?: string }> = {},
): MessageBundle {
  seq++
  const now = '2026-04-20T10:00:00.000Z'
  const msg: RawMessage = {
    messageId: overrides.messageId ?? `msg-${seq}`,
    eventType: 'create',
    timestamp: now,
    channelId: overrides.channelId ?? 'ch-signals',
    authorId: overrides.kolId ?? 'kol-bot',
    content: text,
    embeds: [],
    attachments: [],
  }
  return {
    id: overrides.id ?? `bundle-${seq}`,
    kolId: overrides.kolId ?? 'kol-bot',
    channelId: overrides.channelId ?? 'ch-signals',
    messages: [msg],
    openedAt: now,
    closedAt: now,
    closeReason: overrides.closeReason ?? 'idle_timeout',
  }
}

// ── WG Bot RegexConfig fixture ────────────────────────────────────────────────
//
// Patterns derived from real messages in samples/johnny.json.
// Signal format:  **<:Long|Short:ID>  [SYMBOL](URL)** | **入场:** PRICE | **止损:** PRICE | **风险:** PCT%
// Update format:  <:Long:ID> [**SYMBOL**](URL): ACTION **__<#...>__**

export const WG_BOT_CONFIG: RegexConfig = {
  name: 'wg-bot',

  signal: {
    // A signal always contains "| **入场:**"
    detector: '\\|\\s*\\*\\*入场:\\*\\*',

    fields: {
      // <:Long:ID> or <:Short:ID>
      side: { pattern: '<:(Long|Short):' },

      // [SYMBOL](https://discord…) — no bold around symbol in signal messages
      symbol: { pattern: '\\[([A-Z][A-Z0-9]*)\\]\\(https://discord' },

      // Single entry price: "| **入场:** 0.644 |"
      entryPrice: { pattern: '\\*\\*入场:\\*\\*\\s*([\\d.]+)' },

      // Range high: "76840 − 76640" → 76840
      entryRangeHigh: { pattern: '\\*\\*入场:\\*\\*\\s*([\\d.]+)\\s*[\\u2212-]' },

      // Range low: "76840 − 76640" → 76640
      entryRangeLow: { pattern: '\\*\\*入场:\\*\\*\\s*[\\d.]+\\s*[\\u2212-]\\s*([\\d.]+)' },

      // "| **止损:** 0.594 |"
      stopLossPrice: { pattern: '\\*\\*止损:\\*\\*\\s*([\\d.]+)' },

      // "**目标 1 (25%):** 0.21510"
      tp1: { pattern: '\\*\\*目标\\s*1[^:]*:\\*\\*\\s*([\\d.]+)' },
      tp2: { pattern: '\\*\\*目标\\s*2[^:]*:\\*\\*\\s*([\\d.]+)' },
      tp3: { pattern: '\\*\\*目标\\s*3[^:]*:\\*\\*\\s*([\\d.]+)' },

      // "**风险:** 5.0%"
      riskPercent: { pattern: '\\*\\*风险:\\*\\*\\s*([\\d.]+)%' },

      // Discord URL embedded in signal: [SYMBOL](https://discord.com/channels/GUILD/CHANNEL/MSG_ID)
      // Extracts the original source message ID for bot KOL linking (DEC-016)
      linkedExternalMessageId: { pattern: 'discord\\.com/channels/\\d+/\\d+/(\\d+)' },
    },

    defaults: { action: 'open', entryType: 'limit', contractType: 'perpetual' },
  },

  updates: [
    // stop_modified BEFORE breakeven_move so "止损移至 PRICE" is matched first
    {
      detector: '止损移至\\s+[\\d.]',
      updateType: 'stop_modified',
      fields: {
        newStopLoss: { pattern: '止损移至\\s+([\\d.]+)' },
        linkedExternalMessageId: { pattern: 'discord\\.com/channels/\\d+/\\d+/(\\d+)' },
        realizedRR: { pattern: '已实现 R/R:\\s*([-\\d.]+)' },
      },
    },
    {
      detector: '止损移至保本价',
      updateType: 'breakeven_move',
      fields: {
        linkedExternalMessageId: { pattern: 'discord\\.com/channels/\\d+/\\d+/(\\d+)' },
        realizedRR: { pattern: '已实现 R/R[:%\\s]+([-\\d.]+)' },
      },
    },
    {
      detector: '到达第.目标',
      updateType: 'tp_hit',
      fields: {
        level: {
          pattern: '到达第(一|二|三|四)目标',
          valueMap: { '一': '1', '二': '2', '三': '3', '四': '4' },
        },
        closedPercent: { pattern: '到达第.目标\\s*\\((\\d+)%\\)' },
        remainingPercent: { pattern: '(\\d+)%\\s*剩余仓位' },
        linkedExternalMessageId: { pattern: 'discord\\.com/channels/\\d+/\\d+/(\\d+)' },
      },
    },
    {
      detector: '止损平仓',
      updateType: 'sl_hit',
      fields: {
        linkedExternalMessageId: { pattern: 'discord\\.com/channels/\\d+/\\d+/(\\d+)' },
        realizedRR: { pattern: '已实现 R/R:\\s*([-\\d.]+)' },
      },
    },
    // runner_close BEFORE full_close (more specific: has "(XX%)" suffix)
    {
      detector: '盈利平仓\\s*\\(\\d+%\\)',
      updateType: 'runner_close',
      fields: {
        closedPercent: { pattern: '盈利平仓\\s*\\((\\d+)%\\)' },
        linkedExternalMessageId: { pattern: 'discord\\.com/channels/\\d+/\\d+/(\\d+)' },
        realizedRR: { pattern: '已实现 R/R:\\s*([-\\d.]+)' },
      },
    },
    {
      detector: '盈利平仓',
      updateType: 'full_close',
      fields: {
        linkedExternalMessageId: { pattern: 'discord\\.com/channels/\\d+/\\d+/(\\d+)' },
        realizedRR: { pattern: '已实现 R/R[:%\\s]+([-\\d.]+)' },
      },
    },
    {
      detector: '限价订单已成交',
      updateType: 'limit_filled',
      fields: {
        linkedExternalMessageId: { pattern: 'discord\\.com/channels/\\d+/\\d+/(\\d+)' },
      },
    },
    {
      detector: '限价订单已取消',
      updateType: 'other',
    },
  ],
}
