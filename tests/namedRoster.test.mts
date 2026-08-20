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
import { isNamedMob, namedKey, rosterSpellings } from '../src/shared/namedRoster'

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


// ---------------------------------------------------------------------------------------------
// THE READ HALF — `src/shared/namedRoster.ts`, driven against the REAL committed roster.
//
// EVERY BUG BELOW WAS SILENT. The roster is a WHITELIST: a name it fails to match is not an error,
// it is a mob that quietly stops drawing a pin and stops arming a prompt, in a zone the player is
// standing in. There is no log line, no red square, nothing to notice. So each of these pins a
// join that was measured broken against a real player's log rather than a hypothetical one.
//
// The join has THREE naming authorities in it and no two of them agree (law 2, law 12):
//   * the LOG prints what the game renders  — `a reanimated hand`, `King Thex\`Ka IV`
//   * the ROSTER carries a wiki PAGE TITLE  — `a reanimated hand (Lower Guk)`, `King Thex'Ka IV`
//   * the ZONE key is a wiki page title too — `Permafrost`, where the log says `Permafrost Keep`

test('the wiki DISAMBIGUATOR is not part of the name the game prints', () => {
  // THE REPORTED BUG, 2026-08-20. Two zones have a mob called `a reanimated hand`, so the wiki
  // titles the pages `(Lower Guk)` and `(Unrest)` and its notable-NPC list links them by title.
  // The game prints neither. The catalog holds this mob's coordinates and the map drew no pin,
  // because the named-only filter was asked about a name that exists nowhere but the wiki.
  assert.equal(isNamedMob('a reanimated hand', 'The Ruins of Old Guk'), true)
  // …and the full spelling still answers. Both are kept; the parenthetical is evidence.
  assert.equal(isNamedMob('a reanimated hand (Lower Guk)', 'The Ruins of Old Guk'), true)
})

test('rosterSpellings keeps BOTH spellings, and invents nothing for a bare name', () => {
  assert.deepEqual(rosterSpellings('A goblin alchemist (Permafrost)'), [
    'a goblin alchemist (permafrost)',
    'a goblin alchemist'
  ])
  assert.deepEqual(rosterSpellings('Raster of Guk'), ['raster of guk'])
  // A name that is NOTHING but a parenthetical keeps its one spelling rather than folding to ''.
  assert.deepEqual(rosterSpellings('(Unknown)'), ['(unknown)'])
})

test('one apostrophe: the log writes a backtick where the wiki writes a quote', () => {
  // `King Thex\`Ka IV` in the log, `King Thex'Ka IV` in the roster — one goblin king. 40 of the
  // roster's names carry an apostrophe of some kind, so this is a class, not a special case.
  assert.equal(namedKey("Thex'Ka"), namedKey('Thex`Ka'))
  assert.equal(namedKey('Thex\u2019Ka'), namedKey('Thex`Ka'))
  assert.equal(isNamedMob('King Thex`Ka IV', 'Permafrost Keep'), true)
})

test('a roster ZONE is a wiki spelling, so it folds through the CATALOG index', () => {
  // MEASURED: folding the build side through the log-name index dropped three whole rosters. The
  // table knows this place as `Permafrost Keep`; the wiki titles the page `Permafrost`.
  assert.equal(isNamedMob('a goblin alchemist', 'Permafrost Keep'), true)
  assert.equal(isNamedMob('Goblin Patriarch', 'The Permafrost Caverns'), true)
  assert.equal(isNamedMob('Goblin Warlord', 'Clan RunnyEye'), true)
})

test('out-of-era stays dropped, and trash stays false', () => {
  // The era filter is the reason the roster is worth having; widening the fold must not leak it.
  // `Tserrina Syl'Tor (NPC)` is Velious — a disambiguator AND an apostrophe, still out of era.
  assert.equal(isNamedMob("Tserrina Syl'Tor", 'Tower of Frozen Shadow'), false)
  assert.equal(isNamedMob('a rat', 'The Ruins of Old Guk'), false)
  assert.equal(isNamedMob('a froglok noble', 'Nowhere At All'), false)
})
