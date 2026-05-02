import type {
  AccountBalance,
  KolConfig,
  Operation,
  Signal,
  TradePosition,
} from '../../../../../shared/types.js'
import type { GuardContext } from '../guards/types.js'

export function makeSignal(over: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-1',
    source: 'discord',
    channelId: 'ch-1',
    messageId: 'msg-1',
    bundleId: 'bundle-1',
    kolId: 'kol-A',
    rawText: 'BTC long 76500',
    parsedAt: '2026-05-02T10:00:00.000Z',
    parserType: 'llm_text',
    action: 'open',
    symbol: 'BTC',
    side: 'long',
    contractType: 'perpetual',
    confidence: 0.9,
    entry: { type: 'limit', price: '76500' },
    stopLoss: { price: '75500' },
    takeProfits: [{ level: 1, price: '78000' }],
    leverage: 10,
    ...over,
  }
}

export function makeKol(over: Partial<KolConfig> = {}): KolConfig {
  return {
    id: 'kol-A',
    label: 'Test KOL',
    enabled: true,
    riskMultiplier: 1,
    maxOpenPositions: 3,
    defaultConviction: 0.7,
    addedAt: '2026-01-01T00:00:00.000Z',
    parsingStrategy: 'llm_text',
    parsingHints: { style: 'test' },
    ...over,
  }
}

export function makeAccount(over: Partial<AccountBalance> = {}): AccountBalance {
  return {
    accountId: 'acct-1',
    baseCurrency: 'USDT',
    netLiquidation: '10000',
    totalCashValue: '8000',
    unrealizedPnl: '0',
    realizedPnl: '0',
    initMarginReq: '0',
    fetchedAt: '2026-05-02T10:00:00.000Z',
    ...over,
  }
}

export function makeOperation(over: Partial<Operation> = {}): Operation {
  return {
    id: 'op-1',
    signalId: 'sig-1',
    kolId: 'kol-A',
    accountId: 'acct-1',
    status: 'pending',
    createdAt: '2026-05-02T10:00:00.000Z',
    guardResults: [],
    spec: {
      action: 'placeOrder',
      symbol: 'BTC',
      side: 'long',
      contractType: 'perpetual',
      orderType: 'limit',
      price: '76500',
      size: { unit: 'absolute', value: '90' },
      leverage: 10,
      stopLoss: { price: '75500' },
      takeProfits: [{ level: 1, price: '78000' }],
    },
    ...over,
  }
}

export function makeCtx(over: Partial<GuardContext> = {}): GuardContext {
  return {
    operation: makeOperation(),
    signal: makeSignal(),
    kol: makeKol(),
    account: makeAccount(),
    positions: [],
    pendingForSameKol: [],
    now: new Date('2026-05-02T10:00:00.000Z'),
    ...over,
  } as GuardContext
}

export function makePosition(over: Partial<TradePosition> = {}): TradePosition {
  return {
    symbol: 'BTC',
    side: 'long',
    quantity: '0.01',
    entryPrice: '76500',
    markPrice: '76600',
    marketValue: '766',
    unrealizedPnl: '1',
    realizedPnl: '0',
    currency: 'USDT',
    ...over,
  }
}
