// shared/logHistory.ts — THE PURE HALF of "rotating the log does not erase what you did".
//
// WHY THIS EXISTS. `shared/logArchive.ts` moves an oversized character log aside so the startup
// fold stops re-reading years of it. Everything the app knows from a log is RE-DERIVED on every
// launch (no module touches the store — that is the architecture, and it is a good one), so the
// moment a log is archived the Loot, Raid Targets and Leveling tabs go back to empty. Sky progress,
// inventory and gear plans survive because they were never in the log; these three did not.
//
// ============================================================================================
// TWO SHAPES, TWO MERGES, AND THE DIFFERENCE IS NOT COSMETIC.
// ============================================================================================
//
// LEDGERS — loot, and leveling's four arrays — are append-only lists of instants. Two sources
// merge by UNION with a dedupe on the row itself. This is `shared/questTurnIns.ts`'s pattern, which
// exists for exactly this reason ("persisted, so a truncated log or a character epoch cannot
// un-complete a quest") and carries the same honest limit: EQ stamps to the SECOND, so two
// identical rows in one second collapse into one. For a turn-in that shape is unrealistic. For
// LOOT it is not — a single corpse can yield two of an item in the same second — so the dedupe key
// carries `count` and the row's own fields rather than the instant alone, and identical rows from
// DIFFERENT buckets are the only ones that can collide (see `mergeRows`).
//
// AGGREGATES — kills — are counters (`count += 1`). Summing two sources double-counts, and that is
// not a hypothetical: JOS-231 is a whole post-mortem about seeding a fold with what it is about to
// re-derive. So kills follow `MessageOverlayMiner` instead: ONE BUCKET PER SOURCE, a re-fold
// DISCARDS its own bucket before refilling it, and the served value is the sum. Idempotence is
// structural rather than promised.
//
// ============================================================================================
// THE SOURCES, AND WHY 'live' IS SPECIAL.
// ============================================================================================
//
// A bucket is keyed by where its rows came from:
//   * `live`             — the character log the app is tailing RIGHT NOW. Rebuilt from scratch by
//                          every launch's fold, so it is DISCARDED and rewritten, never merged into.
//   * `archive:<file>`   — one rotated log, keyed by the archive's own filename. Written ONCE, at
//                          the rotation that created it, and never touched again.
//
// PROMOTION IS THE WHOLE TRICK. At rotation, the file being archived is precisely the file the
// PREVIOUS session folded into `live`. So the rotation does not need to read, parse or decompress
// anything: it renames the `live` bucket to `archive:<file>` and starts a new empty `live`. The
// expensive thing is never done, because the answer was already computed by the session that had
// the file open.
//
// A ZERO-IMPORT-BEYOND-TYPES module, the `shared/logArchive.ts` reason: storeMigrations.ts runs
// from store.ts's module scope and must be able to reach a normalizer without dragging anything
// behind it.

import type { AAEvent, AAPotionEvent, AASpendEvent, LevelEvent, LootEvent } from './types'
import { killTotals, type KillMap, type KillTierRun } from './kills'

/** The `live` bucket's key. Every other key is `archive:<filename>`. */
export const LIVE_SOURCE = 'live'

/** Build the bucket key for one rotated archive file. */
export function archiveSourceKey(archiveFileName: string): string {
  return `archive:${archiveFileName}`
}

/** Is this the rebuilt-every-launch bucket? */
export function isLiveSource(key: string): boolean {
  return key === LIVE_SOURCE
}

/**
 * What one source contributed. Every field is exactly the shape its module already snapshots, so
 * writing a bucket is a copy rather than a translation - there is no second spelling of a loot row
 * anywhere in the tree, and therefore nothing to drift.
 */
export interface HistoryBucket {
  loot: LootEvent[]
  levels: LevelEvent[]
  aaGains: AAEvent[]
  aaSpends: AASpendEvent[]
  aaPotions: AAPotionEvent[]
  kills: KillMap
}

/** The persisted blob: every source this character has ever had, keyed as above. */
export interface LogHistory {
  buckets: Record<string, HistoryBucket>
}

/** An empty bucket. Every reader defaults through this, so a partial stored bucket cannot crash. */
export function emptyBucket(): HistoryBucket {
  return { loot: [], levels: [], aaGains: [], aaSpends: [], aaPotions: [], kills: {} }
}

/** An empty history. */
export function emptyHistory(): LogHistory {
  return { buckets: {} }
}

/** Array-or-empty, defensively - a stored file is not a promise about its own shape. */
function rows<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/** Normalize one bucket from `unknown`, field by field. Never throws, never returns a partial. */
export function normalizeBucket(value: unknown): HistoryBucket {
  const v: Record<string, unknown> =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  return {
    loot: rows<LootEvent>(v.loot),
    levels: rows<LevelEvent>(v.levels),
    aaGains: rows<AAEvent>(v.aaGains),
    aaSpends: rows<AASpendEvent>(v.aaSpends),
    aaPotions: rows<AAPotionEvent>(v.aaPotions),
    kills:
      typeof v.kills === 'object' && v.kills !== null && !Array.isArray(v.kills)
        ? (v.kills as KillMap)
        : {}
  }
}

/** Normalize the whole blob. An absent or malformed history reads as "nothing archived yet". */
export function normalizeLogHistory(value: unknown): LogHistory {
  const v: Record<string, unknown> =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const src: Record<string, unknown> =
    typeof v.buckets === 'object' && v.buckets !== null && !Array.isArray(v.buckets)
      ? (v.buckets as Record<string, unknown>)
      : {}
  const buckets: Record<string, HistoryBucket> = {}
  for (const [key, bucket] of Object.entries(src)) buckets[key] = normalizeBucket(bucket)
  return { buckets }
}

// ---------------------------------------------------------------------------
// THE MERGES
// ---------------------------------------------------------------------------

/**
 * Union of ledger rows across buckets, in log order.
 *
 * A MULTISET UNION, TAKING THE MAX PER BUCKET - not a set. The distinction is the difference
 * between "merged two copies of the same history" and "deleted a player's loot", and the first
 * draft of this function got it wrong in the deleting direction.
 *
 * WHY NOT A PLAIN SET. EQ stamps to the SECOND and one corpse can yield two of an item inside a
 * single stamp, so two byte-identical loot rows in one bucket are two real drops. `questTurnIns`
 * can key on the instant alone because a trade is a deliberate multi-step act; loot cannot.
 *
 * WHY NOT A PLAIN CONCATENATION. Buckets are disjoint by construction (each describes its own
 * file's bytes, and `promoteLive` refuses to re-promote into an occupied key), so concatenating
 * would normally be right - but "normally" is doing a lot of work there, and the failure mode is
 * silent inflation of a number a user reads. Taking the MAX count any single bucket saw keeps
 * every genuine repeat and still collapses a row that two buckets both claim.
 *
 * Sorted by `ts` so a merged ledger reads in log order regardless of bucket iteration order.
 */
export function mergeRows<T extends { ts: number }>(lists: readonly (readonly T[])[]): T[] {
  /** key -> the row itself, and the most times ANY ONE bucket contained it. */
  const best = new Map<string, { row: T; n: number }>()
  for (const list of lists) {
    const here = new Map<string, number>()
    for (const row of list) {
      const key = JSON.stringify(row)
      here.set(key, (here.get(key) ?? 0) + 1)
      if (!best.has(key)) best.set(key, { row, n: 0 })
    }
    for (const [key, n] of here) {
      const cur = best.get(key)
      if (cur && n > cur.n) cur.n = n
    }
  }
  const out: T[] = []
  for (const { row, n } of best.values()) for (let i = 0; i < n; i++) out.push(row)
  return out.sort((a, b) => a.ts - b.ts)
}

/**
 * Sum KillMaps across buckets. Safe ONLY because each source has its own bucket and a re-fold
 * replaces its own (JOS-231) - this function adds, and adding is exactly what double-counts when
 * two buckets describe the same bytes.
 *
 * ONLY THE `tiers` MAP IS MERGED, AND THE SCALARS ARE RE-DERIVED. shared/kills.ts states the law
 * in its own header - *"`tiers` is the TRUTH. The four scalars are DERIVED from it (`killTotals`)
 * ... One fold writes the tiers map; nothing writes a scalar by hand"* - and a merge that authored
 * its own totals would be a second opinion about a number the app already knows how to compute.
 * `bestTier` is the sharp edge: `killTotals` seeds it at TIER_UNKNOWN rather than 0 precisely so an
 * open-world-only record cannot claim a base-instance clear, and a hand-rolled `Math.max(0, ...)`
 * silently reintroduces that bug.
 */
export function mergeKills(maps: readonly KillMap[]): KillMap {
  const tiersByMob: Record<string, Record<number, KillTierRun>> = {}
  const display: Record<string, string> = {}
  for (const map of maps) {
    for (const [key, entry] of Object.entries(map)) {
      display[key] ??= entry.display
      const tiers = (tiersByMob[key] ??= {})
      for (const [tierKey, run] of Object.entries(entry.tiers)) {
        const tier = Number(tierKey)
        const t = (tiers[tier] ??= {
          count: 0,
          firstTs: 0,
          lastTs: 0,
          credited: 0,
          lastCreditedTs: 0
        })
        t.count += run.count
        t.credited += run.credited
        t.lastTs = Math.max(t.lastTs, run.lastTs)
        t.lastCreditedTs = Math.max(t.lastCreditedTs, run.lastCreditedTs)
        t.firstTs = t.firstTs === 0 ? run.firstTs : Math.min(t.firstTs, run.firstTs)
      }
    }
  }
  const out: KillMap = {}
  for (const [key, tiers] of Object.entries(tiersByMob)) {
    out[key] = { ...killTotals(tiers), display: display[key], tiers }
  }
  return out
}

/**
 * Everything EXCEPT the live bucket, merged - the seed a module is given before the fold runs.
 *
 * The live bucket is excluded because the fold is about to re-derive it from the very bytes it
 * describes. Including it is the JOS-231 defect exactly, and it would be invisible in testing on a
 * machine that has never rotated (where the live bucket is the only one there is).
 */
export function archivedSeed(history: LogHistory): HistoryBucket {
  const archived = Object.entries(history.buckets)
    .filter(([key]) => !isLiveSource(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, bucket]) => bucket)
  return {
    loot: mergeRows(archived.map((b) => b.loot)),
    levels: mergeRows(archived.map((b) => b.levels)),
    aaGains: mergeRows(archived.map((b) => b.aaGains)),
    aaSpends: mergeRows(archived.map((b) => b.aaSpends)),
    aaPotions: mergeRows(archived.map((b) => b.aaPotions)),
    kills: mergeKills(archived.map((b) => b.kills))
  }
}

/**
 * Rename the `live` bucket to `archive:<file>` and leave a fresh empty `live` behind.
 *
 * PURE, and returns a NEW history rather than mutating, so the caller writes once and a failure
 * anywhere leaves the stored value untouched. Called at rotation - see logHistory.ts's header for
 * why this needs to read nothing off disk.
 *
 * If a bucket for that archive somehow already exists it is NOT overwritten and the live bucket is
 * still cleared: re-promoting into an occupied key is the one way this design could double-count,
 * and the honest answer to "we already recorded that file" is to keep what is there.
 */
export function promoteLive(history: LogHistory, archiveFileName: string): LogHistory {
  const key = archiveSourceKey(archiveFileName)
  // Rebuilt WITHOUT the live key rather than deleted out of a copy - same result, and it keeps the
  // "live is gone" guarantee a property of how the object is constructed.
  const buckets: Record<string, HistoryBucket> = {}
  for (const [k, bucket] of Object.entries(history.buckets)) {
    if (!isLiveSource(k)) buckets[k] = bucket
  }
  const live = history.buckets[LIVE_SOURCE]
  if (live && !(key in buckets)) buckets[key] = live
  return { buckets }
}
