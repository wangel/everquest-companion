// namedDb.ts — "is this mob worth camping", answered from the committed roster.
//
// `src/main/data/named.json` is the wiki's own `Notable NPCs` row per zone, era-filtered
// (`scripts/scrape-named.ts` carries how it was gathered and the four discriminators that were
// probed and rejected). This file is the read side and nothing else.
//
// ============================================================================================
// THE ROSTER IS A DISCOVERY AID, NOT AN ORACLE, AND THE MEASUREMENT SAYS SO.
// ============================================================================================
//
// MEASURED against a reporter's 253 MB log (2026-08-20): of the proper-named mobs actually slain,
// the roster matched 56. It missed real nameds — `Gorgalosk`, `Sister of the Spire`,
// `Innoruuk\`s Chosen`, and `Hoptor Thaggelum`, whom the wiki lists under his OLD name `the ghoul
// lord` while the game prints the new one 16,870 times and the old one never.
//
// THAT GAP CANNOT BE CLOSED AUTOMATICALLY, and three attempts are recorded so nobody spends the
// afternoon again: the wiki's `|name` parenthetical carries a rename on 1 page in 543 (and the
// only other parenthetical is a zone disambiguator pointing the opposite way); EQBuddy, a
// hand-curated year of play, records exactly ONE alias — the same ghoul lord; and log-derived
// signals do not separate named from trash at all (kill counts and death-to-death gaps overlap
// almost completely, p90 22186 s against 22721 s, because a gap is the player's delay plus the
// respawn).
//
// SO A MISS IS SILENCE, WHICH IS THE SAFE DIRECTION. A mob the roster does not know simply prompts
// nothing, and the user's own watch list — explicit, opt-in, already built (JOS-194) — is the path
// that needs no data at all. Every mob a player watches by hand is curation the wiki lacked, which
// is the one channel that actually closes the gap.

import namedJson from './data/named.json'
import { zoneShortName } from '../shared/zones'

/** One roster row. `outOfEra` is present only when true; see scripts/scrape-named.ts. */
interface NamedRow {
  name: string
  page?: string
  outOfEra?: boolean
}
interface NamedFile {
  zones: Record<string, NamedRow[]>
}

/**
 * Fold a name or zone for lookup: underscores are wiki markup rather than part of a name (the
 * roster really does carry `Kahaptra_Z\`Taj` where the log prints `Kahaptra Z\`Taj`), whitespace
 * collapses, and case is dirty on both sides (law 2).
 */
export function namedKey(s: string): string {
  return s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * ZONE SHORT NAME → the set of in-era named names in it, both folded. Built once.
 *
 * KEYED BY THE SHORT NAME, NOT THE WIKI'S SPELLING, and that is law 12 rather than tidiness. The
 * roster says `Lower Guk`; the log says `You have entered The Ruins of Old Guk.` They are the same
 * room and disagree by NAME, exactly as `The Ruins of Old Paineel` and `The Hole` do — and
 * `shared/zones.ts` is the hand-authored, evidence-verified table that already knows it. The first
 * cut of this file compared the two strings directly and was therefore silently DEAD in Guk: a
 * replay of a reporter's live log armed 0 prompts across 1,121 deaths, in the zone he was standing
 * in at the time. Both sides now fold through `zoneShortName`, so a zone the table cannot resolve
 * simply has no roster (silence), and one it renames joins correctly.
 */
const byZone = ((): Map<string, Set<string>> => {
  const out = new Map<string, Set<string>>()
  for (const [zone, rows] of Object.entries((namedJson as NamedFile).zones)) {
    const short = zoneShortName(zone)
    if (short === null) continue
    const set = new Set<string>()
    // OUT-OF-ERA ROWS ARE DROPPED HERE rather than at scrape time: the file keeps them because the
    // wiki's verdict is evidence worth committing, and this is the reader that acts on it. A mob
    // the wiki badges Kunark cannot die in this game, so it may never arm a prompt.
    for (const row of rows) if (row.outOfEra !== true) set.add(namedKey(row.name))
    // A short name can be reached by two wiki zones (Upper and Lower Guk are distinct, but a
    // renamed pair is not), so rosters MERGE rather than overwrite.
    if (set.size === 0) continue
    const existing = out.get(short)
    if (existing) for (const n of set) existing.add(n)
    else out.set(short, set)
  }
  return out
})()

/** Does the roster call this mob notable in this zone? False for an unknown zone — silence. */
export function isNamedMob(mob: string, zone: string | undefined): boolean {
  if (zone === undefined || zone === '') return false
  const short = zoneShortName(zone)
  if (short === null) return false
  return byZone.get(short)?.has(namedKey(mob)) ?? false
}

/** The in-era named names the roster knows for a zone, folded. Empty for an unknown zone. */
export function namedInZone(zone: string): ReadonlySet<string> {
  const short = zoneShortName(zone)
  return (short === null ? undefined : byZone.get(short)) ?? new Set<string>()
}

/** How many zones and names the committed roster carries — for the boot log. */
export function namedRosterSize(): { zones: number; names: number } {
  let names = 0
  for (const set of byZone.values()) names += set.size
  return { zones: byZone.size, names }
}
