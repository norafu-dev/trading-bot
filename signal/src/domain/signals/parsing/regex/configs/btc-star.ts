/**
 * Regex config for the "BTC 星辰" channel.
 *
 * BTC 星辰 isn't really a human KOL — it's a Discord bot that mirrors a
 * specific on-chain trader's position changes into highly templated
 * Chinese messages. Six message templates:
 *
 *   状态：发现新开仓动作   → Signal (open)
 *   状态：部分止盈 ✂️       → PositionUpdate (tp_hit)
 *   状态：止盈平仓 🎯       → PositionUpdate (full_close)
 *   状态：(做多|做空)止盈   → PositionUpdate (full_close)
 *   状态：仓位已增加 (加码) → discarded (we don't currently DCA-follow on-chain adds;
 *                              the original signal already opened our position)
 *   状态：启动监控/关闭监控 → discarded (connector status broadcasts)
 *
 * Why discard rather than handle "加仓":
 *   The on-chain trader can DCA into a position without us having any
 *   read on whether their reasoning still holds. The first open already
 *   committed our risk; mirroring every add would multiply exposure
 *   beyond the operator-approved size. A future iteration could surface
 *   adds as a *modify* operation, but that requires per-position
 *   averaging logic the engine doesn't yet have.
 *
 * BTC 星辰 messages do NOT carry SL/TP — the original trader has them
 * but the bot doesn't relay them. Operations from this channel will be
 * sized + risk-managed using the operator's defaults (KolConfig.riskMultiplier
 * and risk-config baseRiskPercent), with no broker-attached SL/TP.
 */

import type { RegexConfig } from '../types.js'

export const BTC_STAR_CONFIG: RegexConfig = {
  name: 'btc-star',
  signal: {
    // The "open" template's distinctive header line. We pin the "新开仓"
    // wording specifically — "启动监控" and "仓位已增加" both contain "状态：" too.
    detector: '状态：发现新开仓动作',
    fields: {
      // "标的：ZECUSDT | 永续 | 3x"
      // Captures the exchange-flat ticker ("ZECUSDT"); position-sizer's
      // normalizeSymbol will split BASE/QUOTE downstream.
      symbol: { pattern: '标的：([A-Z0-9]+)' },
      side: {
        pattern: '方向：(做多|做空|Long|Short)',
        valueMap: {
          '做多': 'long',
          '做空': 'short',
          'Long': 'long',
          'Short': 'short',
        },
      },
      // "入场均价：$ 378.75" — handle dollar sign + thousands separators
      entryPrice: { pattern: '入场均价[^\\d-]*([\\d.,]+)' },
      // "ZECUSDT | 永续 | 3x" — capture the integer before x
      leverage: { pattern: '\\|\\s*(\\d+)x' },
    },
    defaults: {
      action: 'open',
      entryType: 'market',
      contractType: 'perpetual',
    },
  },
  updates: [
    {
      // "状态：部分止盈 ✂️"
      // Partial TP — the trader scaled out some quantity at a profit.
      detector: '状态：部分止盈',
      updateType: 'tp_hit',
      fields: {
        symbol: { pattern: '标的：([A-Z0-9]+)' },
        realizedPriceRef: { pattern: '成交价格[^\\d-]*([\\d.,]+)' },
      },
    },
    {
      // "状态：止盈平仓 🎯", "状态：做空止盈 🎯", "状态：做多止盈 🎯", "状态：止损平仓"
      // Full close — we link to the original Signal and treat as full_close.
      detector: '状态：(?:止盈平仓|做多止盈|做空止盈|止损平仓)',
      updateType: 'full_close',
      fields: {
        // The full-close template uses "总结：" instead of "标的：" — accept either.
        symbol: { pattern: '(?:标的|总结)：([A-Z0-9]+)' },
        realizedPriceRef: { pattern: '平仓均价[^\\d-]*([\\d.,]+)' },
      },
    },
    {
      // "状态：仓位已增加 (加码)"
      // We don't follow DCA-style adds; see file header for rationale.
      detector: '状态：仓位已增加',
      updateType: 'other',
    },
    {
      // "状态：启动监控，发现持仓中"
      // Connector startup sync — the bot just connected and is reporting
      // existing positions. Not a new action.
      detector: '状态：启动监控',
      updateType: 'other',
    },
    {
      // "状态：监控已关闭，待重启"
      // Connector teardown notice — pure status broadcast.
      detector: '状态：监控已关闭',
      updateType: 'other',
    },
  ],
}
