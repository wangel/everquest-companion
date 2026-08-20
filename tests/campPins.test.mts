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
//   * ASKING FOR WHAT THE APP ALREADY HAS. 432 of 560 in-era named mobs carry wiki coordinates the
//     map has always drawn, so the prompt fires only where the catalog is silent. The fixture mob
//     is `Commander Windstream` for exactly that reason: Befallen's roster names him and the
//     catalog has never heard of him.
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
function inZone(name = 'Befallen'): CampPinsModule {
  const m = new CampPinsModule()
  m.onEvent(zone(name))
  return m
}

// --- WHAT ARMS IT -----------------------------------------------------------

test('a roster named arms the prompt; trash in the same zone does not', () => {
  // `Commander Windstream` is in Befallen's committed roster; `a bok ghoul knight` is trash
  // the wiki deliberately omits. Both die in the same room, and only one is worth a question.
  const m = inZone()
  feed(m, death('a bok ghoul knight'))
  assert.equal(m.snapshot(T0 + 1).state.prompt, undefined, 'trash asks nothing')

  feed(m, death('Commander Windstream'))
  const snap = m.snapshot(T0 + 1).state
  assert.equal(snap.prompt?.mob, 'Commander Windstream')
  assert.equal(snap.prompt?.zone, 'Befallen')
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
  m.onEvent(strangerKill('Commander Windstream'))
  assert.equal(m.snapshot(T0 + 1).state.prompt, undefined, 'somebody else killed it')

  // The SAME mob, paid for, does ask.
  feed(m, death('Commander Windstream', T0 + 5000))
  assert.equal(m.snapshot(T0 + 5001).state.prompt?.mob, 'Commander Windstream')
})

test('an experience line is CONSUMED by the death it precedes, never a later one', () => {
  // kills.ts's rule, kept verbatim: one line can never credit two kills. Without it a stranger's
  // kill moments after your own would inherit your experience and be asked about.
  const m = inZone()
  feed(m, death('Commander Windstream'))
  assert.ok(m.snapshot(T0 + 1).state.prompt, 'yours')
  // A second, unpaid death of a DIFFERENT watched mob must not claim the same line.
  m.setWatched(['Gorgalosk'])
  m.onEvent(strangerKill('Gorgalosk', T0 + 100))
  assert.equal(m.snapshot(T0 + 101).state.prompt?.mob, 'Commander Windstream', 'the first kill still holds the slot')
})

test('A MOB THE CATALOG HAS COORDINATES FOR IS NEVER ASKED FOR A /loc', () => {
  // THE DEFECT THIS GATE EXISTS FOR. The owner answered a prompt for a ghoul supplier, and three
  // hours later noticed the wiki had placed it 14 units from where he stood - `MapMobPins` had been
  // drawing that pin the whole time. The app must never ask a player to hand-place a mark that is
  // already on screen. 432 of the 560 in-era named mobs are in this category (namedDb.ts).
  const guk = inZone('Lower Guk')
  feed(guk, death('the ghoul lord'))
  const placed = guk.snapshot(T0 + 1).state.prompt
  assert.equal(placed?.needsLoc, false, 'the wiki already placed it')
  // It is still asked ABOUT, because there is a second question - and this is the only one left.
  assert.equal(placed?.offerWatch, true, 'a notable NPC nobody is watching yet')

  // …and the 128 the wiki missed ask for the position too. `Commander Windstream` is in Befallen's
  // roster and the catalog has never heard of him, which is the whole case for the `/loc` half.
  const bef = inZone('Befallen')
  feed(bef, death('Commander Windstream'))
  assert.equal(bef.snapshot(T0 + 1).state.prompt?.needsLoc, true)
})

test('NOTHING LEFT TO ASK, NO CARD — a watched mob the wiki has already placed', () => {
  // The state both gates are satisfied in, and the one that keeps the watch ask from turning the
  // prompt into an alarm clock: a named you already watch, whose spawn the catalog states, is a
  // mob this app has no question about. Before the watch ask existed this was the same test as
  // `catalogHasCoords` alone.
  const guk = inZone('Lower Guk')
  guk.setWatched(['the ghoul lord'])
  feed(guk, death('the ghoul lord'))
  assert.equal(guk.snapshot(T0 + 1).state.prompt, undefined)
})

test('THE WATCH OFFER IS FOR NOTABLE NPCs ONLY, never the watch-list half', () => {
  // The owner's whole constraint on this feature: "only for notable npcs / mobs - not trash". The
  // roster is the entire gate. A mob that arms the prompt only because the USER watches it is by
  // definition already watched, so there is nothing to offer either way - but the flag is asserted
  // rather than reasoned about, because a future edit could make `arms` and the offer disagree.
  const m = inZone()
  m.setWatched(['Gorgalosk'])
  feed(m, death('Gorgalosk'))
  const p = m.snapshot(T0 + 1).state.prompt
  assert.equal(p?.mob, 'Gorgalosk')
  assert.equal(p?.offerWatch, false, 'trash the user watches is not a notable NPC')
})

test('GRANTING THE WATCH RETIRES THE OFFER, with no cancel channel', () => {
  // How pressing the button makes the question go away: the IPC handler writes the list and calls
  // `setWatched`, and the flags are RECOMPUTED per read rather than frozen at arm time. The card
  // here has both questions live, so it survives the grant - with the offer withdrawn.
  const bef = inZone('Befallen')
  feed(bef, death('Commander Windstream'))
  assert.equal(bef.snapshot(T0 + 1).state.prompt?.offerWatch, true)
  bef.setWatched(['commander windstream'])
  const after = bef.snapshot(T0 + 2).state.prompt
  assert.equal(after?.offerWatch, false, 'granted')
  assert.equal(after?.needsLoc, true, 'and the position is still wanted')
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
  feed(m, death('Commander Windstream'))
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
  feed(m, death('Commander Windstream'))
  assert.equal(m.snapshot(T0).state.prompt?.mob, 'Commander Windstream', 'up at the moment of death')
  assert.equal(m.snapshot(T0 + 1).state.prompt?.mob, 'Commander Windstream')
})

test('an immediate /loc still pins - the ask simply becomes its own receipt', () => {
  // What the grace period was really protecting against: a card telling you to do the thing you
  // just did. The toast channel dedupes on id, so the ask is REPLACED by the confirmation rather
  // than suppressed - which is the same outcome without the cost of a late card.
  const m = inZone()
  feed(m, death('Commander Windstream'))
  m.onEvent(loc(T0 + 500, 1558, -749, -137))
  const snap = m.snapshot(T0 + 600).state
  assert.equal(snap.prompt, undefined, 'answered, so nothing is still asking')
  const pin = snap.pins.pins[campKey('Commander Windstream', 'Befallen')]
  assert.deepEqual(
    { ns: pin.ns, ew: pin.ew, z: pin.z, mob: pin.mob, zone: pin.zone },
    { ns: 1558, ew: -749, z: -137, mob: 'Commander Windstream', zone: 'Befallen' }
  )
})

test('the card stands until SHOW closes, and not one tick longer', () => {
  const m = inZone()
  feed(m, death('Commander Windstream'))
  assert.ok(m.snapshot(T0 + CAMP_SHOW_MS - 1).state.prompt, 'still standing')
  assert.equal(m.snapshot(T0 + CAMP_SHOW_MS).state.prompt, undefined, 'show has closed')
})

test('a /loc after SHOW pins nothing - a stale question collects no answer', () => {
  // The whole reason this is not "join a kill to a nearby /loc": a position typed a minute later
  // is a fact about somewhere else, and recording it would be the inference this design refuses.
  const m = inZone()
  feed(m, death('Commander Windstream'))
  m.onTick(T0 + CAMP_SHOW_MS + 1)
  m.onEvent(loc(T0 + CAMP_SHOW_MS + 2))
  assert.deepEqual(m.snapshot(T0 + CAMP_SHOW_MS + 3).state.pins.pins, {})
})

// --- NAGGING ----------------------------------------------------------------

test('QUIET: an ignored prompt stops that mob asking again for a while', () => {
  const m = inZone()
  feed(m, death('Commander Windstream', T0))
  m.onTick(T0 + CAMP_SHOW_MS + 1) // ignored - the arm expires and the mob goes quiet
  // It respawns and dies again well inside the quiet window: no second question.
  feed(m, death('Commander Windstream', T0 + CAMP_SHOW_MS + 60_000))
  assert.equal(m.snapshot(T0 + CAMP_SHOW_MS + 60_001).state.prompt, undefined)
  // Past the quiet window it may ask again.
  const later = T0 + CAMP_SHOW_MS + CAMP_QUIET_MS + 1
  feed(m, death('Commander Windstream', later))
  assert.ok(m.snapshot(later + 1).state.prompt, 'the quiet has lapsed')
})

// --- ONE SLOT ---------------------------------------------------------------

test('ONE SLOT: a newer corpse replaces the pending question', () => {
  // Two questions cannot both be answered by the next `/loc`, and guessing which the player meant
  // is the ambiguity this app refuses. The newer corpse is the one being stood on.
  const m = inZone()
  m.setWatched(['Gorgalosk'])
  feed(m, death('Commander Windstream', T0))
  feed(m, death('Gorgalosk', T0 + 1000))
  assert.equal(m.snapshot(T0 + 1001).state.prompt?.mob, 'Gorgalosk')
  m.onEvent(loc(T0 + 2000))
  const pins = m.snapshot(T0 + 3000).state.pins.pins
  assert.deepEqual(Object.keys(pins), [campKey('Gorgalosk', 'Befallen')], 'only the newer was pinned')
})

test('a zone line ends the question - the corpse is behind you', () => {
  const m = inZone()
  feed(m, death('Commander Windstream'))
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
  const one = respawnWithWatch(empty, 'Commander Windstream', 'Commander Windstream')
  assert.deepEqual(one.watches, [{ key: 'commander windstream', display: 'Commander Windstream' }])
  // The key folds (law 2 - canonicalize at boundaries), so a name off a death line and a
  // hand-edited settings file land on the same entry.
  const mixed = respawnWithWatch(empty, '  COMMANDER Windstream ', 'Commander Windstream')
  assert.equal(mixed.watches[0].key, 'commander windstream')
  // Re-adding replaces; the list does not grow.
  const again = respawnWithWatch(one, 'Commander Windstream', 'Commander Windstream')
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


test('AN IGNORED WATCH OFFER IS A NO, and it does not come back next pop', () => {
  // MEASURED on the owner's log: QUIET is five minutes and a Guk named pops every ten, so an
  // unanswered offer returned on EVERY spawn - `a ghoul supplier` asked five times in forty
  // minutes at one camp. QUIET is the right clock for "where does it camp?" (a question about the
  // corpse in front of you) and the wrong one for "do you want a clock on this?" (a question about
  // the mob, whose answer does not change because it respawned).
  const guk = inZone('Lower Guk')
  feed(guk, death('the ghoul lord'))
  assert.equal(guk.snapshot(T0 + 1).state.prompt?.offerWatch, true)

  // Ignored: the show window closes with no answer.
  guk.onTick(T0 + CAMP_SHOW_MS + 1)
  assert.equal(guk.snapshot(T0 + CAMP_SHOW_MS + 2).state.prompt, undefined)

  // It pops again, well past QUIET. Nothing is asked: the only question it had was answered by
  // silence, and this mob's position is something the catalog already states.
  const later = T0 + CAMP_QUIET_MS + CAMP_SHOW_MS + 60_000
  feed(guk, death('the ghoul lord', later))
  assert.equal(guk.snapshot(later + 1).state.prompt, undefined, 'asked once, told no')
})

test('…but declining the WATCH does not silence the POSITION question', () => {
  // The two questions are about different things, so a no to one is not a no to the other. A mob
  // the wiki never placed still has something only the player can supply.
  const bef = inZone('Befallen')
  feed(bef, death('Commander Windstream'))
  bef.onTick(T0 + CAMP_SHOW_MS + 1)

  const later = T0 + CAMP_QUIET_MS + CAMP_SHOW_MS + 60_000
  feed(bef, death('Commander Windstream', later))
  const again = bef.snapshot(later + 1).state.prompt
  assert.equal(again?.needsLoc, true, 'the wiki still has not placed him')
  assert.equal(again?.offerWatch, false, 'but the watch was declined')
})
