// `/loc` FROM THE LOG — the one positional line EQ Legends writes, and the only one.
//
// THIS LINE WAS BELIEVED NOT TO EXIST. renderer/features/maps/locMarker.ts states as a measurement
// that `Your Location` appears ZERO times across the owner's whole 116.8 MB log, and concludes
// "/loc answers in the game window and is never written to the file the app tails" — which is why
// the map marker shipped as a PASTE box. The measurement was true and the conclusion was not: the
// owner had never typed the command.
//
// THE SAMPLE THAT GRADUATED IT (this repo's awaiting-sample law), measured 2026-08-19 on a
// reporter's live EQ Legends log: ZERO occurrences in a 253 MB archive of ordinary play, then TWO
// sixteen seconds apart the moment the player typed `/loc`, confirmed by the player. Both are
// reproduced verbatim below and are the reason this parser exists.
//
// WHY THIS PARSER IS STRICT WHERE ITS COUSIN IS FORGIVING: `locMarker.ts parseLoc` reads a HUMAN
// PASTE and accepts two numbers or three, commas or whitespace, a stray timestamp. This one reads
// the sentence the GAME prints. Slack here does not help a user - it lets a line that merely
// contains the right words move a marker. Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'

const STAMP = '[Wed Aug 19 22:30:32 2026] '

/** Parse a body as if the game had logged it, and hand back the event kind + the event. */
function ev(body: string): ReturnType<typeof parseEvent> {
  return parseEvent(STAMP + body, 0)
}

test('classifyLoc: the two REAL lines, verbatim from the log that graduated this shape', () => {
  const a = ev('Your Location is 1918.98, 144.79, 30.07')
  assert.equal(a?.kind, 'loc')
  if (a?.kind !== 'loc') return
  // ORDER IS THE WHOLE POINT: /loc prints north/south, then west/east, then elevation.
  assert.equal(a.ns, 1918.98)
  assert.equal(a.ew, 144.79)
  assert.equal(a.z, 30.07)
  // The second reading, sixteen seconds later, standing still - identical numbers.
  const b = ev('Your Location is 1918.98, 144.79, 30.07')
  assert.deepEqual(b?.kind === 'loc' ? [b.ns, b.ew, b.z] : null, [1918.98, 144.79, 30.07])
})

test('classifyLoc: negative coordinates - most of the world is negative on one axis', () => {
  // The shape locMarker.ts reverse-engineered from a wiki walkthrough (page-15280) before anyone
  // had seen the game print one. It parses here identically, which is the cross-check.
  const e = ev('Your Location is -192.19, -129.81, 3.26')
  assert.equal(e?.kind, 'loc')
  if (e?.kind !== 'loc') return
  assert.deepEqual([e.ns, e.ew, e.z], [-192.19, -129.81, 3.26])
})

test('classifyLoc: whole numbers and a zero elevation still read as a position', () => {
  const e = ev('Your Location is 100, -50, 0')
  assert.equal(e?.kind, 'loc')
  if (e?.kind !== 'loc') return
  assert.deepEqual([e.ns, e.ew, e.z], [100, -50, 0])
})

test('classifyLoc: REFUSES everything that is not the sentence the game prints', () => {
  // THE POINT OF THE STRICTNESS. Each of these would be accepted by the renderer's paste parser,
  // and each of them placing a marker off a log line would be a lie about where the player was.
  const refused = [
    // Two numbers. A paste may omit elevation; the game never does.
    'Your Location is 1918.98, 144.79',
    // Four. Whatever this is, it is not a position.
    'Your Location is 1918.98, 144.79, 30.07, 5',
    // Prose that starts the same way.
    'Your Location is over there',
    'Your Location is unknown.',
    // A trailing period - the game's sentence has none, and accepting one is invented slack.
    'Your Location is 1918.98, 144.79, 30.07.',
    // Whitespace instead of comma-and-space. The paste parser takes it; the game does not print it.
    'Your Location is 1918.98 144.79 30.07',
    // THE ONE THAT MATTERS: a third party saying the words. It cannot be anchored away by the
    // timestamp (every line has one), so what refuses it is that a chat line never begins with
    // these words - the speaker's name and verb come first.
    "Bob tells you, 'Your Location is 1, 2, 3'",
    'Bob says, Your Location is 1, 2, 3'
  ]
  for (const body of refused) {
    const e = ev(body)
    assert.notEqual(e?.kind, 'loc', `must not read as a position: ${body}`)
  }
})

test('classifyLoc: an ordinary log line is untouched by the new rule', () => {
  // The cascade gained a classifier; nothing it already understood may change kind. A zone line
  // and a kill line are the two neighbours most likely to be disturbed by a mis-ordered cascade.
  assert.equal(ev('You have entered Freeport.')?.kind, 'zone')
  assert.equal(ev('You have slain a spectre!')?.kind, 'death')
})
