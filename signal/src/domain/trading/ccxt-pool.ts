import ccxt from 'ccxt'
import type { TradingAccountConfig } from '../../../../shared/types.js'

export type CcxtInstance = {
  loadMarkets: () => Promise<unknown>
  fetchBalance: () => Promise<unknown>
  fetchPositions: () => Promise<unknown[]>
  setSandboxMode: (enabled: boolean) => void
  enableDemoTrading?: (enabled: boolean) => void
  checkRequiredCredentials: () => void
  close?: () => Promise<void>
}

type CcxtExchangeCtor = new (params?: Record<string, unknown>) => CcxtInstance

/**
 * Instantiate a CCXT exchange from a saved TradingAccountConfig.
 * Caller is responsible for calling `close()` when done.
 */
export function createCcxtInstance(config: TradingAccountConfig): CcxtInstance {
  const { brokerConfig } = config
  const exchangeName = brokerConfig.exchange
  if (typeof exchangeName !== 'string' || !exchangeName) {
    throw new Error(`Account "${config.id}": brokerConfig.exchange is required`)
  }

  const exchanges = ccxt as unknown as Record<string, CcxtExchangeCtor>
  const ExchangeClass = exchanges[exchangeName]
  if (!ExchangeClass) {
    throw new Error(`Unknown exchange: ${exchangeName}`)
  }

  const providedOptions =
    brokerConfig.options && typeof brokerConfig.options === 'object'
      ? { ...(brokerConfig.options as Record<string, unknown>) }
      : {}

  // Bitget defaults to spot account queries unless defaultType is set.
  // For this project we primarily care about contract/futures balances and positions.
  if (exchangeName === 'bitget' && providedOptions.defaultType === undefined) {
    providedOptions.defaultType = 'swap'
  }

  const credentials: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(brokerConfig)) {
    if (k === 'exchange' || k === 'sandbox' || k === 'demoTrading' || k === 'options') continue
    if (v !== undefined) credentials[k] = v
  }
  credentials.options = providedOptions

  const instance = new ExchangeClass(credentials)

  if (brokerConfig.sandbox === true) {
    instance.setSandboxMode(true)
  }
  if (brokerConfig.demoTrading === true && typeof instance.enableDemoTrading === 'function') {
    instance.enableDemoTrading(true)
  }

  return instance
}
