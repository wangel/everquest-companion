// THE `/loc` READING — real log lines, through the real parser, into the real module.
//
// tests/parseLoc.test.mts pins the SENTENCE. This pins what the fold does with it: the zone tag,
// the epoch reset, and the delta. Driven end to end through `parseEvent` rather than by
// hand-built events, because the thing most likely to break here is the seam between the two (a
// classifier that stops firing takes the module's tests with it only if they go through it).
//
// THE HONESTY THIS FILE GUARDS: a reading is a fact about an INSTANT. `/loc` answers only when
// typed, so the module may never invent a position for the time between two readings, and it must
// carry each reading's own timestamp so a surface can say how old it is.
//
// AND THERE IS NO TRAIL, BY RULING. Keeping a history would exist only to draw a line between the
// points, and that line asserts a route through walls that nobody walked. The module keeps ONE
// reading; `owner ruling 2026-08-20` and loc.ts's header carry the argument. Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { LocModule } from '../src/main/modules/loc'
import type { LogEvent } from '../src/shared/logEvents'

const STAMP = '[Wed Aug 19 22:30:32 2026] '

/** Fold a sequence of raw log bodies through the real parser into a fresh module. */
function fold(bodies: readonly string[]): LocModule {
  const mod = new LocModule()
  let seq = 0
  for (const body of bodies) {
    const ev = parseEvent(STAMP + body, seq++) as LogEvent | null
    if (ev) mod.onEvent(ev)
  }
  return mod
}

test('a typed /loc becomes a reading, tagged with the zone the fold stands in', () => {
  const mod = fold([
    'You have entered Freeport.',
    'Your Location is 1918.98, 144.79, 30.07'
  ])
  const cur = mod.snapshot().state.current
  assert.ok(cur, 'a reading was folded')
  assert.deepEqual(
    { ns: cur.ns, ew: cur.ew, z: cur.z, zone: cur.zone },
    { ns: 1918.98, ew: 144.79, z: 30.07, zone: 'Freeport' }
  )
  // THE TIMESTAMP IS NOT DECORATION - it is what lets a surface say how old the marker is.
  assert.ok(cur.ts > 0, 'the reading carries the instant it was printed')
})

test('a reading before any zone line is kept, and simply says nothing about where', () => {
  // The fold can begin mid-log. A reading with no zone is still a real position; refusing it or
  // guessing a zone would both be worse than saying nothing (law 1).
  const mod = fold(['Your Location is 10, 20, 30'])
  const cur = mod.snapshot().state.current
  assert.ok(cur)
  assert.equal(cur.zone, undefined, 'absent, never an invented zone')
})

test('a zone line re-tags only what comes AFTER it, never what came before', () => {
  // Zone-tagged PER ROW is the point: a later zone line must not retroactively re-file an earlier
  // reading into a zone the player was not standing in.
  const mod = fold([
    'You have entered Freeport.',
    'Your Location is 1, 1, 1',
    'You have entered Everfrost.',
    'Your Location is 2, 2, 2'
  ])
  // The newest reading carries the zone that was current when IT was printed.
  assert.equal(mod.snapshot().state.current?.zone, 'Everfrost')
})

test('a newer reading REPLACES the older one - nothing accumulates', () => {
  // The ruling, asserted directly: there is no history, because a history exists only to draw a
  // line between points and that line is a route nobody walked.
  const mod = fold([
    'You have entered Freeport.',
    'Your Location is 1, 1, 1',
    'Your Location is 2, 2, 2',
    'Your Location is 3, 3, 3'
  ])
  assert.equal(mod.snapshot().state.current?.ns, 3)
})

test('an epoch boundary disowns the reading - a dead character stood somewhere else', () => {
  const mod = fold(['You have entered Freeport.', 'Your Location is 1, 1, 1'])
  assert.ok(mod.snapshot().state.current)
  mod.onEvent({ kind: 'epoch', seq: 99, ts: 1, raw: '' } as LogEvent)
  assert.equal(mod.snapshot().state.current, null, 'the reading is gone')
  // …and the ZONE survives it, because a zone is world state rather than something the dead
  // character owned (loot.ts takes the same position). Proven by folding another reading with no
  // second zone line: it is still tagged Freeport.
  const ev = parseEvent(`${STAMP}Your Location is 5, 5, 5`, 100) as LogEvent | null
  if (ev) mod.onEvent(ev)
  assert.equal(mod.snapshot().state.current?.zone, 'Freeport')
})

test('the delta carries the new reading, then empties', () => {
  const mod = fold(['You have entered Freeport.', 'Your Location is 1, 1, 1'])
  const first = mod.flushDelta()
  assert.equal(first?.delta.current.ns, 1)
  assert.equal(first?.delta.current.zone, 'Freeport')
  assert.equal(mod.flushDelta(), null, 'nothing new means no delta at all')
})

test('reset clears everything', () => {
  const mod = fold(['You have entered Freeport.', 'Your Location is 1, 1, 1'])
  mod.reset()
  assert.deepEqual(mod.snapshot().state, { current: null })
  assert.equal(mod.flushDelta(), null)
})
