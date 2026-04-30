import type { KolConfig } from '../../../../../shared/types.js'
import type { RawMessage } from '../types.js'

let seq = 0

/** Build a minimal valid KolConfig for testing. */
export function makeKolConfig(overrides: Partial<KolConfig> = {}): KolConfig {
  seq++
  return {
    id: `kol-${seq}`,
    label: `Test KOL ${seq}`,
    enabled: true,
    riskMultiplier: 1,
    maxOpenPositions: 5,
    defaultConviction: 0.8,
    addedAt: new Date().toISOString(),
    ...overrides,
  }
}

/** Build a minimal valid RawMessage for testing. */
export function makeMessage(overrides: Partial<RawMessage> = {}): RawMessage {
  seq++
  return {
    messageId: `msg-${seq}`,
    eventType: 'create',
    timestamp: new Date().toISOString(),
    channelId: 'ch-test',
    authorId: 'kol-alpha',
    content: 'LONG BTC entry 93000 TP 96000 SL 91500',
    embeds: [],
    attachments: [],
    ...overrides,
  }
}

export function resetSeq(): void {
  seq = 0
}
