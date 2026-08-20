// storeLogHistory.ts — the persisted half of "rotating the log does not erase what you did".
//
// A SEVENTH MODULE THROUGH THE `settingsStore` DOOR (uiScale.ts, storeRespawn.ts,
// storeSoundPacks.ts, storeOverlaySnap.ts, storeProcessPriority.ts, storeLogArchive.ts): store.ts
// sits at the repo's 400-code-line factoring ceiling and the stated answer to that is a split.
//
// PER CHARACTER, AND ITS OWN TOP-LEVEL KEY rather than a field on `ProgressState`. Everything
// under `byCharacter` is a statement of the USER'S intent or knowledge — an inventory dump they
// exported, quests they turned in, a wishlist they wrote. This is none of those: it is a cache of
// what the fold already derived, kept only because the bytes it came from were archived away.
// Mixing the two would make a future "reset my progress" and a future "re-read my archives" the
// same button, and they are not.
//
// NO SCHEMA BUMP, by the rule storeLogArchive.ts spells out: the additive-optional carve-out is
// for keys whose absence already means today's behaviour. An absent `logHistory` means "nothing
// has been archived, so the fold is the whole truth" — exactly what every store written before
// this commit meant, and exactly what a store on a machine that never enables archiving keeps
// meaning forever.
//
// WHAT the buckets are, why `live` is special, and how the two merges differ all live in
// shared/logHistory.ts. This file is storage and nothing else.

import { settingsStore } from './store'
import {
  emptyHistory,
  normalizeLogHistory,
  promoteLive,
  type HistoryBucket,
  type LogHistory,
  LIVE_SOURCE
} from '../shared/logHistory'

/** Every character's history, defaulted. Never throws, never returns a partial. */
function allHistories(): Record<string, LogHistory> {
  const raw = settingsStore.get('logHistory')
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, LogHistory> = {}
  for (const [charId, value] of Object.entries(raw as Record<string, unknown>)) {
    out[charId] = normalizeLogHistory(value)
  }
  return out
}

/** One character's history. An unknown character reads as "nothing archived". */
export function getLogHistory(charId: string): LogHistory {
  return allHistories()[charId] ?? emptyHistory()
}

/** Replace one character's history, leaving every other character's alone. */
export function setLogHistory(charId: string, history: LogHistory): void {
  settingsStore.set('logHistory', { ...allHistories(), [charId]: history })
}

/**
 * Write the `live` bucket — what THIS session has folded out of the log it is tailing.
 *
 * It REPLACES rather than merges, which is the JOS-231 discipline restated in one line: the live
 * bucket describes bytes the next fold will read again, so the only correct write is the whole
 * current answer. Merging would add a session's rows to the previous session's copy of the same
 * rows, and the sum is what a user would read as their loot count.
 */
export function setLiveBucket(charId: string, bucket: HistoryBucket): void {
  const history = getLogHistory(charId)
  setLogHistory(charId, { buckets: { ...history.buckets, [LIVE_SOURCE]: bucket } })
}

/**
 * Rotation just archived `archiveFileName`; the live bucket is what that file contained, so it
 * becomes that archive's permanent bucket and a fresh empty live starts. See `promoteLive` for
 * why this reads nothing off disk and why re-promoting keeps what is already recorded.
 */
export function promoteLiveBucket(charId: string, archiveFileName: string): void {
  setLogHistory(charId, promoteLive(getLogHistory(charId), archiveFileName))
}
