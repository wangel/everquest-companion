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
const OUT_PATH = resolve(HERE, '../src/renderer/src/data/eqlegends/named.json')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** GET puts the params in the query string; POST puts them in the body. One shape either way. */
function requestFor(params: Record<string, string>, method: 'GET' | 'POST'): [string, RequestInit] {
  const body = new URLSearchParams({ format: 'json', formatversion: '2', ...params })
  if (method === 'GET') return [`${API}?${body.toString()}`, { headers: { 'User-Agent': UA } }]
  return [
    API,
    {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    }
  ]
}

/**
 * One serialized request with exponential backoff on 429/5xx (honours Retry-After).
 *
 * POST exists for exactly one caller, the same one it exists for in scrape-page-era.ts:
 * `action=eqlmetadata` is POST-only, and 450 titles would not fit a query string anyway.
 */
async function api<T>(params: Record<string, string>, method: 'GET' | 'POST' = 'GET'): Promise<T> {
  const [url, init] = requestFor(params, method)
  let wait = 1000
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await fetch(url, init)
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
  /** How many rows the wiki badges out of era. See NamedRow.outOfEra. */
  outOfEraCount: number
  zones: Record<string, NamedRow[]>
}

/** The slice of `action=parse` this script reads. */
interface ParseReply {
  parse?: { text?: string }
  error?: { code?: string }
}

// ---------------------------------------------------------------------------
// THE ERA PASS — which of these mobs are actually in EQ Legends
// ---------------------------------------------------------------------------
//
// The roster above is the wiki's judgement about what is worth camping, and the wiki documents
// content this game has not shipped: the biggest rosters in the first scrape were Western Wastes
// (50), Velketor's Labyrinth (29) and Temple of Veeshan (27) — Velious, all of it, alongside
// Kunark's Frontier Mountains and Trakanon's Teeth. A named roster that dings for Kunark mobs is
// worse than no roster: every one of those entries is a mob that cannot die in this game.
//
// `action=eqlmetadata` is the wiki's OWN predicate for that question — the same one its skin uses
// to grey out-of-era links, at the same `Template:PageEra` revision this repo already mirrors.
// scrape-page-era.ts carries the full citation and the response shape read off the live wire.
//
// MARKED, NEVER DROPPED, and the reason is in that file's header too — THE SILENCE PROBLEM:
// `outOfEra: false` comes back both for a page the wiki classifies as classic AND for a page
// nobody has classified at all. So the boolean is trustworthy in ONE direction only. A `true` is a
// positive claim and is recorded; everything else is silence and is recorded as nothing. Deleting
// the rows would additionally throw away the evidence, and re-deriving it costs another scrape.

const META_BATCH = 450

/** `action=eqlmetadata`'s answer. Shape and citation: scrape-page-era.ts. */
interface MetaRow {
  title?: string
  outOfEra?: boolean
  requested?: string[]
}
interface MetaResponse {
  eqlmetadata?: { eraRevision?: number; pages?: MetaRow[] }
}

/** Title → its own era key, matching `pageEraDb.ts pageEraKey` so the two files agree. */
const eraKey = (title: string): string =>
  title.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Ask the wiki which of these titles it badges out of era.
 *
 * Every answered row is filed under BOTH spellings — what we asked and what the wiki resolved it
 * to — so a redirect still finds its answer (`the ghoul lord` resolves to `The Ghoul Lord`).
 */
async function outOfEraTitles(titles: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (let i = 0; i < titles.length; i += META_BATCH) {
    const slice = titles.slice(i, i + META_BATCH)
    const j = await api<MetaResponse>({ action: 'eqlmetadata', titles: slice.join('|') }, 'POST')
    const rows = j.eqlmetadata?.pages
    if (rows === undefined) throw new Error('eqlmetadata returned no pages')
    for (const row of rows) keepOutOfEra(out, row)
  }
  return out
}

/**
 * One answered row, filed under BOTH spellings — what we asked and what the wiki resolved it to —
 * so a redirect still finds its answer (`the ghoul lord` resolves to `The Ghoul Lord`).
 *
 * ONLY A `true` IS KEPT. `outOfEra: false` is returned both for classic content and for a page
 * nobody has classified, so it is silence; recording it would let "nobody looked" argue that a mob
 * is in era. scrape-page-era.ts calls this THE SILENCE PROBLEM and states it at length.
 */
function keepOutOfEra(out: Set<string>, row: MetaRow): void {
  if (row.outOfEra !== true) return
  for (const spelling of [row.title, ...(row.requested ?? [])]) {
    if (spelling !== undefined) out.add(eraKey(spelling))
  }
}

/**
 * Ask the wiki about every page in the roster and stamp the ones it badges out of era. Mutates the
 * rows in place and returns how many were marked.
 *
 * ASKED ABOUT THE PAGE, not the display name, because the page is what the wiki badges. A red-link
 * row has no page and therefore gets no verdict — which is silence, exactly like a `false`, and
 * not a claim in either direction.
 */
async function markOutOfEra(zones: Record<string, NamedRow[]>): Promise<number> {
  const rows = Object.values(zones).flat()
  const pages = [...new Set(rows.map((r) => r.page).filter((p): p is string => p !== undefined))].sort()
  if (pages.length === 0) return 0
  const outOfEra = await outOfEraTitles(pages)
  let marked = 0
  for (const row of rows) {
    if (row.page === undefined || !outOfEra.has(eraKey(row.page))) continue
    row.outOfEra = true
    marked++
  }
  return marked
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

  const marked = await markOutOfEra(out)

  const data: NamedData = {
    source:
      'eqlwiki.com — the "Notable NPCs" row of each zone page infobox (rendered, not wikitext: ' +
      'the roster is generated by {{Special:DynamicZoneList}}). A zone with no row is absent here. ' +
      '`outOfEra` is the wiki\'s own action=eqlmetadata verdict and is recorded ONLY when true: a ' +
      'false answer is returned both for classic content and for a page nobody classified, so it ' +
      'is silence rather than evidence of being in era (scrape-page-era.ts states this at length).',
    scrapedAt: new Date().toISOString(),
    zoneCount: withRow,
    namedCount,
    outOfEraCount: marked,
    // Sorted so a re-scrape diffs cleanly.
    zones: Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
  }
  writeFileSync(OUT_PATH, `${JSON.stringify(data, null, 2)}\n`)
  process.stdout.write(`  out of era: ${String(marked)} of ${String(namedCount)}\n`)
  process.stdout.write(
    `named.json: ${String(namedCount)} notable NPCs across ${String(withRow)} zones ` +
      `(of ${String(zones.length)} probed)\n`
  )
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
