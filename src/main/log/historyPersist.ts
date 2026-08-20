// log/historyPersist.ts — keeping the three history modules alive across a rotation.
//
// shared/logHistory.ts is the pure core (what a bucket is, how two of them merge, why `live` is
// special); storeLogHistory.ts is the storage. This file is the only place that knows WHEN.
//
// ============================================================================================
// THE CADENCE, AND WHY IT IS NOT JUST "ON EXIT".
// ============================================================================================
//
// The obvious precedent is `markTailPosition`, which writes only at an orderly exit and says so:
// *"A launch that is KILLED still writes nothing, and that is intended rather than a gap."* That
// reasoning does NOT transfer here, and the difference is the consequence. A lost tail mark costs
// the next launch a measurement. A lost history bucket costs the USER their loot, kills and
// levelling — permanently, because the rotation that follows promotes whatever the bucket holds
// and the bytes it should have described are by then compressed into an archive. Same mechanism,
// different stakes.
//
// It is also not a small window. Exit-only does not expose "the last few minutes", it exposes the
// WHOLE SESSION: a crash at hour six leaves the bucket holding whatever the previous clean exit
// wrote, and the fold cannot repair it afterwards because the file has moved.
//
// So there are three moments, and the first one does most of the work:
//   1. AFTER THE REPLAY. One write, as soon as the historical fold finishes. That single write
//      captures essentially the entire history (a 3M-event log's worth) within seconds of startup,
//      which closes the window for the part that matters most.
//   2. EVERY `HISTORY_WRITE_INTERVAL_MS`, AND ONLY IF DIRTY. After hydration the bucket only grows
//      by live play, so these are small and usually skipped outright. The interval is taken from
//      telemetry `flush.ts`'s FLUSH_INTERVAL_MS for the same reason it was chosen there: every
//      write is a COMPLETE restatement, so batching harder loses nothing.
//   3. AT THE ORDERLY EXIT, beside `markTailPosition`, which is the existing seam for exactly this.
//
// Worst-case loss is therefore one interval of live play, not a session.
//
// ============================================================================================
// WHAT IS WRITTEN IS THE LIVE HALF ONLY.
// ============================================================================================
//
// Each module serves `snapshot()` MERGED (archived + live) so a tab shows a whole history, and
// `liveRows()` / `liveSnap()` / `liveKills()` live-only. This file writes the LIVE half, and that
// is not a detail: the `live` bucket describes the bytes the next fold will read again, and the
// rotation after it promotes that bucket wholesale. Writing the merged view would record every
// archived row a second time — JOS-231's defect, arriving one rotation later than it was made.

import { characterId } from './config'
import { killsModule, levelingModule, lootModule } from '../pipeline'
import { getLogHistory, promoteLiveBucket, setLiveBucket } from '../storeLogHistory'
import { archivedSeed } from '../../shared/logHistory'
import { logError } from '../errorLog'
import type { CharacterRef } from '../../shared/types'

/** How often a dirty bucket is written while the app runs. telemetry flush.ts's number, its reason. */
export const HISTORY_WRITE_INTERVAL_MS = 5 * 60_000

/** The character whose bucket the timer writes. Null between characters and before the first tail. */
let activeCharId: string | null = null
/** Has anything been folded since the last write? A clean tick does no I/O at all. */
let dirty = false
let timer: NodeJS.Timeout | null = null

/**
 * Seed the three modules with what archived logs contributed — called from `resetWorldFor`, before
 * the scan folds a single line, beside the two `beginSource` calls that are there for the same
 * JOS-231 reason.
 *
 * `archivedSeed` excludes the `live` bucket by construction. That exclusion is the whole design:
 * the fold is about to re-derive `live` from the very bytes it describes, and on a machine that has
 * never rotated `live` is the ONLY bucket there is — so getting this wrong is invisible until the
 * first rotation and then doubles everything.
 */
export function seedArchivedHistory(ref: CharacterRef): void {
  const charId = characterId(ref)
  activeCharId = charId
  dirty = false
  try {
    const seed = archivedSeed(getLogHistory(charId))
    lootModule.setArchived(seed.loot)
    levelingModule.setArchived(seed)
    killsModule.setArchived(seed.kills)
  } catch (err) {
    // A history we cannot read must cost the archived rows, never the launch.
    logError('main:logHistory', { message: 'could not seed archived history', err })
  }
}

/** Note that the fold has moved on, so the next tick has something to write. */
export function markHistoryDirty(): void {
  dirty = true
}

/**
 * Write the live bucket now. Called after the replay, on the interval, and at the orderly exit.
 * `force` skips the dirty check — the post-replay and exit writes always mean it.
 */
export function persistLiveHistory(force = false): void {
  if (activeCharId === null) return
  if (!force && !dirty) return
  try {
    const lvl = levelingModule.liveSnap()
    setLiveBucket(activeCharId, {
      loot: lootModule.liveRows(),
      levels: lvl.levels,
      aaGains: lvl.aaGains,
      aaSpends: lvl.aaSpends,
      aaPotions: lvl.aaPotions,
      kills: killsModule.liveKills()
    })
    dirty = false
  } catch (err) {
    logError('main:logHistory', { message: 'could not write the live history bucket', err })
  }
}

/** Arm the interval. Unref'd: a pending write must never hold the process open. */
export function startHistoryWrites(): void {
  if (timer) return
  timer = setInterval(() => {
    persistLiveHistory()
  }, HISTORY_WRITE_INTERVAL_MS)
  timer.unref()
}

/** Stop the interval (session teardown). Does NOT write — the caller decides that. */
export function stopHistoryWrites(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

/**
 * Rotation archived `archiveFileName` for `charId`; promote that character's live bucket into it.
 *
 * CALLED AT STARTUP, BEFORE ANY FOLD, which is what makes it correct without reading the archive:
 * the file just renamed is precisely the file the PREVIOUS session folded into `live`, so the
 * answer is already in the store and the expensive thing never has to happen. `promoteLive` refuses
 * to overwrite an archive bucket that somehow already exists, which is the one shape that could
 * double-count.
 */
export function promoteRotatedLog(charId: string, archiveFileName: string): void {
  try {
    promoteLiveBucket(charId, archiveFileName)
  } catch (err) {
    logError('main:logHistory', { message: `could not promote ${archiveFileName}`, err })
  }
}
