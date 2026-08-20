// YOUR OWN PET, DYING — `log/reducers.ts` `isOwnPetDeath` / `isCountedKill`.
//
// THE REPORT: a user opened the Timers tab and found `Taelenya`s warder · 1 kill` in the
// Recently-killed list, offering a Watch button — a respawn clock on a mob that does not exist.
// Their beastlord pet had been killed by a reanimated hand, and EverQuest names a summoned pet
// after its owner:
//
//   [Thu Aug 20 13:36:07 2026] Taelenya`s warder has been slain by a reanimated hand!
//
// which is grammatically identical to any other mob death. Measured over that log: 16 of them,
// and the kill tracker had counted every one.
//
// WHAT MAKES THIS SAFE rather than a guess about name shapes. The possessive is only ever matched
// against the name the app KNOWS is the player's — installed at `resetWorldFor` by the same path
// and at the same instant the parser and the group roster learn it. Somebody ELSE's pet is not
// this filter's business: that death happened in the world.
//
// Pure — no Electron, no fixtures, never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCountedKill, isOwnPetDeath } from '../src/main/log/reducers'
import type { LogEvent } from '../src/shared/logEvents'

type Death = Extract<LogEvent, { kind: 'death' }>
const death = (name: string, killer?: string): Death => ({
  kind: 'death',
  seq: 0,
  ts: 1_770_000_000_000,
  raw: '',
  name,
  bySelf: killer === undefined,
  ...(killer === undefined ? {} : { killer })
})

test('the reported line: your own warder is not a kill', () => {
  const ev = death('Taelenya`s warder', 'a reanimated hand')
  assert.equal(isCountedKill(ev), true, 'without the name, exactly as it always behaved')
  assert.equal(isCountedKill(ev, 'Taelenya'), false, 'with it, the pet is not a mob')
})

test('BOTH apostrophes, because the game and everything else disagree', () => {
  // The game writes a backtick; a name pasted through anything else arrives with a straight quote.
  assert.equal(isOwnPetDeath('Taelenya`s warder', 'Taelenya'), true)
  assert.equal(isOwnPetDeath("Taelenya's warder", 'Taelenya'), true)
  // …and case is dirty on both sides, like every other name join in this app (law 2).
  assert.equal(isOwnPetDeath('taelenya`s WARDER', 'Taelenya'), true)
})

test("somebody ELSE's pet is still a death in the world", () => {
  // The whole reason this is keyed on a known name rather than on the possessive shape. Another
  // player's warder dying is not ours to reinterpret.
  assert.equal(isOwnPetDeath('Spiritbomb`s warder', 'Taelenya'), false)
  assert.equal(isCountedKill(death('Spiritbomb`s warder', 'a wan ghoul knight'), 'Taelenya'), true)
})

test('REAL MOBS SURVIVE, including the ones that look like names', () => {
  // The failure this test exists to catch is a filter that quietly eats named mobs. No EverQuest
  // mob is named after your character, which is the entire safety argument.
  for (const mob of ['a reanimated hand', 'Innoruuk, the Prince of Hate', 'Cazic-Thule', 'Hoptor Thaggelum']) {
    assert.equal(isOwnPetDeath(mob, 'Taelenya'), false, mob)
  }
})

test('a mob that merely STARTS with your name is not your pet', () => {
  // The possessive is load-bearing: the separator is `\u0060s ` / `'s `, never a bare prefix.
  assert.equal(isOwnPetDeath('Taelenya the Betrayer', 'Taelenya'), false)
  assert.equal(isOwnPetDeath('Taelenyas warder', 'Taelenya'), false)
})

test('no name installed, and an empty one, change nothing', () => {
  // A module that has not been told behaves exactly as it always did — the filter must never
  // strengthen silently underneath a caller with no owner.
  assert.equal(isOwnPetDeath('Taelenya`s warder', undefined), false)
  assert.equal(isOwnPetDeath('Taelenya`s warder', '   '), false)
})

test('the pre-existing rule is untouched: your own slain-by twin still drops', () => {
  assert.equal(isCountedKill(death('a ghoul assassin', 'You'), 'Taelenya'), false)
  assert.equal(isCountedKill(death('a ghoul assassin'), 'Taelenya'), true)
})
