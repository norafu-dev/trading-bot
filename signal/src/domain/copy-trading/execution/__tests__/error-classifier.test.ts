import * as ccxt from 'ccxt'
import { describe, expect, it } from 'vitest'
import { classifyError } from '../error-classifier.js'

describe('classifyError', () => {
  it('classifies AuthenticationError as auth (not retriable)', () => {
    const err = new ccxt.AuthenticationError('bad signature')
    const c = classifyError(err)
    expect(c.category).toBe('auth')
    expect(c.retriable).toBe(false)
    expect(c.message).toContain('认证失败')
  })

  it('classifies InsufficientFunds as insufficient (not retriable)', () => {
    const err = new ccxt.InsufficientFunds('not enough USDT')
    const c = classifyError(err)
    expect(c.category).toBe('insufficient')
    expect(c.retriable).toBe(false)
  })

  it('classifies InvalidOrder as invalid-order (not retriable)', () => {
    const err = new ccxt.InvalidOrder('quantity below min lot')
    const c = classifyError(err)
    expect(c.category).toBe('invalid-order')
    expect(c.retriable).toBe(false)
    expect(c.message).toContain('quantity below min lot')
  })

  it('classifies BadSymbol as invalid-order', () => {
    const err = new ccxt.BadSymbol('symbol not listed')
    const c = classifyError(err)
    expect(c.category).toBe('invalid-order')
  })

  it('classifies RateLimitExceeded as rate-limit (retriable)', () => {
    const err = new ccxt.RateLimitExceeded('429')
    const c = classifyError(err)
    expect(c.category).toBe('rate-limit')
    expect(c.retriable).toBe(true)
  })

  it('classifies NetworkError as network (retriable)', () => {
    const err = new ccxt.NetworkError('socket hang up')
    const c = classifyError(err)
    expect(c.category).toBe('network')
    expect(c.retriable).toBe(true)
  })

  it('classifies generic ExchangeError as exchange (not retriable)', () => {
    const err = new ccxt.ExchangeError('order modification not allowed')
    const c = classifyError(err)
    expect(c.category).toBe('exchange')
    expect(c.retriable).toBe(false)
  })

  it('falls back to network for unwrapped fetch errors', () => {
    const err = new Error('fetch failed')
    expect(classifyError(err).category).toBe('network')
    expect(classifyError(new Error('ETIMEDOUT')).category).toBe('network')
    expect(classifyError(new Error('ECONNRESET')).category).toBe('network')
  })

  it('falls back to rate-limit on string match', () => {
    expect(classifyError(new Error('Too many requests')).category).toBe('rate-limit')
    expect(classifyError(new Error('HTTP 429')).category).toBe('rate-limit')
  })

  it('classifies anything else as unknown (not retriable)', () => {
    const c = classifyError(new Error('weird thing happened'))
    expect(c.category).toBe('unknown')
    expect(c.retriable).toBe(false)
  })

  it('truncates very long messages', () => {
    const long = 'a'.repeat(500)
    const c = classifyError(new Error(long))
    expect(c.message.length).toBeLessThanOrEqual(220)
    expect(c.message).toContain('…')
  })

  it('handles non-Error thrown values', () => {
    const c = classifyError('string error')
    expect(c.category).toBe('unknown')
    expect(c.message).toContain('string error')
  })
})
