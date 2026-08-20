// CAMP PINS — "a named just died; type /loc and I will remember the camp".
//
// The feature exists because the log states NO position on any combat line: the app can know a
// named died and can read a `/loc`, and can never know where the kill happened. The other tool in
// this space joins a kill to whatever `/loc` came nearest in time; this one asks, so the position
// is a MESSAGE rather than an inference (law 1). shared/campPins.ts carries the whole argument.
//
// WHAT THIS FILE GUARDS, in the order the defects would bite:
//   * ARMING ON THE WRONG THING. 2,304 decaying skeletons died in one reporter's log. A prompt on
//     every death is an alarm clock with no off switch, so only the roster or the user's own watch
//     list may arm one - never a guess about what looks named.
//   * A LATE CARD. The question is asked the INSTANT the mob dies - a grace period was tried,
//     borrowed from petNudge, and measured to put the card in the middle of the next fight.
//   * NAGGING. An ignored prompt goes quiet; a named respawning every nine minutes must not ask
//     again every nine minutes.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CampPinsModule } from '../src/main/modules/campPins'
import { CAMP_QUIET_MS, CAMP_SHOW_MS, campKey } from '../src/shared/campPins'
import type { LogEvent } from '../src/shared/logEvents'

const T0 = 1_770_000_000_000

/** A death of `mob`, as the fold sees it. */
const death = (mob: string, ts = T0): LogEvent =>
  ({ kind: 'death', seq: 1, ts, raw: '', name: mob, bySelf: true }) as LogEvent
/** A typed `/loc`. */
const loc = (ts: number, ns = 100, ew = 200, z = 30): LogEvent =>
  ({ kind: 'loc', seq: 2, ts, raw: '', ns, ew, z }) as LogEvent
const zone = (name: string): LogEvent => ({ kind: 'zone', seq: 3, ts: T0, raw: '', zone: name }) as LogEvent

/** A module standing in a zone, ready to fold. */
function inZone(name = 'Lower Guk'): CampPinsModule {
  const m = new CampPinsModule()
  m.onEvent(zone(name))
  return m
}

// --- WHAT ARMS IT -----------------------------------------------------------

test('a roster named arms the prompt; trash in the same zone does not', () => {
  // `the ghoul lord` is in the committed roster for Lower Guk; `a froglok shin knight` is the trash
  // the wiki deliberately omits. Both die in the same room, and only one is worth a question.
  const m = inZone()
  m.onEvent(death('a froglok shin knight'))
  assert.equal(m.snapshot(T0 + 1).state.prompt, undefined, 'trash asks nothing')

  m.onEvent(death('the ghoul lord'))
  const snap = m.snapshot(T0 + 1).state
  assert.equal(snap.prompt?.mob, 'the ghoul lord')
  assert.equal(snap.prompt?.zone, 'Lower Guk')
})

test('a WATCHED mob arms it even when the roster has never heard of it', () => {
  // The half that covers what the wiki misses - and it misses a lot (namedDb.ts has the
  // measurement: `Hoptor Thaggelum` is listed under a name the game never prints). A mob the user
  // asked for a clock on is an explicit instruction, which outranks any roster.
  const m = inZone()
  m.setWatched(['Gorgalosk'])
  m.onEvent(death('Gorgalosk'))
  assert.equal(m.snapshot(T0 + 1).state.prompt?.mob, 'Gorgalosk')
})

test('a death before any zone line arms nothing - a camp with no zone cannot be filed', () => {
  const m = new CampPinsModule()
  m.onEvent(death('the ghoul lord'))
  assert.equal(m.snapshot(T0 + 1).state.prompt, undefined)
})

test('the zone is the BASE zone - an instance is the same room', () => {
  // `zoneTier` strips ` 4 (Refined)`. A camp pinned in the Refined instance is the camp in the
  // open-world zone, because the geography is identical and only the difficulty differs.
  const m = inZone('The Ruins of Old Guk 4 (Refined)')
  assert.equal(m.snapshot(T0).state.zone, 'The Ruins of Old Guk')
})

// --- THE TIMING ------------------------------------------------------------

test('the card is up the INSTANT the mob dies - there is no grace period', () => {
  // The grace was borrowed from petNudge and did not survive a real chain pull: a card ten seconds
  // behind its own kill arrived in the middle of the NEXT fight (measured, 2026-08-20 - a ghoul
  // assassin's card appeared 28 s after it died). Asked immediately, answered whenever.
  const m = inZone()
  m.onEvent(death('the ghoul lord'))
  assert.equal(m.snapshot(T0).state.prompt?.mob, 'the ghoul lord', 'up at the moment of death')
  assert.equal(m.snapshot(T0 + 1).state.prompt?.mob, 'the ghoul lord')
})

test('an immediate /loc still pins - the ask simply becomes its own receipt', () => {
  // What the grace period was really protecting against: a card telling you to do the thing you
  // just did. The toast channel dedupes on id, so the ask is REPLACED by the confirmation rather
  // than suppressed - which is the same outcome without the cost of a late card.
  const m = inZone()
  m.onEvent(death('the ghoul lord'))
  m.onEvent(loc(T0 + 500, 1558, -749, -137))
  const snap = m.snapshot(T0 + 600).state
  assert.equal(snap.prompt, undefined, 'answered, so nothing is still asking')
  const pin = snap.pins.pins[campKey('the ghoul lord', 'Lower Guk')]
  assert.deepEqual(
    { ns: pin.ns, ew: pin.ew, z: pin.z, mob: pin.mob, zone: pin.zone },
    { ns: 1558, ew: -749, z: -137, mob: 'the ghoul lord', zone: 'Lower Guk' }
  )
})

test('the card stands until SHOW closes, and not one tick longer', () => {
  const m = inZone()
  m.onEvent(death('the ghoul lord'))
  assert.ok(m.snapshot(T0 + CAMP_SHOW_MS - 1).state.prompt, 'still standing')
  assert.equal(m.snapshot(T0 + CAMP_SHOW_MS).state.prompt, undefined, 'show has closed')
})

test('a /loc after SHOW pins nothing - a stale question collects no answer', () => {
  // The whole reason this is not "join a kill to a nearby /loc": a position typed a minute later
  // is a fact about somewhere else, and recording it would be the inference this design refuses.
  const m = inZone()
  m.onEvent(death('the ghoul lord'))
  m.onTick(T0 + CAMP_SHOW_MS + 1)
  m.onEvent(loc(T0 + CAMP_SHOW_MS + 2))
  assert.deepEqual(m.snapshot(T0 + CAMP_SHOW_MS + 3).state.pins.pins, {})
})

// --- NAGGING ----------------------------------------------------------------

test('QUIET: an ignored prompt stops that mob asking again for a while', () => {
  const m = inZone()
  m.onEvent(death('the ghoul lord', T0))
  m.onTick(T0 + CAMP_SHOW_MS + 1) // ignored - the arm expires and the mob goes quiet
  // It respawns and dies again well inside the quiet window: no second question.
  m.onEvent(death('the ghoul lord', T0 + CAMP_SHOW_MS + 60_000))
  assert.equal(m.snapshot(T0 + CAMP_SHOW_MS + 60_001).state.prompt, undefined)
  // Past the quiet window it may ask again.
  const later = T0 + CAMP_SHOW_MS + CAMP_QUIET_MS + 1
  m.onEvent(death('the ghoul lord', later))
  assert.ok(m.snapshot(later + 1).state.prompt, 'the quiet has lapsed')
})

// --- ONE SLOT ---------------------------------------------------------------

test('ONE SLOT: a newer corpse replaces the pending question', () => {
  // Two questions cannot both be answered by the next `/loc`, and guessing which the player meant
  // is the ambiguity this app refuses. The newer corpse is the one being stood on.
  const m = inZone()
  m.setWatched(['Gorgalosk'])
  m.onEvent(death('the ghoul lord', T0))
  m.onEvent(death('Gorgalosk', T0 + 1000))
  assert.equal(m.snapshot(T0 + 1001).state.prompt?.mob, 'Gorgalosk')
  m.onEvent(loc(T0 + 2000))
  const pins = m.snapshot(T0 + 3000).state.pins.pins
  assert.deepEqual(Object.keys(pins), [campKey('Gorgalosk', 'Lower Guk')], 'only the newer was pinned')
})

test('a zone line ends the question - the corpse is behind you', () => {
  const m = inZone()
  m.onEvent(death('the ghoul lord'))
  m.onEvent(zone('Befallen'))
  m.onEvent(loc(T0 + 1000))
  assert.deepEqual(m.snapshot(T0 + 2000).state.pins.pins, {}, 'a /loc in the next zone pins nothing')
})

test('a /loc with nothing armed is simply a /loc', () => {
  const m = inZone()
  m.onEvent(loc(T0 + 1000))
  assert.deepEqual(m.snapshot(T0 + 2000).state.pins.pins, {})
})

// --- THE REVISION -----------------------------------------------------------

test('the module reports its OWN revision, so an out-of-band pin is not deduped away', () => {
  // JOS-87's law. `useModule` dedupes on `seq`; this module moves on things that are not log
  // events (a seeded pin, an edited watch list), so reporting the last event's seq would drop
  // those updates forever on an idle log.
  const m = inZone()
  const before = m.snapshot(T0).seq
  m.setPins({ pins: {} })
  assert.ok(m.snapshot(T0).seq > before, 'a seeded write advanced the revision')
})
