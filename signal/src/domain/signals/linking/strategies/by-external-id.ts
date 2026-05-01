import type { PositionUpdate } from '../../../../../../shared/types.js'
import type { ILinkStrategy, ISignalIndex, LinkResult, LinkStrategy } from '../types.js'

/**
 * `by_external_id` — deterministic link via Discord message IDs.
 *
 * Two lookup paths, in priority order:
 *   1. `update.linkedExternalMessageId` → `index.findByLinkedExternalId`
 *      (DEC-016 — bot KOL path: the update embeds the original source
 *      message ID via the `[SYMBOL](https://discord.com/channels/.../msgId)`
 *      hyperlink, NOT the forwarded-message ID our listener saw.)
 *   2. `update.externalMessageId` → `index.findByExternalId`
 *      (Fallback: the update message itself, used when an update is a
 *      Discord reply or some KOLs paste the parent's snowflake.)
 *
 * When either lookup succeeds, confidence is `'exact'` — these are
 * snowflake matches, never ambiguous.
 *
 * When neither yields a hit, returns `linked: false` and lets the linker
 * try the next strategy (`by_kol_symbol`).
 */
export class ByExternalIdStrategy implements ILinkStrategy {
  readonly name: LinkStrategy = 'by_external_id'

  tryLink(update: PositionUpdate, index: ISignalIndex): LinkResult {
    if (update.linkedExternalMessageId) {
      const hit = index.findByLinkedExternalId(update.linkedExternalMessageId)
      if (hit) return { linked: true, signalId: hit.id, confidence: 'exact' }
    }

    if (update.externalMessageId) {
      const hit = index.findByExternalId(update.externalMessageId)
      if (hit) return { linked: true, signalId: hit.id, confidence: 'exact' }
    }

    return { linked: false, reason: 'no external-id match in open signals' }
  }
}
