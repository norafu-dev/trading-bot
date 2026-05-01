import type { ClassifyFewShot } from '../../types.js'

/**
 * Global few-shot examples for the classifier.
 *
 * These are included in every classifier call, regardless of KOL.
 * They cover the most common label types and bilingual (EN/ZH) message styles.
 * Per-KOL few-shots (when added) are appended after these globals.
 */
export const GLOBAL_CLASSIFY_FEWSHOTS: ClassifyFewShot[] = [
  {
    messageText: 'BTC多 入场 76500-77000 止损75500 TP1 78500 TP2 80000 TP3 82000 20x',
    expectedLabel: 'new_signal',
    reasoning: 'Contains entry range, stop loss, and take-profit levels — clear new long entry.',
  },
  {
    messageText: 'ETH/USDT SHORT\nEntry: 3250-3280\nSL: 3350\nTP1: 3150 | TP2: 3050\nLev: 10x',
    expectedLabel: 'new_signal',
    reasoning: 'Structured entry/SL/TP block for a new short position.',
  },
  {
    messageText: 'SOL TP1 hit 🎯 Taking 30% off the table. Runner still open.',
    expectedLabel: 'position_update',
    reasoning: 'References an existing position and a TP level being triggered.',
  },
  {
    messageText: '之前发的BTC单止损移到入场价 保本了',
    expectedLabel: 'position_update',
    reasoning: 'Moving stop to entry price (breakeven move) on a prior signal.',
  },
  {
    messageText: 'Good morning everyone! Markets looking bullish today 🚀',
    expectedLabel: 'chitchat',
    reasoning: 'Casual greeting with a vague sentiment; no trade parameters.',
  },
  {
    messageText: '用我的链接注册Bybit享20%手续费返佣 → bybit.com/invite/xxxx',
    expectedLabel: 'advertisement',
    reasoning: 'Exchange referral link — promotional content.',
  },
  {
    messageText: '今天讲一下如何用RSI判断背离 当RSI低点抬高而价格低点下移时形成看涨背离',
    expectedLabel: 'education',
    reasoning: 'Explaining an indicator concept — no trade call.',
  },
  {
    messageText: 'BTC回调到76000附近可以考虑重新入场 不是正式信号',
    expectedLabel: 're_entry_hint',
    reasoning: 'Informal re-entry suggestion with no concrete entry/SL/TP.',
  },
  {
    messageText: '宏观上美联储鸽派信号明显 整体风险资产偏多 短期注意支撑位76800',
    expectedLabel: 'macro_analysis',
    reasoning: 'Broad market commentary and Fed outlook — no specific trade entry.',
  },
  {
    messageText: '本月战绩：共发信号12条 盈利9条 亏损3条 总盈亏比2.3',
    expectedLabel: 'recap',
    reasoning: 'Performance statistics summary.',
  },
]
