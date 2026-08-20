// WHICH MOBS ARE NAMED — the parse half of `scripts/scrape-named.ts`.
//
// The scrape itself needs the network; this pins the only part with rules in it, against HTML in
// the shape the wiki really returns. `scrape-named.ts`'s header carries the four discriminators
// that were probed and REJECTED (the Named Mobs category, the Namedmobpage template, the spawn
// percentage, the a/an prefix) — all of them are on trash too, which is why the roster has to come
// from the zone infobox at all.
//
// TWO THINGS THIS FILE EXISTS TO STOP:
//   * A MISSING ROW READ AS AN EMPTY ONE. Cities have no `Notable NPCs` row and that is correct;
//     `null` means "the wiki says nothing here" and `[]` would mean "the wiki says none", and the
//     consumer must be able to tell those apart (silence, never an inference).
//   * A HEADING SEARCH. The row is a `<th>` inside the infobox, NOT an `<h2>` — the first attempt
//     at this scanned h1-h4 and found nothing on a page that plainly had the data.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseNotableNpcs } from '../scripts/sources/notableNpcs'

/** The shape eqlwiki really returns, trimmed to the row that matters. */
const ZONE_HTML = `
<div class="mw-parser-output">
<table class="infobox">
<tr><th><b> Monsters: </b></th><td>Frogloks, Ghouls</td></tr>
<tr>
<th><b> Notable NPCs: </b></th>
<td><a href="/A_basalt_gargoyle" title="A basalt gargoyle">a basalt gargoyle</a>, <a href="/Raster_of_Guk" title="Raster of Guk">Raster of Guk</a>, <a href="/The_ghoul_lord" title="The ghoul lord">the ghoul lord</a>
</td></tr>
</table>
<h2>Monsters</h2>
<p>Much like Upper Guk, frogloks come in different varieties.
<a href="/A_froglok_shin_knight">a froglok shin knight</a> is trash and lives outside the row.</p>
</div>`

test('parseNotableNpcs: the roster comes off the infobox row, and nothing else on the page', () => {
  const rows = parseNotableNpcs(ZONE_HTML)
  assert.ok(rows, 'the row was found')
  assert.deepEqual(
    rows.map((r) => r.name),
    ['a basalt gargoyle', 'Raster of Guk', 'the ghoul lord']
  )
  // THE TRASH LINK IN THE PROSE MUST NOT BE COLLECTED. The zone page carries ~700 internal links;
  // only the ones inside this one cell are the wiki's statement about what is notable.
  assert.equal(
    rows.some((r) => /shin knight/i.test(r.name)),
    false,
    'a link in the body is not a notable NPC'
  )
})

test('parseNotableNpcs: the link TEXT is the name, the TARGET is the page', () => {
  const rows = parseNotableNpcs(ZONE_HTML) ?? []
  const ghoul = rows.find((r) => r.name === 'the ghoul lord')
  // The log prints the lower-case sentence form; the page is title-cased. Both are kept, because
  // the first is what a death line says and the second is the join key back to the mob catalog.
  assert.deepEqual(ghoul, { name: 'the ghoul lord', page: 'The ghoul lord' })
})

test('parseNotableNpcs: NO ROW is null, never an empty list', () => {
  // The distinction the consumer depends on. A city has no row and that is the wiki being right,
  // not the wiki being empty - so a zone with no row must yield no named list at all rather than
  // an authoritative "this zone has zero nameds".
  const city = '<div><table class="infobox"><tr><th>Monsters:</th><td>Merchants</td></tr></table></div>'
  assert.equal(parseNotableNpcs(city), null)
  assert.equal(parseNotableNpcs(''), null)
})

test('parseNotableNpcs: a RED LINK keeps the name and drops the page', () => {
  // The wiki naming a mob it has no page for. The NAME is still its judgement that the mob is
  // notable, so the row survives; inventing a title out of the edit-link query string would
  // fabricate a join key that resolves to nothing.
  const html = `<table><tr><th>Notable NPCs:</th><td>
    <a href="/index.php?title=Froglok_Repairer&amp;action=edit&amp;redlink=1">Froglok Repairer</a>,
    <a href="/Raster_of_Guk">Raster of Guk</a></td></tr></table>`
  const rows = parseNotableNpcs(html) ?? []
  assert.deepEqual(rows, [{ name: 'Froglok Repairer' }, { name: 'Raster of Guk', page: 'Raster of Guk' }])
})

test('parseNotableNpcs: underscores in a target become spaces, and %xx is decoded', () => {
  const html = `<table><tr><th>Notable NPCs:</th><td>
    <a href="/A_reanimated_hand_(Lower_Guk)">a reanimated hand (Lower Guk)</a>,
    <a href="/Kahaptra_Z%60Taj">Kahaptra Z\`Taj</a></td></tr></table>`
  const rows = parseNotableNpcs(html) ?? []
  assert.deepEqual(
    rows.map((r) => r.page),
    ['A reanimated hand (Lower Guk)', 'Kahaptra Z`Taj']
  )
})
