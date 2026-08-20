// LOG HISTORY — what survives a rotation, and the two merges that make it survive CORRECTLY.
//
// The feature is small; the ways it can be quietly wrong are not, and both of them already have
// post-mortems in this repo:
//   * JOS-231 — seeding a fold with what it is about to re-derive. Here that is the `live` bucket,
//     and `archivedSeed` excluding it is the single line the whole design rests on. A machine that
//     has never rotated has ONLY a live bucket, so this defect is invisible in casual testing and
//     doubles every count the moment a user rotates. It is asserted first and hardest.
//   * shared/kills.ts's own law — "`tiers` is the TRUTH. The four scalars are DERIVED from it
//     (`killTotals`) ... nothing writes a scalar by hand." A merge that authors its own totals
//     passes every count assertion and still reintroduces the `bestTier` bug killTotals exists to
//     prevent, so that is asserted on the TIER KEY, not on the count.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LIVE_SOURCE,
  archiveSourceKey,
  archivedSeed,
  emptyBucket,
  emptyHistory,
  mergeKills,
  mergeRows,
  normalizeLogHistory,
  promoteLive,
  type HistoryBucket,
  type LogHistory
} from '../src/shared/logHistory'
import { TIER_OPEN_WORLD, TIER_UNKNOWN, killTotals, type KillMap } from '../src/shared/kills'
import type { LootEvent } from '../src/shared/types'

// --- helpers ----------------------------------------------------------------

const loot = (ts: number, item: string, count?: number): LootEvent =>
  count === undefined ? { ts, item } : { ts, item, count }

/** A KillMap with one mob, one tier run — built the way the fold builds it (tiers first). */
function kills(mob: string, spec: { tier: number; count: number; firstTs: number; lastTs: number }): KillMap {
  const { tier, count, firstTs, lastTs } = spec
  const tiers = { [tier]: { count, firstTs, lastTs, credited: count, lastCreditedTs: lastTs } }
  return { [mob]: { ...killTotals(tiers), display: mob, tiers } }
}

function bucket(over: Partial<HistoryBucket>): HistoryBucket {
  return { ...emptyBucket(), ...over }
}

// --- THE DEFECT THIS DESIGN EXISTS TO AVOID ---------------------------------

test('archivedSeed: the LIVE bucket is never part of the seed (JOS-231)', () => {
  // The whole design in one assertion. The fold is about to re-derive `live` from the very bytes
  // it describes, so seeding with it double-counts everything — and on a machine that has never
  // rotated, `live` is the ONLY bucket, which is why this cannot be left to casual testing.
  const history: LogHistory = {
    buckets: {
      [LIVE_SOURCE]: bucket({ loot: [loot(300, 'Cloak')], kills: kills('a gnoll', { tier: 0, count: 5, firstTs: 300, lastTs: 300 }) }),
      [archiveSourceKey('eqlog_A_b-20260817-120000.txt.gz')]: bucket({
        loot: [loot(100, 'Sword')],
        kills: kills('a gnoll', { tier: 0, count: 2, firstTs: 100, lastTs: 100 })
      })
    }
  }
  const seed = archivedSeed(history)
  assert.deepEqual(seed.loot, [loot(100, 'Sword')], 'only the archived row seeds')
  assert.equal(seed.kills['a gnoll'].count, 2, 'the live 5 kills are NOT in the seed')
})

test('archivedSeed: a history with only a live bucket seeds nothing at all', () => {
  // The never-rotated machine — the common case, and the one where a wrong answer hides.
  const history: LogHistory = {
    buckets: { [LIVE_SOURCE]: bucket({ loot: [loot(1, 'Sword')], kills: kills('a rat', { tier: 0, count: 9, firstTs: 1, lastTs: 1 }) }) }
  }
  assert.deepEqual(archivedSeed(history), emptyBucket())
})

test('archivedSeed: several archives merge, in a deterministic order', () => {
  const history: LogHistory = {
    buckets: {
      [archiveSourceKey('eqlog_A_b-20260817-120000.txt.gz')]: bucket({ loot: [loot(100, 'Sword')] }),
      [archiveSourceKey('eqlog_A_b-20260601-090000.txt.gz')]: bucket({ loot: [loot(50, 'Shield')] }),
      [LIVE_SOURCE]: bucket({ loot: [loot(900, 'Cloak')] })
    }
  }
  // Sorted by ts regardless of which bucket they came from, and the live row is absent.
  assert.deepEqual(archivedSeed(history).loot, [loot(50, 'Shield'), loot(100, 'Sword')])
})

// --- PROMOTION --------------------------------------------------------------

test('promoteLive: the live bucket becomes the archive, and live starts empty', () => {
  const file = 'eqlog_Taelenya_rivervale-20260818-214124.txt.gz'
  const before: LogHistory = { buckets: { [LIVE_SOURCE]: bucket({ loot: [loot(1, 'Sword')] }) } }
  const after = promoteLive(before, file)
  assert.deepEqual(Object.keys(after.buckets), [archiveSourceKey(file)])
  assert.deepEqual(after.buckets[archiveSourceKey(file)].loot, [loot(1, 'Sword')])
  assert.equal(after.buckets[LIVE_SOURCE], undefined, 'live is cleared, not carried')
  // PURE: the input is untouched, so a caller that fails to write leaves the store as it was.
  assert.deepEqual(before.buckets[LIVE_SOURCE].loot, [loot(1, 'Sword')])
})

test('promoteLive: re-promoting into an occupied key keeps what is there and still clears live', () => {
  // The one way this design could double-count: two rotations naming the same archive file. The
  // honest answer to "we already recorded that file" is to keep the recorded copy.
  const file = 'eqlog_A_b-20260818-214124.txt.gz'
  const history: LogHistory = {
    buckets: {
      [archiveSourceKey(file)]: bucket({ loot: [loot(1, 'Sword')] }),
      [LIVE_SOURCE]: bucket({ loot: [loot(2, 'Cloak')] })
    }
  }
  const after = promoteLive(history, file)
  assert.deepEqual(after.buckets[archiveSourceKey(file)].loot, [loot(1, 'Sword')], 'not overwritten')
  assert.equal(after.buckets[LIVE_SOURCE], undefined, 'and live is still cleared')
})

test('promoteLive: nothing to promote is not an error', () => {
  assert.deepEqual(promoteLive(emptyHistory(), 'x.txt.gz'), emptyHistory())
})

// --- LEDGER MERGE -----------------------------------------------------------

test('mergeRows: identical rows from two buckets collapse; genuinely repeated rows do not', () => {
  // The dedupe is on the WHOLE ROW, not the instant, and the difference is real: EQ stamps to the
  // second, and one corpse can yield two of an item inside a single stamp. Both are real loot.
  const twoInOneSecond = [loot(100, 'Bone Chips'), loot(100, 'Bone Chips')]
  assert.equal(mergeRows([twoInOneSecond]).length, 2, 'a genuine repeat survives within a bucket')
  // …but the SAME row present in two buckets (an interrupted promotion) is one row.
  assert.deepEqual(mergeRows([[loot(1, 'Sword')], [loot(1, 'Sword')]]), [loot(1, 'Sword')])
  // A field that differs makes them different rows.
  assert.equal(mergeRows([[loot(1, 'Sword', 1)], [loot(1, 'Sword', 2)]]).length, 2)
})

test('mergeRows: output is in log order across buckets', () => {
  const merged = mergeRows([[loot(300, 'C'), loot(100, 'A')], [loot(200, 'B')]])
  assert.deepEqual(merged.map((r) => r.item), ['A', 'B', 'C'])
})

test('mergeRows: empty input is empty output', () => {
  assert.deepEqual(mergeRows<LootEvent>([]), [])
  assert.deepEqual(mergeRows<LootEvent>([[], []]), [])
})

// --- AGGREGATE MERGE --------------------------------------------------------

test('mergeKills: counts add across buckets and timestamps span both', () => {
  const merged = mergeKills([kills('a gnoll', { tier: 0, count: 2, firstTs: 100, lastTs: 150 }), kills('a gnoll', { tier: 0, count: 5, firstTs: 900, lastTs: 950 })])
  const entry = merged['a gnoll']
  assert.equal(entry.count, 7)
  assert.equal(entry.credited, 7)
  assert.equal(entry.firstTs, 100, 'the earliest first')
  assert.equal(entry.lastTs, 950, 'the latest last')
  assert.equal(entry.tiers[0].count, 7)
})

test('mergeKills: the scalars are DERIVED, never authored — bestTier is the tripwire', () => {
  // shared/kills.ts's law. `killTotals` seeds bestTier at TIER_UNKNOWN rather than 0 precisely so
  // an open-world-only record cannot claim a base-instance clear; a hand-rolled Math.max(0, ...)
  // passes every COUNT assertion above and silently reintroduces exactly that bug.
  const openWorldOnly = mergeKills([
    kills('a gnoll', { tier: TIER_OPEN_WORLD, count: 1, firstTs: 100, lastTs: 100 }),
    kills('a gnoll', { tier: TIER_OPEN_WORLD, count: 1, firstTs: 200, lastTs: 200 })
  ])
  assert.equal(openWorldOnly['a gnoll'].bestTier, TIER_OPEN_WORLD)
  assert.notEqual(openWorldOnly['a gnoll'].bestTier, 0, 'never a base-instance clear it never made')
  // And the merged record agrees with the app's own derivation of its own tiers.
  const entry = openWorldOnly['a gnoll']
  assert.deepEqual(
    { count: entry.count, bestTier: entry.bestTier, firstTs: entry.firstTs, lastTs: entry.lastTs, credited: entry.credited },
    killTotals(entry.tiers),
    'the record is exactly what killTotals says its own tiers mean'
  )
  // An empty tiers map folds to TIER_UNKNOWN, not to a tier-0 claim.
  assert.equal(mergeKills([{ x: { ...killTotals({}), display: 'x', tiers: {} } }]).x.bestTier, TIER_UNKNOWN)
})

test('mergeKills: different mobs and different tiers stay separate', () => {
  const merged = mergeKills([
    kills('a gnoll', { tier: 0, count: 1, firstTs: 100, lastTs: 100 }),
    kills('a gnoll', { tier: 3, count: 2, firstTs: 200, lastTs: 200 }),
    kills('a rat', { tier: 0, count: 4, firstTs: 300, lastTs: 300 })
  ])
  assert.equal(merged['a gnoll'].count, 3)
  assert.equal(merged['a gnoll'].bestTier, 3, 'the best tier across runs')
  assert.deepEqual(Object.keys(merged['a gnoll'].tiers).sort(), ['0', '3'])
  assert.equal(merged['a rat'].count, 4)
})

test('mergeKills: nothing in, nothing out', () => {
  assert.deepEqual(mergeKills([]), {})
  assert.deepEqual(mergeKills([{}, {}]), {})
})

// --- NORMALIZATION ----------------------------------------------------------

test('normalizeLogHistory: a malformed or absent blob reads as nothing archived', () => {
  for (const bad of [undefined, null, 'nope', [], 42, { buckets: 'no' }, { buckets: [] }]) {
    assert.deepEqual(normalizeLogHistory(bad), emptyHistory(), `for ${JSON.stringify(bad)}`)
  }
})

test('normalizeLogHistory: a partial bucket is completed, never dropped', () => {
  // A store file is not a promise about its own shape; a bucket carrying only loot must still
  // yield a usable bucket rather than crash a reader that asks for aaGains.
  const h = normalizeLogHistory({ buckets: { live: { loot: [loot(1, 'Sword')] } } })
  assert.deepEqual(h.buckets.live.loot, [loot(1, 'Sword')])
  assert.deepEqual(h.buckets.live.aaGains, [])
  assert.deepEqual(h.buckets.live.kills, {})
})
