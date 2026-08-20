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
import { respawnWithWatch, respawnWithoutWatch, normalizeRespawnPrefs } from '../src/shared/respawn'
import type { LogEvent } from '../src/shared/logEvents'

const T0 = 1_770_000_000_000

/** The experience line that makes the next death YOURS. See the credit gate in campPins.ts. */
const exp = (ts: number): LogEvent =>
  ({ kind: 'expGain', seq: 0, ts, raw: '', pct: 1 }) as LogEvent

/** A death of `mob` CREDITED to you - an exp line, then the slain line, as the log prints them. */
function death(mob: string, ts = T0): LogEvent[] {
  return [exp(ts), { kind: 'death', seq: 1, ts, raw: '', name: mob, bySelf: true } as LogEvent]
}

/** A death of `mob` by SOMEBODY ELSE: the log names it, and pays you nothing. */
const strangerKill = (mob: string, ts = T0): LogEvent =>
  ({ kind: 'death', seq: 1, ts, raw: '', name: mob, bySelf: false }) as LogEvent
/** A typed `/loc`. */
const loc = (ts: number, ns = 100, ew = 200, z = 30): LogEvent =>
  ({ kind: 'loc', seq: 2, ts, raw: '', ns, ew, z }) as LogEvent
const zone = (name: string): LogEvent => ({ kind: 'zone', seq: 3, ts: T0, raw: '', zone: name }) as LogEvent

/** Fold a credited kill (the exp line and the slain line together). */
function feed(m: CampPinsModule, evs: LogEvent[]): void {
  for (const ev of evs) m.onEvent(ev)
}

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
  feed(m, death('a froglok shin knight'))
  assert.equal(m.snapshot(T0 + 1).state.prompt, undefined, 'trash asks nothing')

  feed(m, death('the ghoul lord'))
  const snap = m.snapshot(T0 + 1).state
  assert.equal(snap.prompt?.mob, 'the ghoul lord')
  assert.equal(snap.prompt?.zone, 'Lower Guk')
})

test("A STRANGER'S KILL ASKS NOTHING - your log hears the whole zone", () => {
  // THE DEFECT, reported from a public zone: the owner watched a ghoul executioner die to somebody
  // else across the room and was asked to pin its camp. `/loc` would have recorded where HE was
  // standing - a fabricated camp for a mob he never fought.
  //
  // A kill is yours only when the log PAID you for it. The stranger's kill prints a slain line and
  // no experience, so it claims nothing and arms nothing. This is the same answer the celebration
  // toast reached from the same complaint (2026-08-05), and it is better than any guess about
  // whether we engaged the mob: it is the log's own statement rather than an inference from damage.
  const m = inZone()
  m.onEvent(strangerKill('the ghoul lord'))
  assert.equal(m.snapshot(T0 + 1).state.prompt, undefined, 'somebody else killed it')

  // The SAME mob, paid for, does ask.
  feed(m, death('the ghoul lord', T0 + 5000))
  assert.equal(m.snapshot(T0 + 5001).state.prompt?.mob, 'the ghoul lord')
})

test('an experience line is CONSUMED by the death it precedes, never a later one', () => {
  // kills.ts's rule, kept verbatim: one line can never credit two kills. Without it a stranger's
  // kill moments after your own would inherit your experience and be asked about.
  const m = inZone()
  feed(m, death('the ghoul lord'))
  assert.ok(m.snapshot(T0 + 1).state.prompt, 'yours')
  // A second, unpaid death of a DIFFERENT watched mob must not claim the same line.
  m.setWatched(['Gorgalosk'])
  m.onEvent(strangerKill('Gorgalosk', T0 + 100))
  assert.equal(m.snapshot(T0 + 101).state.prompt?.mob, 'the ghoul lord', 'the first kill still holds the slot')
})

test('a WATCHED mob arms it even when the roster has never heard of it', () => {
  // The half that covers what the wiki misses - and it misses a lot (namedDb.ts has the
  // measurement: `Hoptor Thaggelum` is listed under a name the game never prints). A mob the user
  // asked for a clock on is an explicit instruction, which outranks any roster.
  const m = inZone()
  m.setWatched(['Gorgalosk'])
  feed(m, death('Gorgalosk'))
  assert.equal(m.snapshot(T0 + 1).state.prompt?.mob, 'Gorgalosk')
})

test('a death before any zone line arms nothing - a camp with no zone cannot be filed', () => {
  const m = new CampPinsModule()
  feed(m, death('the ghoul lord'))
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
  feed(m, death('the ghoul lord'))
  assert.equal(m.snapshot(T0).state.prompt?.mob, 'the ghoul lord', 'up at the moment of death')
  assert.equal(m.snapshot(T0 + 1).state.prompt?.mob, 'the ghoul lord')
})

test('an immediate /loc still pins - the ask simply becomes its own receipt', () => {
  // What the grace period was really protecting against: a card telling you to do the thing you
  // just did. The toast channel dedupes on id, so the ask is REPLACED by the confirmation rather
  // than suppressed - which is the same outcome without the cost of a late card.
  const m = inZone()
  feed(m, death('the ghoul lord'))
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
  feed(m, death('the ghoul lord'))
  assert.ok(m.snapshot(T0 + CAMP_SHOW_MS - 1).state.prompt, 'still standing')
  assert.equal(m.snapshot(T0 + CAMP_SHOW_MS).state.prompt, undefined, 'show has closed')
})

test('a /loc after SHOW pins nothing - a stale question collects no answer', () => {
  // The whole reason this is not "join a kill to a nearby /loc": a position typed a minute later
  // is a fact about somewhere else, and recording it would be the inference this design refuses.
  const m = inZone()
  feed(m, death('the ghoul lord'))
  m.onTick(T0 + CAMP_SHOW_MS + 1)
  m.onEvent(loc(T0 + CAMP_SHOW_MS + 2))
  assert.deepEqual(m.snapshot(T0 + CAMP_SHOW_MS + 3).state.pins.pins, {})
})

// --- NAGGING ----------------------------------------------------------------

test('QUIET: an ignored prompt stops that mob asking again for a while', () => {
  const m = inZone()
  feed(m, death('the ghoul lord', T0))
  m.onTick(T0 + CAMP_SHOW_MS + 1) // ignored - the arm expires and the mob goes quiet
  // It respawns and dies again well inside the quiet window: no second question.
  feed(m, death('the ghoul lord', T0 + CAMP_SHOW_MS + 60_000))
  assert.equal(m.snapshot(T0 + CAMP_SHOW_MS + 60_001).state.prompt, undefined)
  // Past the quiet window it may ask again.
  const later = T0 + CAMP_SHOW_MS + CAMP_QUIET_MS + 1
  feed(m, death('the ghoul lord', later))
  assert.ok(m.snapshot(later + 1).state.prompt, 'the quiet has lapsed')
})

// --- ONE SLOT ---------------------------------------------------------------

test('ONE SLOT: a newer corpse replaces the pending question', () => {
  // Two questions cannot both be answered by the next `/loc`, and guessing which the player meant
  // is the ambiguity this app refuses. The newer corpse is the one being stood on.
  const m = inZone()
  m.setWatched(['Gorgalosk'])
  feed(m, death('the ghoul lord', T0))
  feed(m, death('Gorgalosk', T0 + 1000))
  assert.equal(m.snapshot(T0 + 1001).state.prompt?.mob, 'Gorgalosk')
  m.onEvent(loc(T0 + 2000))
  const pins = m.snapshot(T0 + 3000).state.pins.pins
  assert.deepEqual(Object.keys(pins), [campKey('Gorgalosk', 'Lower Guk')], 'only the newer was pinned')
})

test('a zone line ends the question - the corpse is behind you', () => {
  const m = inZone()
  feed(m, death('the ghoul lord'))
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

// --- ANSWERING IS AN OPT-IN -------------------------------------------------
//
// The line that makes the feature worth having: typing `/loc` in answer to "this named just died"
// puts the mob on the respawn watch list, which is what turns a dot on a map into a countdown -
// and what fills the list in for every mob the wiki roster misses. `log/campPersist.ts` performs
// it (it needs the store, so it cannot live in the fold); these pin the pure half it stands on.

test('respawnWithWatch: adds one, canonicalizes the key, and replaces rather than duplicates', () => {
  const empty = normalizeRespawnPrefs({})
  const one = respawnWithWatch(empty, 'the ghoul lord', 'the ghoul lord')
  assert.deepEqual(one.watches, [{ key: 'the ghoul lord', display: 'the ghoul lord' }])
  // The key folds (law 2 - canonicalize at boundaries), so a name off a death line and a
  // hand-edited settings file land on the same entry.
  const mixed = respawnWithWatch(empty, '  The Ghoul LORD ', 'The Ghoul Lord')
  assert.equal(mixed.watches[0].key, 'the ghoul lord')
  // Re-adding replaces; the list does not grow.
  const again = respawnWithWatch(one, 'the ghoul lord', 'the ghoul lord')
  assert.equal(again.watches.length, 1)
})

test('respawnWithWatch: it is the exact inverse of respawnWithoutWatch', () => {
  // The two live together so "watch" and "stop watching" cannot drift into different ideas of
  // what the list is - which is the reason respawnWithoutWatch's own header gives for existing.
  const empty = normalizeRespawnPrefs({})
  const added = respawnWithWatch(empty, 'Gorgalosk', 'Gorgalosk')
  assert.deepEqual(respawnWithoutWatch(added, 'Gorgalosk').watches, [])
})

test('respawnWithWatch: a customSec is carried only when the caller passes one', () => {
  // "Re-watch with no custom time" and "keep the number I typed" are different intentions and only
  // the caller knows which, so this function never invents the second. `campPersist` relies on it:
  // it refuses to touch a mob already watched precisely so a camp answer cannot discard a typed
  // respawn time.
  const empty = normalizeRespawnPrefs({})
  assert.equal(respawnWithWatch(empty, 'a', 'a').watches[0].customSec, undefined)
  assert.equal(respawnWithWatch(empty, 'a', 'a', 540).watches[0].customSec, 540)
})
