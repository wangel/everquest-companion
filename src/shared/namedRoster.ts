// shared/namedRoster.ts — WHICH MOBS THE WIKI CALLS NOTABLE, read by both processes.
//
// The data is `renderer/src/data/eqlegends/named.json`, beside the mob catalog and gathered by
// `scripts/scrape-named.ts` (that file carries how, and the four discriminators that were probed
// and rejected). This is the read side.
//
// IT LIVES IN SHARED BECAUSE BOTH SIDES ASK. Main asks "should this kill raise a question"; the
// renderer asks "should this pin be drawn". One committed file, one fold, one answer - and the fold
// is the part that must not be duplicated: two spellings of a join key is precisely what silently
// broke the roster in Guk (the log says `The Ruins of Old Guk`, the roster says `Lower Guk`) and
// what law 12 exists to forbid.

import namedJson from '../renderer/src/data/eqlegends/named.json'
import { zoneShortName, zoneShortNameFromCatalog } from './zones'

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
  return s
    .replace(/_/g, ' ')
    // ONE APOSTROPHE. EQ writes a BACKTICK in names the wiki renders with a straight quote, and a
    // copy-paste through a browser can leave a curly one: the log says `King Thex\`Ka IV`, the
    // roster says `King Thex'Ka IV`, and they are the same goblin king. This is the same class of
    // dirt as the underscore above (law 2) - one glyph, three authorities - and no two EverQuest
    // mobs are distinguished by which apostrophe they use, so folding them cannot merge two mobs.
    .replace(/[`‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * A trailing `(...)` on a roster name, which the WIKI adds and the GAME never prints.
 *
 * These are page-title disambiguators, not part of the mob's name: two zones both have a mob
 * called `a reanimated hand`, so the wiki titles the pages `A reanimated hand (Lower Guk)` and
 * `A reanimated hand (Unrest)` and the notable-NPC list links them by that title. `(NPC)` is the
 * same device separating a character from the zone or item that shares his name.
 */
const DISAMBIGUATOR_RE = /\s*\([^()]*\)\s*$/

/**
 * Every spelling a roster row should answer to, folded. Usually one; two when the wiki's title
 * carries a disambiguator.
 *
 * BOTH ARE KEPT, never just the stripped one. The parenthetical is evidence — it is what the wiki
 * actually said — and a mob whose real name ends in brackets would be deleted by a blind strip.
 * Adding the bare spelling only ever makes the roster answer to MORE of what the log prints.
 *
 * MEASURED, 2026-08-20: 9 of the 1,085 roster rows carry one, and every one of them was invisible
 * to both callers — `a reanimated hand` died in Lower Guk with the catalog holding its
 * coordinates, and the map drew no pin because the roster was asked about a name the log does not
 * use. Law 12: this is a rename the SOURCE states, not a fuzzy match.
 */
export function rosterSpellings(name: string): string[] {
  const full = namedKey(name)
  const bare = namedKey(name.replace(DISAMBIGUATOR_RE, ''))
  return bare !== '' && bare !== full ? [full, bare] : [full]
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
/**
 * The folded spellings of one zone's IN-ERA rows.
 *
 * OUT-OF-ERA ROWS ARE DROPPED HERE rather than at scrape time: the file keeps them because the
 * wiki's verdict is evidence worth committing, and this is the reader that acts on it. A mob the
 * wiki badges Kunark cannot die in this game, so it may never arm a prompt or draw a pin.
 */
function inEraSpellings(rows: readonly NamedRow[]): Set<string> {
  const set = new Set<string>()
  for (const row of rows) {
    if (row.outOfEra === true) continue
    for (const n of rosterSpellings(row.name)) set.add(n)
  }
  return set
}

const byZone = ((): Map<string, Set<string>> => {
  const out = new Map<string, Set<string>>()
  for (const [zone, rows] of Object.entries((namedJson as NamedFile).zones)) {
    // THE CATALOG INDEX, NOT THE LOG ONE, because a roster key is a WIKI PAGE TITLE — the same
    // naming authority `mobCatalogNames` already records, and a different one from what the log
    // prints. `zoneShortNameFromCatalog` is seeded from the log-side index, so it resolves
    // everything `zoneShortName` does and nine zones besides. MEASURED 2026-08-20: folding the
    // build side through the log index silently dropped THREE whole rosters — `Permafrost` (13
    // in-era nameds) and `Runnyeye` (8), which the table knows only as `Permafrost Keep` and
    // `Clan RunnyEye`, plus all-Kunark `Dalnir`. The QUERY side below still folds through
    // `zoneShortName`, because what it is handed is a zone the LOG printed; widening that inlet
    // to admit wiki abbreviations is what zones.ts refuses at length.
    const short = zoneShortNameFromCatalog(zone)
    if (short === null) continue
    const set = inEraSpellings(rows)
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
