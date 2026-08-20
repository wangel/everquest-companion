// The pure reducer core for the log-derived kill tracker. Historically this file
// held a monolithic reduceEvent() that folded every feature (loot/turnins/kills/
// levels/AA) into one LogStore. That fold now lives per-feature in the extension
// modules (src/main/modules/*), which each own their slice and expose it over the
// generic module transport. What remains here is the shared, unit-testable kill
// logic the kills module reuses — so the "counts as a kill" filter has exactly
// one definition. Keep this pure and side-effect-free.

import type { LogEvent } from '../../shared/logEvents'
import { killTotals, type KillMap } from '../../shared/kills'

/**
 * YOUR OWN PET, DYING - which is not a mob and never was a kill.
 *
 * EverQuest names a summoned pet after its owner and prints it that way on the slain line, so a
 * pet death reads as an ordinary mob death and was counted as one: 16 of them in one reporter's
 * log, after which the pet sat in the Timers tab's kill history offering a respawn clock on a mob
 * that does not exist.
 *
 * THIS IS NOT A GUESS ABOUT THE NAME'S SHAPE. The possessive is only ever matched against the name
 * the app KNOWS is the player's, injected at `resetWorldFor` by the same path and at the same
 * instant the parser and the group roster learn it (session.ts). No EverQuest mob is named after
 * your character, so this cannot catch one. Somebody ELSE's pet stays counted - that death did
 * happen in the world, and this filter is not the place to hold an opinion about it.
 *
 * Both apostrophes, because the game writes a backtick and everything else writes a straight
 * quote (shared/namedRoster.ts fought the same fight one join over).
 */
export function isOwnPetDeath(name: string, selfName: string | undefined): boolean {
  if (selfName === undefined) return false
  const self = selfName.trim().toLowerCase()
  if (self === '') return false
  const n = name.trim().toLowerCase()
  return n.startsWith(self + '`s ') || n.startsWith(self + "'s ")
}

/**
 * Whether a `death` event counts as a kill for the kills tracker. Self-slain
 * always counts; slain-by counts only when the killer isn't you. (Same filter the
 * legacy reduceEvent used.)
 *
 * `selfName` is the active character and is OPTIONAL: a caller that has not been told behaves
 * exactly as this function always did, so the filter can never silently strengthen underneath a
 * module with no owner installed. See `isOwnPetDeath` for what passing it buys.
 */
export function isCountedKill(
  ev: Extract<LogEvent, { kind: 'death' }>,
  selfName?: string
): boolean {
  if (!ev.bySelf && ev.killer && /^you\b/i.test(ev.killer)) return false
  if (isOwnPetDeath(ev.name, selfName)) return false
  return true
}

/** One counted kill, as `recordKill` folds it. */
export interface KillRecord {
  /** the CANONICAL (lowercase) mob name — the map key. */
  key: string
  /** the raw slain-line name, kept for the UI. */
  display: string
  tier: number
  ts: number
  /**
   * Did this kill pay YOU experience — i.e. did an exp line land in the join window before it
   * (shared/kills.ts KILL_EXP_JOIN_MS)? Counted separately from `count` on the tier run, never
   * instead of it: an open-world kill by a stranger is still a kill of that mob, it is simply
   * not one of yours. See KillTierRun.credited.
   */
  credited: boolean
}

/**
 * Fold a counted kill into a KillMap in place. Pure; used by the kills module.
 * Keying by the canonical name folds the two casings EQ emits (sentence-start
 * "A froglok…" vs mid-sentence "a froglok…") into a single entry; the display is
 * set once, from the first-seen kill.
 *
 * THE FOLD WRITES ONE THING: the per-tier run (`tiers[tier]`). The four scalars are then
 * re-derived from the whole map by `killTotals`, never incremented alongside it — that is
 * what keeps "bestTier" and "lastTs" from describing two different kills, which is exactly
 * the misattribution this shape replaced (see shared/kills.ts).
 */
export function recordKill(kills: KillMap, kill: KillRecord): void {
  const { key, display, tier, ts, credited } = kill
  const k = (kills[key] ??= {
    count: 0,
    bestTier: 0,
    firstTs: 0,
    lastTs: 0,
    credited: 0,
    display,
    tiers: {}
  })
  const run = (k.tiers[tier] ??= {
    count: 0,
    firstTs: ts,
    lastTs: ts,
    credited: 0,
    lastCreditedTs: 0
  })
  run.count += 1
  run.firstTs = Math.min(run.firstTs, ts)
  run.lastTs = Math.max(run.lastTs, ts)
  if (credited) {
    run.credited += 1
    // A max, not an assignment: a replay is chronological, but a fold must not depend on that
    // (addTierRun unions runs from several roster `match` names, in no particular order).
    run.lastCreditedTs = Math.max(run.lastCreditedTs, ts)
  }
  Object.assign(k, killTotals(k.tiers))
}
