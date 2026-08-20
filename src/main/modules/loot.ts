// loot module — the self-loot history. Wraps the pure loot fold from reducers.ts
// (a LootEvent tagged with the zone it happened in). Delta = the rows appended
// since the last flush; the renderer concats them.
//
// IT CARRIES THE DESTROY UNCHANGED (JOS-401, the census). `disposition: 'destroyed'` rides the
// same row shape, the same append-only history, the same delta — which is the whole reason the
// destroy was given a disposition instead of an event kind of its own. This module takes NO
// position on what it means; `shared/lootDisposition.ts` is where each reader states one. The zone
// tag rides along too and is honest: a destroy happens somewhere, even though it names no mob.

import type { EqModule } from './types'
import type { LogEvent } from '../../shared/logEvents'
import type { LootDelta, LootEvent, LootSnap } from '../../shared/types'
import { mergeRows } from '../../shared/logHistory'

export class LootModule implements EqModule<LootSnap, LootDelta> {
  readonly id = 'loot'
  private loot: LootEvent[] = []
  /**
   * Rows from logs that have been ARCHIVED away (shared/logHistory.ts). Held apart from `loot` on
   * purpose: `snapshot()` serves the two merged so the tab shows a whole history, while
   * `liveRows()` serves `loot` alone so the persisted `live` bucket describes only the bytes the
   * next fold will read again. Writing the merged view into that bucket is the JOS-231 defect - a
   * rotation would promote it and every archived row would be recorded a second time.
   */
  private archived: LootEvent[] = []
  private zone: string | undefined
  private seq = 0
  private pending: LootEvent[] = []

  /** Seed the rows recovered from archived logs. Set once at wiring, before the fold. */
  setArchived(rows: readonly LootEvent[]): void {
    this.archived = [...rows]
  }

  /** ONLY what this session's fold produced - what the persisted `live` bucket must contain. */
  liveRows(): LootEvent[] {
    return this.loot
  }

  reset(): void {
    this.loot = []
    this.zone = undefined
    this.seq = 0
    this.pending = []
  }

  onEvent(ev: LogEvent): void {
    this.seq = ev.seq
    if (ev.kind === 'epoch') {
      // Character rebirth (Task #49): loot before the boundary is a dead same-name
      // character's. Clear the history so held-count / quest-progress derivation sees only
      // the current character. Keep `zone` (world state, not character-scoped — the next
      // zone line refreshes it regardless).
      this.loot = []
      this.pending = []
      // …AND the archived rows, for the same reason: a rebirth disowns everything before the
      // boundary regardless of which log it was read out of. The persisted buckets are not purged
      // from here (a module cannot write the store) - the next `setLiveBucket` records the empty
      // live bucket, and a stale archive bucket is re-seeded next launch. Stated rather than
      // hidden; the epoch is a fixed past instant (official launch), so this is a guard, not a path.
      this.archived = []
      return
    }
    if (ev.kind === 'zone') {
      this.zone = ev.zone
      return
    }
    if (ev.kind !== 'loot') return
    const row: LootEvent = {
      ts: ev.ts,
      item: ev.item,
      source: ev.source,
      zone: this.zone,
      disposition: ev.disposition,
      count: ev.count,
      created: ev.created
    }
    this.loot.push(row)
    this.pending.push(row)
  }

  snapshot(): { seq: number; state: LootSnap } {
    return { seq: this.seq, state: mergeRows([this.archived, this.loot]) }
  }

  flushDelta(): { seq: number; delta: LootDelta } | null {
    if (this.pending.length === 0) return null
    const delta: LootDelta = { appended: this.pending }
    this.pending = []
    return { seq: this.seq, delta }
  }
}
