// THE MAP'S CLOCK JOIN — `features/maps/mapClock.ts`.
//
// THE REPORT: a user pressed `Watch for respawn` on a celebration card, saw the mob appear in the
// Timers tab with a running countdown, and got no countdown on the map at all. Their zone chip
// read `The Ruins of Old Guk 1 (Awakened)`.
//
// THE MECHANISM, and it is the third appearance of one bug: two folds that name the same room two
// ways, joined on the raw string.
//
//   * the RESPAWN fold files a row under the zone line VERBATIM — `The Ruins of Old Guk 1
//     (Awakened)`, because a list of clocks is instance-scoped by design (JOS-194);
//   * the CAMP fold strips the tier first — `The Ruins of Old Guk`, because "the tier is a fact
//     about the difficulty, never about the geography" (shared/campPins.ts);
//   * and `clocksByName` compared `row.zone` to the camp fold's answer with `===`.
//
// So standing in ANY instance produced an empty map and every watched mob drew a bare pin. The two
// previous appearances are pinned elsewhere: a roster keyed on the wiki's zone spelling
// (tests/namedRoster.test.mts) and a camp clock keyed on the mob without its zone.
//
// The two OTHER halves of the same fold are pinned here too — that a stale clock leaves the map,
// which is the owner's ruling that a map is a place-finder first, and that the wording is the
// app's one clock vocabulary rather than this module's own.
//
// Pure — no Electron, no fixtures, never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clocksByName, mapClockText } from '../src/renderer/src/features/maps/mapClock'
import { RESPAWN_LONG_DUE_LABEL, type RespawnRow } from '../src/shared/respawn'

const NOW = 1_770_000_000_000

/**
 * A watched row, built to the REAL `RespawnRow` shape — no cast, so a field the interface grows
 * breaks this file rather than silently producing a row `respawnReading` cannot read.
 *
 * `baseTs` is what the clock counts FROM (the death, or a confirmed sighting); `estimateMs` is how
 * long the ladder thinks the respawn is. Ten minutes and a death a minute ago is a live clock.
 */
const row = (
  display: string,
  zone: string,
  opts: { baseTs?: number; estimateMs?: number } = {}
): RespawnRow => ({
  id: `${zone.toLowerCase()}::${display.toLowerCase()}`,
  key: display.toLowerCase(),
  display,
  zone,
  baseTs: opts.baseTs ?? NOW - 60_000,
  basis: 'death',
  source: 'observed',
  samples: 1,
  kills: 2,
  ...('estimateMs' in opts && opts.estimateMs === undefined ? {} : { estimateMs: opts.estimateMs ?? 600_000 })
})

test('THE REPORTED BUG: an instance zone still finds its clocks', () => {
  // The camp fold's answer on the left, the respawn fold's on the right. They name one room.
  const rows = [row('A ghoul ritualist', 'The Ruins of Old Guk 1 (Awakened)')]
  const found = clocksByName(rows, 'The Ruins of Old Guk')
  assert.equal(found.size, 1, 'the instance row belongs to this map')
  assert.ok(found.get('a ghoul ritualist'), 'and is keyed by the name the log printed')
})

test('every tier of one room folds together, in both directions', () => {
  const rows = [
    row('A ghoul ritualist', 'The Ruins of Old Guk 4 (Refined)'),
    row('a ghoul savant', 'The Ruins of Old Guk')
  ]
  for (const zone of ['The Ruins of Old Guk', 'The Ruins of Old Guk 1 (Awakened)']) {
    assert.equal(clocksByName(rows, zone).size, 2, zone)
  }
})

test('ANOTHER ZONE IS STILL ANOTHER ZONE — the fold widens instances, not geography', () => {
  // The failure that would be worse than the bug: a clock from Befallen drawn on the Guk map.
  const rows = [row('Commander Windstream', 'Befallen 1 (Awakened)')]
  assert.equal(clocksByName(rows, 'The Ruins of Old Guk').size, 0)
})

test('no zone, no clocks — never a wildcard', () => {
  assert.equal(clocksByName([row('A ghoul ritualist', 'The Ruins of Old Guk')], null).size, 0)
})

test('A STALE CLOCK LEAVES THE MAP, so the pin can go back to being a pin', () => {
  // The owner's ruling: a map is a place-finder first, and after a week of play every zone would
  // otherwise be a screen of `due long ago` with the locations buried under it.
  const fresh = row('A ghoul ritualist', 'Guk', { baseTs: NOW - 60_000, estimateMs: 600_000 })
  assert.ok(mapClockText(fresh, NOW), 'a running clock is worth drawing')

  const ancient = row('A ghoul ritualist', 'Guk', { baseTs: NOW - 12_000_000, estimateMs: 682_000 })
  assert.equal(mapClockText(ancient, NOW), null, 'the estimate died hours ago')
})

test('the wording is the APP’s clock vocabulary, not this module’s own', () => {
  // mapClock.ts used to spell its own `due`, which is how a row could read `due long ago` while
  // the pin beside it read a flat `due`. Whatever it prints must come from respawnClockLabel.
  const fresh = row('A ghoul ritualist', 'Guk', { baseTs: NOW - 60_000, estimateMs: 600_000 })
  const text = mapClockText(fresh, NOW)
  assert.ok(text !== null && /\d/.test(text), 'a countdown states a number')
  assert.notEqual(text, 'due', 'the private spelling is gone')
  assert.notEqual(text, RESPAWN_LONG_DUE_LABEL, 'and this one is not stale')
})

test('no row and no estimate say nothing rather than something invented', () => {
  assert.equal(mapClockText(undefined, NOW), null)
  const never = row('A ghoul ritualist', 'Guk', { estimateMs: undefined })
  assert.equal(mapClockText(never, NOW), null, 'a mob killed once has no gap to learn from')
})
