// THE `Notable NPCs` ROW — the pure parse half of `scripts/scrape-named.ts`.
//
// Split out for the reason every pure core in this repo is: the script it belongs to TALKS TO THE
// WIKI at module scope, and a unit test that imports it would perform a 192-request harvest as a
// side effect of asking about a regex. That is not hypothetical - it happened once, on the first
// run of tests/namedRoster.test.mts, before this split existed.
//
// The rules, and the evidence behind them, live in scrape-named.ts's header: why the zone infobox
// is the only honest source of a named roster, and which four obvious alternatives were probed and
// found to be on trash mobs too.

import * as cheerio from 'cheerio'

/** One notable NPC: what the log prints, and the page that describes it. */
export interface NamedRow {
  /** The link TEXT — the spelling a death line uses. */
  name: string
  /** The link TARGET, canonicalized. Absent for a red link (the wiki names a mob it has no page for). */
  page?: string
  /**
   * The wiki badges this page as out of the current era — Kunark, Velious, content this game has
   * not shipped. Present ONLY when true: `action=eqlmetadata` answers `false` both for classic
   * content and for a page nobody has classified, so a false is silence, not a claim that the mob
   * is in era. `scripts/scrape-named.ts` carries the argument; scrape-page-era.ts carries the
   * citation. A consumer wanting "mobs that can actually die in this game" filters on this being
   * absent, and is right to treat a red-link row (no page, so no verdict) the same way.
   */
  outOfEra?: true
}

/**
 * Pull the `Notable NPCs` row out of one rendered zone page.
 *
 * Returns null when the page has no such row — which is a real answer (cities do not have them)
 * and must never be confused with an empty list.
 */
export function parseNotableNpcs(html: string): NamedRow[] | null {
  const $ = cheerio.load(html)
  let rows: NamedRow[] | null = null
  $('th').each((_i, el) => {
    if (rows !== null) return
    if (!/notable\s+npcs/i.test($(el).text())) return
    const cell = $(el).closest('tr').find('td').first()
    rows = cell
      .find('a')
      .toArray()
      .map((a) => {
        const name = $(a).text().trim()
        const href = $(a).attr('href') ?? ''
        // A RED LINK is the wiki naming a mob it has no page for: `/index.php?title=X&redlink=1`.
        // The NAME is still the wiki's judgement that the mob is notable, so the row survives - it
        // just carries no page. Inventing a title from the query string would fabricate a join key.
        const red = href.includes('redlink=1') || href.includes('action=edit')
        const page = red ? '' : decodeURIComponent(href.replace(/^\//, '')).replace(/_/g, ' ')
        return page ? { name, page } : { name }
      })
      .filter((r) => r.name !== '')
  })
  return rows
}

