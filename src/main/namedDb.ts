// namedDb.ts — "is this mob worth camping", answered from the committed roster.
//
// `src/renderer/src/data/eqlegends/named.json` is the wiki's own `Notable NPCs` row per zone,
// era-filtered
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

import { localMobEntry } from './mobLookupLocal'

// THE ROSTER READS MOVED TO shared/namedRoster.ts, because the renderer asks the same question of
// the same committed file (which pins to draw) and a second copy of the zone fold is what broke
// this feature silently once already. Re-exported so main-side callers keep one import.
export { isNamedMob, namedInZone, namedKey, namedRosterSize } from '../shared/namedRoster'

/**
 * DOES THE CATALOG ALREADY KNOW WHERE THIS MOB SPAWNS?
 *
 * MEASURED 2026-08-20 across the in-era roster: 432 of 560 named mobs (77%) carry wiki
 * coordinates, and `MapMobPins` has been drawing them since long before any of this. The 128 that
 * do not split 77 "the page states no numbers" and 51 "the catalog has never heard of this name",
 * the second being the rename problem again (`Commander Windstream`, `Megan`).
 *
 * IT IS THE GATE ON ASKING. The app should never ask a player for a position it already has - the
 * owner pinned a ghoul supplier by hand, three hours before noticing the wiki had placed it 14
 * units away. So the prompt now fires ONLY where the catalog is silent, which turns it from a
 * feature that duplicates the wiki into one that fills its holes.
 *
 * A MISS IS "WE DO NOT KNOW", which is the direction that asks. An unknown name and a page with no
 * numbers are the same answer to the only question being put: is there a pin on the map already?
 */
export function catalogHasCoords(mob: string): boolean {
  const entry = localMobEntry(mob)
  return (entry?.loc?.length ?? 0) > 0
}
