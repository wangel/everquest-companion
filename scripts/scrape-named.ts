/**
 * WHICH MOBS ARE WORTH CAMPING — the `Notable NPCs` row off every zone page.
 *
 *   npm run scrape:named                 # one request per zone in the mob catalog
 *   npm run scrape:named -- --zones "Lower Guk,Befallen"   # a subset, for checking a shape
 *
 * WHY THIS EXISTS. Nothing this app already ships says which mobs are NAMED. `mobs.json` carries
 * 7,872 rows with zones, levels, drops and 6,304 sets of coordinates, and not one field that
 * separates `the ghoul lord` from `a froglok shin knight`. Without that separation a "a named you
 * camp just died" feature either says nothing or fires on every trash pull.
 *
 * ============================================================================================
 * WHY THE ZONE PAGE, AND NOT ANY OF THE FOUR THINGS THAT LOOK LIKE THEY WOULD WORK.
 * ============================================================================================
 *
 * All four were probed against the live wiki (2026-08-20) before this file was written, and all
 * four are dead ends. They are listed because each one looks obviously correct until measured:
 *
 *   * `Category:Named Mobs` — on TRASH too. `A bok ghoul knight` and `A frenzied ghoul` carry it
 *     exactly as `The Ghoul Lord` does.
 *   * `Template:Namedmobpage` — likewise, every mob page uses it. `list=embeddedin` on it also
 *     returns quest pages, which transclude mob pages.
 *   * The spawn PERCENTAGE already in `mobs.json` — trash has one. `a frenzied ghoul` is 100%,
 *     `a dar ghoul knight` is 50%. It marks a spawn POINT, not a named.
 *   * The `a`/`an` name prefix, the classic EQ convention — worthless here. Of Lower Guk's 25
 *     notable NPCs, most begin with `a` (`a froglok noble`, `a ghoul assassin`), and this repo
 *     forbids a matcher over spelling anyway (law 12).
 *
 * What DOES separate them is the wiki's own editorial judgement, published as a row in the zone
 * infobox. On Lower Guk it names 25 mobs and omits the 32 clan-name frogloks, which is exactly the
 * split a player would draw by hand.
 *
 * IT IS NOT A HEADING AND IT IS NOT IN THE WIKITEXT. Two false starts worth writing down so the
 * next reader does not repeat them. The zone page's wikitext contains only
 * `{{Special:DynamicZoneList/<zone>}}` — the roster is generated when the page RENDERS, so this
 * scrape asks for `prop=text` rather than `prop=wikitext`. And in that rendered HTML the row is a
 * table header cell (`<th>Notable NPCs:</th>`), NOT an `<h2>`; a scan of h1-h4 finds nothing.
 *
 * COVERAGE IS PARTIAL, AND THE HOLES ARE MOSTLY CORRECT. Measured over the 30 busiest zones in the
 * catalog: 15 have the row. Twelve of the fifteen misses are CITIES (South Qeynos, Ak'Anon, the
 * Freeports, Thurgadin...), where "notable NPC" means a guildmaster and a camp means nothing. Of
 * the three that are not cities, Skyshrine and Chardok are VELIOUS and KUNARK content that is not
 * in EQ Legends yet, and Western Plains of Karana is open outdoors. So the honest reading is that
 * coverage of in-era dungeons is close to complete, and a zone with no row yields no rows here
 * rather than a guess.
 *
 * A ZONE WITH NO ROW IS SILENCE, NEVER AN INFERENCE. Nothing in this script falls back to a
 * heuristic when the row is missing (see the four dead ends above for what such a fallback would
 * have to be). The consumer gets no named list for that zone, and the user's own watch list is
 * still the manual path — the same conservative direction JOS-194 chose for respawn clocks.
 *
 * THE PAGE TITLE RIDES ALONG because the link target is the mob's canonical page and the link TEXT
 * is what the log prints. They agree far more often than not (4 disagreements in 167 across the
 * sample, two of them RED LINKS for pages that do not exist), so this is not the rename channel —
 * that lives in the mob page's own `| name =` field and is a different scrape. It is kept because
 * a page title is the only stable join key back to `mobs.json` when two zones name a mob alike.
 *
 * Scraper etiquette (AGENTS.md LAW): one serialized request at a time, 110 ms between them,
 * exponential backoff honouring Retry-After on 429/5xx. Output is sorted by zone and by name, so a
 * re-scrape produces a clean diff. There is deliberately no disk cache: the whole run is one
 * request per zone (~190, the same order as `scrape:respawns`' 158) and a cached copy of rendered
 * HTML would be megabytes of a thing we extract twenty links from.
 */
import { readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import type { MobData } from '../src/shared/types'
import { parseNotableNpcs, type NamedRow } from './sources/notableNpcs'

const API = 'https://eqlwiki.com/api.php'
const UA = 'everquest-companion/0.1 (personal quest tracker)'
const DELAY_MS = 110
const MAX_RETRIES = 5

const HERE = dirname(fileURLToPath(import.meta.url))
const MOBS_PATH = resolve(HERE, '../src/renderer/src/data/eqlegends/mobs.json')
const OUT_PATH = resolve(HERE, '../src/main/data/named.json')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** One serialized GET with exponential backoff on 429/5xx (honours Retry-After). */
async function api<T>(params: Record<string, string>): Promise<T> {
  const url = `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params }).toString()}`
  let wait = 1000
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA } })
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err
      await sleep(wait)
      wait *= 2
      continue
    }
    if (res.ok) {
      await sleep(DELAY_MS)
      return (await res.json()) as T
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after'))
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : wait)
      wait *= 2
      continue
    }
    throw new Error(`${res.status} ${res.statusText}`)
  }
}

/** The committed output: wiki zone name → its notable NPCs, both sorted. */
interface NamedData {
  source: string
  scrapedAt: string
  zoneCount: number
  namedCount: number
  zones: Record<string, NamedRow[]>
}

/** The slice of `action=parse` this script reads. */
interface ParseReply {
  parse?: { text?: string }
  error?: { code?: string }
}

/** Every distinct zone the mob catalog names — wiki spellings by construction. */
function zonesFromCatalog(): string[] {
  const mobs = JSON.parse(readFileSync(MOBS_PATH, 'utf8')) as MobData
  const seen = new Set<string>()
  for (const mob of mobs.mobs) for (const zone of mob.zones ?? []) seen.add(zone)
  return [...seen].sort()
}

async function main(): Promise<void> {
  const only = process.argv.indexOf('--zones')
  const zones =
    only >= 0 && process.argv[only + 1]
      ? process.argv[only + 1].split(',').map((z) => z.trim()).filter(Boolean)
      : zonesFromCatalog()

  const out: Record<string, NamedRow[]> = {}
  let withRow = 0
  let namedCount = 0
  for (const [i, zone] of zones.entries()) {
    const res: ParseReply = await api<ParseReply>({
      action: 'parse',
      page: zone.replace(/ /g, '_'),
      prop: 'text'
    }).catch((): ParseReply => ({ error: { code: 'fetch-failed' } }))
    // A zone page missing under the catalog's spelling is NAMED rather than swallowed: it is the
    // one signal that the mob catalog and the wiki have drifted apart on a zone name.
    if (res.error) {
      process.stdout.write(`  ${zone}: ${res.error.code ?? 'error'}\n`)
      continue
    }
    const rows = parseNotableNpcs(res.parse?.text ?? '')
    if (rows === null) continue
    withRow++
    namedCount += rows.length
    out[zone] = rows.sort((a, b) => a.name.localeCompare(b.name))
    if ((i + 1) % 25 === 0) process.stdout.write(`  …${String(i + 1)}/${String(zones.length)} zones\n`)
  }

  const data: NamedData = {
    source:
      'eqlwiki.com — the "Notable NPCs" row of each zone page infobox (rendered, not wikitext: ' +
      'the roster is generated by {{Special:DynamicZoneList}}). A zone with no row is absent here.',
    scrapedAt: new Date().toISOString(),
    zoneCount: withRow,
    namedCount,
    // Sorted so a re-scrape diffs cleanly.
    zones: Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
  }
  writeFileSync(OUT_PATH, `${JSON.stringify(data, null, 2)}\n`)
  process.stdout.write(
    `named.json: ${String(namedCount)} notable NPCs across ${String(withRow)} zones ` +
      `(of ${String(zones.length)} probed)\n`
  )
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
