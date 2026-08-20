// THE COUNTDOWN, AS THE MAP SAYS IT — one spelling for every mark on the surface.
//
// Two layers draw a clock now (the wiki pin for a watched mob, and a camp you pinned yourself), and
// a third would be along eventually. `respawnReading` in shared/respawn.ts is where a countdown is
// DERIVED and stays there; this is only how the derived number is worded, kept in one place for the
// reason the Timers tab and the respawn overlay already share theirs: two spellings of `2m 14s` is
// two answers to the question the whole feature exists to answer.
//
// `due`, NEVER `spawned` (law 13, and the respawn header states it at length). The estimate
// elapsing is a fact about the ESTIMATE; whether the mob is standing there is something the log
// has not said and this app must not claim.
//
// NULL WHEN THERE IS NO ESTIMATE, so a caller falls back to the name alone. A mob killed once has
// no gap to learn from - a death-to-death gap needs two deaths - and inventing a time or hiding the
// mark are both worse than saying what is known and nothing else.

import { respawnReading, type RespawnRow } from '@shared/respawn'

/** `2m 14s`, `47s`, or `due`. Null when the row has no estimate to count down. */
export function mapClockText(row: RespawnRow | undefined, now: number): string | null {
  if (!row) return null
  const reading = respawnReading(row, now)
  if (reading.remainingMs === undefined) return null
  if (reading.due) return 'due'
  const secs = Math.ceil(reading.remainingMs / 1000)
  const mins = Math.floor(secs / 60)
  return mins > 0 ? `${String(mins)}m ${String(secs % 60)}s` : `${String(secs)}s`
}

/**
 * The watched rows of ONE zone, keyed by the mob name folded for lookup.
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
  const want = zone.trim().toLowerCase()
  for (const row of rows) {
    if (row.zone.trim().toLowerCase() !== want) continue
    out.set(row.display.trim().toLowerCase(), row)
  }
  return out
}
