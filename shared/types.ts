// ── Parser type ───────────────────────────────────────────────────────────────

/**
 * Which parsing strategy the signal pipeline uses for a given KOL's messages.
 * Defined here so the dashboard can display and edit it without depending on
 * the signal-domain package.
 */
export type ParserType = 'regex_structured' | 'llm_text' | 'llm_vision' | 'hybrid'

// ── KOL config ────────────────────────────────────────────────────────────────

/** KOL (Key Opinion Leader) registration entry. */
export interface KolConfig {
  id: string
  label: string
  /** Relative path under data/avatars/, e.g. "avatars/123456.png" */
  avatarPath?: string
  enabled: boolean
  riskMultiplier: number
  maxOpenPositions: number
  defaultConviction: number
  notes?: string
  addedAt: string

  // ── Signal-pipeline fields (added by Phase 3; optional for back-compat) ───

  /**
   * Which parser strategy to use. Default: 'llm_text'.
   * Set to 'regex_structured' for bot KOLs with fixed-format messages.
   */
  parsingStrategy?: ParserType

  /**
   * Simplified parsing hints stored in the config file.
   * The signal domain enriches this with in-memory FewShotExample objects
   * at load time; those objects are not serialised here.
   */
  parsingHints?: {
    style?: string
    vocabulary?: Record<string, string>
    imagePolicy?: 'required' | 'optional' | 'ignore'
    fieldDefaults?: {
      contractType?: 'perpetual' | 'spot'
      leverage?: number
      side?: 'long' | 'short'
    }
  }

  /** Name of the RegexConfig to use. Required when parsingStrategy === 'regex_structured'. */
  regexConfigName?: string

  /** Per-KOL LLM confidence threshold override [0, 1]. */
  confidenceOverride?: number

  /** Default quote currency appended downstream, e.g. "USDT". */
  defaultSymbolQuote?: string

  /** Whether this KOL primarily trades perpetuals or spot. Default: 'perpetual'. */
  defaultContractType?: 'perpetual' | 'spot'

  /** Aggregator window overrides for this KOL. */
  aggregatorOverrides?: {
    idleTimeoutMs?: number
    maxDurationMs?: number
  }
}

export interface RawEmbed {
  title?: string
  description?: string
  fields: Array<{ name: string; value: string }>
  /** Direct image URL attached to this embed (embed.image.url) */
  image?: string
  /** Thumbnail URL attached to this embed (embed.thumbnail.url) */
  thumbnail?: string
}

export interface RawAttachment {
  url: string
  name: string
  contentType?: string
  width?: number
  height?: number
}

/** Snapshot of the message being replied to. */
export interface RawReference {
  messageId: string
  authorId: string
  authorUsername: string
  /** First 120 chars of the original message content (or empty if image-only). */
  contentSnippet: string
  /** True if the original message had image/file attachments. */
  hasAttachments: boolean
}

/** Serializable snapshot of a Discord message, stripped of discord.js internals. */
export interface RawDiscordMessage {
  messageId: string
  channelId: string
  guildId: string
  authorId: string
  authorUsername: string
  content: string
  embeds: RawEmbed[]
  attachments: RawAttachment[]
  /** Present when this message is a reply to another message. */
  reference?: RawReference
  receivedAt: string
}

/** Discord channel being monitored for trading signals. */
export interface ChannelConfig {
  id: string
  guildId: string
  label: string
  /** Display group name shown in the messages sidebar (e.g. "WWG交易员"). */
  group?: string
  enabled: boolean
  /** Trusted KOL user IDs for this channel. Empty = accept all authors. */
  kolIds: string[]
  /** When true, every message in this channel is sent to the LLM parser. */
  parseAllMessages: boolean
  /**
   * Other channel IDs whose messages should be merged into this channel's view.
   * Useful when a KOL posts entries in one channel and strategy updates in another.
   */
  linkedChannelIds?: string[]
  notes?: string
  addedAt: string
}

export interface GuardEntry {
  type: string
  options: Record<string, unknown>
}

export interface TradingAccountConfig {
  id: string
  label?: string
  type: string
  enabled: boolean
  guards: GuardEntry[]
  brokerConfig: Record<string, unknown>
}

export interface BrokerConfigField {
  name: string
  type: 'text' | 'password' | 'number' | 'boolean' | 'select'
  label: string
  placeholder?: string
  default?: unknown
  required?: boolean
  options?: Array<{ value: string; label: string }>
  description?: string
  sensitive?: boolean
}

export interface BrokerTypeInfo {
  type: string
  name: string
  description: string
  badge: string
  badgeColor: string
  fields: BrokerConfigField[]
  guardCategory: 'crypto' | 'securities'
}

/** Serializable account balance snapshot fetched from the exchange. All numeric values are Decimal strings. */
export interface AccountBalance {
  accountId: string
  baseCurrency: string
  /** Net liquidation value (free cash + mark-to-market position value) */
  netLiquidation: string
  /** Available free cash */
  totalCashValue: string
  unrealizedPnl: string
  realizedPnl: string
  /** Initial margin required (used margin) */
  initMarginReq: string
  fetchedAt: string
}

/** Serializable open position fetched from the exchange. All numeric values are Decimal strings. */
export interface TradePosition {
  symbol: string
  side: 'long' | 'short'
  /** Underlying quantity (contracts × contractSize) */
  quantity: string
  entryPrice: string
  markPrice: string
  marketValue: string
  unrealizedPnl: string
  realizedPnl: string
  currency: string
}

// ── Signal ────────────────────────────────────────────────────────────────────

/**
 * A fully-assembled trading signal, produced by the signal pipeline and
 * forwarded to the risk / approval / execution layers.
 *
 * Invariants:
 * - `symbol` is always the raw KOL spelling — never CCXT-normalised.
 * - All price / quantity / percentage values are Decimal strings.
 * - `confidence` is the LLM's self-assessed extraction quality [0, 1].
 *   RegexParser always sets 1.0 (deterministic match).
 */
export interface Signal {
  /** ULID — globally unique, monotonically sortable. */
  id: string

  source: 'discord'
  channelId: string
  /** Discord snowflake ID of the first message in the originating bundle. */
  messageId: string

  /**
   * For bot KOLs that forward messages from another channel: the Discord
   * message ID embedded in the signal URL, pointing back to the original
   * source message. Subsequent position updates reference this ID via
   * `PositionUpdate.linkedExternalMessageId`, not `Signal.messageId`.
   *
   * Absent for human KOLs (whose `messageId` is already the canonical reference).
   */
  linkedExternalMessageId?: string

  /** ID of the `MessageBundle` that produced this signal. */
  bundleId: string
  kolId: string
  /** Full concatenated text of all messages in the bundle. */
  rawText: string
  /** ISO 8601 — when the pipeline assembled this Signal. */
  parsedAt: string
  parserType: ParserType

  /** Trade intent: open a new position, close an existing one, or modify parameters. */
  action: 'open' | 'close' | 'modify'

  /** 'long' = bullish; 'short' = bearish. Omit for spot-only signals. */
  side?: 'long' | 'short'

  /**
   * Raw symbol exactly as the KOL wrote it.
   * Examples: "BTC", "HYPE", "GENIUS", "ASTEROIOD", "HUSDT".
   * CCXT normalisation ("BTC/USDT:USDT") is the broker layer's responsibility.
   */
  symbol: string

  /** 'spot' for non-margin spot; 'perpetual' for futures/perps. */
  contractType?: 'perpetual' | 'spot'

  entry?: {
    type: 'market' | 'limit'
    /** Single entry price. Decimal string. Absent for market orders. */
    price?: string
    /** Lower bound of an entry price range (e.g. "76640"). Decimal string. */
    priceRangeLow?: string
    /** Upper bound of an entry price range (e.g. "76840"). Decimal string. */
    priceRangeHigh?: string
  }

  stopLoss?: {
    /** Fixed stop-loss price. Decimal string. */
    price?: string
    /** Conditional stop description, e.g. "1H close under 0.0256". */
    condition?: string
  }

  /** Take-profit levels ordered by level number (TP1 = level 1). All prices are Decimal strings. */
  takeProfits?: Array<{
    level: number
    price: string
  }>

  size?: {
    /** 'percent' = % of account equity; 'absolute' = notional in quote currency. */
    type: 'percent' | 'absolute'
    value: string
  }

  /** Leverage multiplier. 1 = no leverage. */
  leverage?: number

  /** KOL's conviction in this setup [0, 1]. From KOL config or signal content. */
  conviction?: number

  /** LLM's confidence in this extraction [0, 1]. RegexParser always 1.0. */
  confidence: number

  /** Which input modalities the extractor used. */
  extractedFrom?: 'text_only' | 'image_only' | 'text_and_image'

  /**
   * Raised when the extractor detects a suspicious price unit mismatch.
   * When `detected: true`, guards force this signal into manual approval.
   */
  unitAnomaly?: {
    detected: boolean
    /** LLM's observation, e.g. "entry 7101 与 TP 0.008138 单位差约 1e6". */
    description: string
  }

  /**
   * Live-market sanity check, attached after extraction. Computed by the
   * price-check layer using a fresh exchange ticker. When the resolution
   * fails (symbol unknown / network) the field is omitted entirely.
   *
   * Used by Phase 4 guards to:
   *  - veto signals whose entry has already been blown past (`stale`)
   *  - flag obvious unit typos (~1000× off from the live price)
   *  - surface the gap on the dashboard for operator awareness
   *
   * All numeric values are Decimal strings.
   */
  priceCheck?: {
    /** Live last-trade price at the moment of check. Decimal string. */
    currentPrice: string
    /** Exchange that returned the price, e.g. "binance". */
    source: string
    /** ISO 8601 — when the quote was fetched. */
    fetchedAt: string
    /**
     * Signed % distance from `currentPrice` to the signal's reference entry
     * (single price, or the centre of a range). Positive = entry is ABOVE
     * the live price; negative = below. Decimal string, e.g. "1.34" or "-0.5".
     * Omitted when no entry price is present on the signal.
     */
    entryDistancePercent?: string
    /**
     * True when the signal's entry has already been crossed in the wrong
     * direction (long: live > entry by more than `staleThresholdPercent`,
     * short: live < entry by more than the threshold). Phase 4 guards
     * typically reject stale signals.
     */
    stale?: boolean
    /**
     * True when entry / SL / TP differ from `currentPrice` by ~3 orders of
     * magnitude or more — a strong "KOL wrote 7.66 meaning 76600" signal.
     * Distinct from the LLM-judged `unitAnomaly` above; this one is computed
     * from the live market price, not from the relationship between fields.
     */
    unitMismatch?: boolean
    /**
     * Free-text description shown on the dashboard / logged for ops.
     * Example: "live 76521, entry 76500 — 0.03% inside; long is fresh"
     */
    note?: string
  }

  notes?: string
  /** LLM chain-of-thought. Stored for prompt-engineering audits only. */
  reasoning?: string
}

// ── PositionUpdate ────────────────────────────────────────────────────────────

/**
 * A structured update to an existing open position, produced by the signal
 * pipeline when the parser returns `kind: 'update'`.
 *
 * `linkedSignalId` is filled by the `UpdateLinker` after the update is parsed.
 * When the linker cannot find a match, the update is discarded with reason
 * 'update_no_link' — it never triggers a trade action.
 *
 * All price / percentage values are Decimal strings.
 */
export interface PositionUpdate {
  /** ULID. */
  id: string

  /** Discord snowflake ID of the update message itself. */
  externalMessageId?: string

  /**
   * Discord messageId extracted from the hyperlink inside bot-format update
   * messages (e.g. `[**BTC**](https://discord.com/channels/…/{msgId})`).
   * Used by the `by_external_id` LinkStrategy.
   */
  linkedExternalMessageId?: string

  /**
   * Filled by the `UpdateLinker` after linking.
   * Undefined when the linker has not yet processed this update, or when
   * linking failed (in which case the update is discarded).
   */
  linkedSignalId?: string

  kolId: string
  /** ISO 8601. */
  receivedAt: string
  source: 'discord'
  channelId: string
  /** ID of the `MessageBundle` that produced this update. */
  bundleId: string
  parserType: ParserType

  /**
   * Raw symbol exactly as the KOL wrote it ("BTC", "HUSDT", etc.).
   * Required for the `by_kol_symbol` LinkStrategy when no external-id
   * back-reference exists (typical of human KOLs).
   *
   * Optional because bot KOLs reference the source signal directly via
   * `linkedExternalMessageId` (DEC-016) and never need symbol-based linking.
   * Both fields can coexist; the linker tries external-id first regardless.
   */
  symbol?: string

  /**
   * Semantic classification of what happened to the position.
   *
   * Only real, actionable update types appear here. Extractor-internal
   * sentinel values ('re_entry_hint', 'other') are intercepted by the parser
   * implementation and converted to a DiscardReason before the PositionUpdate
   * is assembled — they never reach this type.
   */
  updateType:
    | 'limit_filled'    // A limit order was filled / activated
    | 'tp_hit'          // A take-profit level was triggered
    | 'sl_hit'          // Stop loss triggered (closed at a loss)
    | 'breakeven_move'  // Stop moved to entry price
    | 'breakeven_hit'   // The breakeven stop was subsequently hit
    | 'manual_close'    // KOL manually closing (e.g. "Taking TP here at …")
    | 'full_close'      // Entire position closed, explicit announcement
    | 'runner_close'    // Trailing runner portion closed
    | 'stop_modified'   // Stop price changed to a non-breakeven value

  /** TP level that was hit. Only meaningful when updateType === 'tp_hit'. */
  level?: number

  /** Percentage of the position closed in this update. Decimal string, e.g. "50". */
  closedPercent?: string

  /** Percentage of the position still open. Decimal string. */
  remainingPercent?: string

  /** New stop-loss price after a stop_modified or breakeven_move update. Decimal string. */
  newStopLoss?: string

  /** Price at which the KOL reports closing (manual/TP closes). Decimal string. */
  realizedPriceRef?: string

  /** Realised R/R ratio. Signed Decimal string: "1.89" or "-1.00". */
  realizedRR?: string

  /** LLM's confidence [0, 1]. RegexParser always 1.0. */
  confidence: number

  /** Which input modalities were used. */
  extractedFrom?: 'text_only' | 'image_only' | 'text_and_image'

  /** LLM chain-of-thought. Stored for prompt-engineering audits only. */
  reasoning?: string
}

// ── Operation ─────────────────────────────────────────────────────────────────

/**
 * A trade-intent record produced by the copy-trading engine after sizing
 * and guard-checking a `Signal`. Lives on disk in `data/operations/operations.jsonl`
 * and represents the bridge between "what a KOL said" and "what the bot
 * intends to do". It's distinct from the eventual broker order — that
 * comes after approval (Phase 5).
 *
 * Status lifecycle:
 *   pending  → awaiting human approval (default after engine produces it)
 *   approved → human said go; broker order will follow (Phase 5)
 *   rejected → either a guard rejected it OR a human declined approval
 *   executed → broker confirmed the order
 *   failed   → broker rejected (network / margin / price / permission)
 *
 * All numeric values are Decimal strings — never plain JS numbers.
 */
export interface Operation {
  /** ULID, monotonic — stable primary key. */
  id: string

  /** Source signal — every operation traces back to one. */
  signalId: string
  /** Convenience copy of the originating KOL (matches signal.kolId). */
  kolId: string

  /** Trading account this operation targets. References TradingAccountConfig.id. */
  accountId: string

  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed'

  /** ISO 8601 — when the engine produced this operation. */
  createdAt: string

  /**
   * Per-guard verdicts in the order they ran. When a guard rejects, the
   * pipeline short-circuits — but everything that ran is recorded. Used
   * by the dashboard to explain why a signal was/wasn't approved.
   */
  guardResults: Array<{ name: string; passed: boolean; reason?: string }>

  /**
   * Set when status === 'rejected' and the rejection came from a guard
   * (rather than from a human). Empty / undefined for non-rejected
   * statuses or human rejections.
   */
  guardRejection?: { guardName: string; reason: string }

  /** The broker-agnostic intent. See `OperationSpec` discriminant. */
  spec: OperationSpec

  /**
   * Account snapshot used at sizing time, captured for audit. Lets the
   * dashboard show "this operation was sized assuming equity = X" even
   * if the account moves before approval.
   */
  sizingContext?: {
    /** Net liquidation at decision time, decimal string. */
    equity: string
    /** Effective base risk % (after KOL multiplier and signal confidence). */
    effectiveRiskPercent: string
  }
}

/**
 * The actual broker-side intent. Discriminated on `action`. Open trades
 * carry full TP/SL plumbing so a single operation maps to a complete
 * "open position with TPs and SL" group on the exchange.
 *
 * Currently we only emit `placeOrder` from sizing — `closePosition` /
 * `modifyOrder` are reserved for handling `PositionUpdate` entries in
 * a future iteration.
 */
export type OperationSpec =
  | {
      action: 'placeOrder'
      symbol: string
      side: 'long' | 'short'
      contractType: 'perpetual' | 'spot'
      orderType: 'market' | 'limit'
      /** Limit price (decimal string). Absent for market orders. */
      price?: string
      /**
       * Position sizing — discriminated on `unit`:
       *   'percent'   = % of account equity at decision time
       *   'absolute'  = quote-currency notional (e.g. "500" USDT)
       *   'contracts' = exchange-native contract count
       * The position sizer typically emits 'absolute' so size is fixed
       * once the operation is created, immune to subsequent equity drift.
       */
      size: {
        unit: 'percent' | 'absolute' | 'contracts'
        value: string
      }
      leverage?: number
      stopLoss?: { price: string }
      takeProfits?: Array<{ level: number; price: string }>
    }
  | {
      action: 'closePosition'
      symbol: string
      side: 'long' | 'short'
      /** Decimal string. Absent → close entire position. */
      quantity?: string
    }
  | {
      action: 'modifyOrder'
      brokerOrderId: string
      changes: { price?: string; stopLossPrice?: string }
    }

// ── Risk config ───────────────────────────────────────────────────────────────

/**
 * Global risk knobs, edited in the dashboard, persisted to
 * `data/config/risk.json`. Per-KOL adjustments live on `KolConfig`
 * (riskMultiplier, maxOpenPositions); this is the global baseline they
 * scale.
 */
export interface RiskConfig {
  /**
   * Base position size as a % of account equity (NOT a fraction).
   * "1" = 1% of equity. Multiplied by the KOL's riskMultiplier and the
   * signal's confidence to produce the actual sized notional.
   */
  baseRiskPercent: number

  /**
   * Hard ceiling on a single operation's size as a % of equity.
   * Caps any combination of (kol multiplier × signal confidence) that
   * would otherwise overshoot.
   */
  maxOperationSizePercent: number

  /**
   * Symbol whitelist. When non-empty, only signals whose symbol matches
   * (case-insensitive, ignoring quote suffix) are eligible. Empty = no
   * whitelist enforced.
   */
  symbolWhitelist: string[]

  /** Cooldown — minutes between two same-(kol, symbol) operations. */
  cooldownMinutes: number
}
