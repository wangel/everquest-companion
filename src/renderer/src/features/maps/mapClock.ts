// THE COUNTDOWN, AS THE MAP SAYS IT — WHETHER to draw one, in the app's own words.
//
// THE WORDING IS NOT THIS FILE'S ANY MORE, and that was a real defect rather than untidiness. This
// module used to spell its own `2m 14s` / `due`, which made the map the ONLY surface with a private
// clock vocabulary: `shared/respawn.ts`'s `respawnClockLabel` is where `UP`, `due 5m ago`,
// `due long ago` and `awaiting next death` live, and the Timers tab and the respawn overlay both
// read it. The two disagreed in the way that matters - the Timers tab said `due long ago` for a
// three-hour-old estimate while the pin beside it said a flat `due`, indistinguishable from a mob
// that popped thirty seconds ago. A reporter hit exactly that and read it as a broken clock.
//
// So this file now decides ONE thing: whether the map should say anything at all.
//
// A MAP IS A PLACE-FINDER FIRST (owner's ruling). The orange pin's whole job is "something spawns
// here", and a clock is a second claim laid on top of it. Once that claim has stopped meaning
// anything the clock comes OFF and the pin goes back to being a pin - because the alternative is
// what every zone would look like after a week of play: a screen of `due long ago` with the
// locations buried under it. A stale clock is not information, it is furniture.
//
// So a clock is drawn only while it still says something:
//   * the mob was SEEN — `UP`, the strongest thing the log ever says, and never inferred;
//   * an estimate is running or recently elapsed — `2m 14s`, `due 5m ago`;
// and NOT when the reading is `stale` (the estimate is long gone) or when there is no estimate at
// all (a mob killed once has no gap to learn from - a death→death gap needs two deaths).
//
// `due`, NEVER `spawned` (law 13, and the respawn header states it at length). The estimate
// elapsing is a fact about the ESTIMATE; whether the mob is standing there is something the log
// has not said and this app must not claim.

// RELATIVE, not `@shared/respawn`, for `mobSearch.ts:33`'s stated reason: these are VALUE imports
// and the alias exists only inside the vite build. Spelling the path is what lets the node test
// runner drive this module — and it is driven, because the join below has now been the bug three
// times (a roster keyed on the wiki's zone spelling, a camp keyed on the mob alone, and an
// instance compared raw). The TYPE import keeps the alias; type imports are erased.
import { respawnClockLabel, respawnReading } from '../../../../shared/respawn'
import type { RespawnRow } from '@shared/respawn'
import { zoneKey } from '../mobs/mobZone'
import { fmtDuration } from '../buffs/format'

/**
 * What this pin's clock should read, or null to draw no clock at all.
 *
 * The STRING comes from `respawnClockLabel` — the same call the Timers tab and the respawn overlay
 * make, with the same injected formatter, so a pin and a row can no longer word one reading two
 * ways. What is local is the SILENCE: see the header for why a stale clock comes off the map.
 */
export function mapClockText(row: RespawnRow | undefined, now: number): string | null {
  if (!row) return null
  const reading = respawnReading(row, now)
  // THE ESTIMATE IS LONG GONE. Timers says `due long ago` because a row is a thing you went to
  // read; a pin is a thing you are trying to see past.
  if (reading.stale) return null
  // Nothing to count down and nothing seen — `awaiting next death` is an answer for a list, not a
  // label over a map.
  if (!reading.seen && row.estimateMs === undefined) return null
  return respawnClockLabel(row, now, fmtDuration)
}

/**
 * The watched rows of ONE zone, keyed by the mob name folded for lookup.
 *
 * THE ZONE IS FOLDED THROUGH `zoneKey`, WHICH STRIPS THE INSTANCE, and that was a live bug: the
 * respawn fold files a row under the zone line VERBATIM (`The Ruins of Old Guk 1 (Awakened)`)
 * while the camp fold strips the tier first (`The Ruins of Old Guk`), and this join compared the
 * two strings raw. Standing in any instance therefore produced an EMPTY map - every watched mob
 * drew a bare pin with no countdown, which is exactly what a reporter saw immediately after
 * pressing Watch on the card.
 *
 * STRIPPING IS THE RIGHT DIRECTION, not a convenience: `shared/campPins.ts` already rules that
 * "the tier is a fact about the difficulty, never about the geography", and a MAP is geography.
 * The Timers tab keeps its instance scoping - a list of clocks is a different question from a
 * mark on a room.
 *
 * KEYED BY NAME rather than by the row's canonical `key`, because the far side of this join is the
 * WIKI's catalog name and the near side is what the LOG printed. They agree for most mobs and
 * disagree for the renamed ones (`the ghoul lord` on the wiki, `Hoptor Thaggelum` in the game -
 * namedDb.ts has the measurement), and a rename is knowledge this join cannot invent. A miss shows
 * the pin with no clock, which is the honest half.
 */
export function clocksByName(rows: readonly RespawnRow[], zone: string | null): Map<string, RespawnRow> {
  const out = new Map<string, RespawnRow>()
  if (zone === null) return out
  const want = zoneKey(zone)
  for (const row of rows) {
    if (zoneKey(row.zone) !== want) continue
    out.set(row.display.trim().toLowerCase(), row)
  }
  return out
}
