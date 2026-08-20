// leveling module — level-ups + AA gains + AA spends + AA-potion quaffs in log order. All
// four are append-only; the delta carries whatever was appended to each since the last
// flush and the renderer concats each array. (The unspent/net-spent math the view
// does depends on log order, which append-only concat preserves.)
//
// THE POTION IS NOT PERSISTED and deliberately so: the quaff is a LOG LINE, so a relaunch
// replays it and re-derives the charge state exactly. A copy in the store would be a second
// source of truth that could disagree with the log after a rescan or an epoch.

import type { EqModule } from './types'
import type { LogEvent } from '../../shared/logEvents'
import type {
  AAEvent,
  AAPotionEvent,
  AASpendEvent,
  LevelEvent,
  LevelingDelta,
  LevelingSnap
} from '../../shared/types'
import { mergeRows } from '../../shared/logHistory'

export class LevelingModule implements EqModule<LevelingSnap, LevelingDelta> {
  readonly id = 'leveling'
  private levels: LevelEvent[] = []
  private aaGains: AAEvent[] = []
  private aaSpends: AASpendEvent[] = []
  private aaPotions: AAPotionEvent[] = []
  /**
   * The four ledgers as they stood in logs that have been ARCHIVED away (shared/logHistory.ts).
   * Held apart from the live arrays for the reason loot.ts states: `snapshot()` serves them merged
   * so the tab shows a whole history, `liveSnap()` serves the live arrays alone so the persisted
   * `live` bucket describes only bytes the next fold will read again.
   */
  private archived: LevelingSnap = { levels: [], aaGains: [], aaSpends: [], aaPotions: [] }
  private seq = 0
  private pLevels: LevelEvent[] = []
  private pGains: AAEvent[] = []
  private pSpends: AASpendEvent[] = []
  private pPotions: AAPotionEvent[] = []

  /** Seed the ledgers recovered from archived logs. Set once at wiring, before the fold. */
  setArchived(snap: LevelingSnap): void {
    this.archived = {
      levels: [...snap.levels],
      aaGains: [...snap.aaGains],
      aaSpends: [...snap.aaSpends],
      aaPotions: [...snap.aaPotions]
    }
  }

  /** ONLY what this session's fold produced - what the persisted `live` bucket must contain. */
  liveSnap(): LevelingSnap {
    return {
      levels: this.levels,
      aaGains: this.aaGains,
      aaSpends: this.aaSpends,
      aaPotions: this.aaPotions
    }
  }

  reset(): void {
    this.levels = []
    this.aaGains = []
    this.aaSpends = []
    this.aaPotions = []
    this.seq = 0
    this.pLevels = []
    this.pGains = []
    this.pSpends = []
    this.pPotions = []
  }

  onEvent(ev: LogEvent): void {
    this.seq = ev.seq
    switch (ev.kind) {
      case 'epoch':
        // Character rebirth (Task #49): the prior epoch's levels/AA belong to a dead
        // same-name character. Drop them so the AA identity (allocated/unspent/earned) and
        // the level timeline reflect ONLY the current character. Pending deltas are cleared
        // too — during a rescan this happens mid-replay (no deltas push); on a live wipe the
        // renderer re-hydrates from the post-epoch snapshot (index.ts re-sends onCharacter).
        this.levels = []
        this.aaGains = []
        this.aaSpends = []
        this.aaPotions = []
        // …and the archived ledgers too: a rebirth disowns everything before the boundary,
        // whichever log it was read out of (loot.ts carries the same guard and the same note).
        this.archived = { levels: [], aaGains: [], aaSpends: [], aaPotions: [] }
        this.pLevels = []
        this.pGains = []
        this.pSpends = []
        this.pPotions = []
        return
      case 'level': {
        const e: LevelEvent = { ts: ev.ts, level: ev.level }
        this.levels.push(e)
        this.pLevels.push(e)
        return
      }
      case 'aaGain': {
        const e: AAEvent = { ts: ev.ts, amount: ev.amount, nowHave: ev.nowHave }
        this.aaGains.push(e)
        this.pGains.push(e)
        return
      }
      case 'aaSpend': {
        const e: AASpendEvent = { ts: ev.ts, ability: ev.ability, cost: ev.cost, rank: ev.rank }
        this.aaSpends.push(e)
        this.pSpends.push(e)
        return
      }
      case 'aaPotion': {
        const e: AAPotionEvent = { ts: ev.ts }
        this.aaPotions.push(e)
        this.pPotions.push(e)
        return
      }
      default:
        return
    }
  }

  snapshot(): { seq: number; state: LevelingSnap } {
    return {
      seq: this.seq,
      state: {
        levels: mergeRows([this.archived.levels, this.levels]),
        aaGains: mergeRows([this.archived.aaGains, this.aaGains]),
        aaSpends: mergeRows([this.archived.aaSpends, this.aaSpends]),
        aaPotions: mergeRows([this.archived.aaPotions, this.aaPotions])
      }
    }
  }

  flushDelta(): { seq: number; delta: LevelingDelta } | null {
    if (
      this.pLevels.length === 0 &&
      this.pGains.length === 0 &&
      this.pSpends.length === 0 &&
      this.pPotions.length === 0
    ) {
      return null
    }
    const delta: LevelingDelta = {
      levels: this.pLevels,
      aaGains: this.pGains,
      aaSpends: this.pSpends,
      aaPotions: this.pPotions
    }
    this.pLevels = []
    this.pGains = []
    this.pSpends = []
    this.pPotions = []
    return { seq: this.seq, delta }
  }
}
