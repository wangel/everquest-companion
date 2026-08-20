// log/archiveStartup.ts — the composition root's one call into log rotation.
//
// `archive.ts` is Electron-free and takes every environmental answer as a probe; this file is the
// only place those probes are bound to the real store, the real config and the real process list.
// Same split as discovery.ts's pure core vs its `realOverrideProbes`.
//
// ============================================================================================
// "IS EVERQUEST RUNNING" IS ASKED DIRECTLY HERE, AND NOT OFF `presenceSnapshot()`. This is the
// subtle part and getting it wrong would silently disarm archive.ts's rule 1.
// ============================================================================================
//
// The presence watcher is a worker thread that starts alongside the app and reports on a poll.
// Before its first tick lands, `PresenceState.eqRunning` is `false` — and presenceProtocol.ts says
// exactly what that `false` means in its own header: *"Before the watcher's first line
// `eqRunning:false` means 'we have not looked yet'"*. Rotation happens in the first moments of
// startup, which is precisely the window in which that value is a placeholder rather than an
// observation. Reading the snapshot here would therefore report "the game is closed" on every
// single launch, including the ones where it is wide open — the exact silent-corruption case rule 1
// exists to prevent. So this asks the kernel itself, once, synchronously.
//
// AND IT DEGRADES CLOSED. `eqRunning()` answers 1 (running), 0 (not running) and **-1 (the
// enumeration itself failed)**. Only a hard 0 is permission to touch the files; -1, a native
// binding that would not load, and any throw all resolve to "assume it is running" and defer to
// the next launch. That is the opposite of how the overlay auto-hide treats the same probe, and
// deliberately so: hiding an overlay on a bad guess costs a glance, moving a 228 MB log on a bad
// guess costs the file. Nothing here is time-critical - there is always a next launch.

import { basename } from 'path'
import { characterId, effectiveEqRoot, eqLogsDir, parseLogName } from './config'
import { rotate, type RotatedLog, type RotateResult } from './archive'
import { promoteRotatedLog } from './historyPersist'
import { getLogArchivePrefs } from '../storeLogArchive'
import { eqRootPrefix } from '../presenceProtocol'
import { loadPresenceNative } from '../presenceNative'
import { logError, logInfo } from '../errorLog'

/**
 * Ask the OS whether an EverQuest client is alive right now. TRUE unless we positively established
 * that none is — see the header. Never throws.
 */
function eqRunningNow(): boolean {
  try {
    const native = loadPresenceNative()
    return native.eqRunning(eqRootPrefix(effectiveEqRoot())) !== 0
  } catch (err) {
    logError('main:logArchive', { message: 'could not ask whether EverQuest is running', err })
    return true
  }
}

/**
 * Rotate oversized character logs, if the user has asked for that and the game is closed.
 *
 * Resolves when the RENAMES are done, which is what startup has to wait for — the log the tail is
 * about to attach to must not move under it afterwards. The COMPRESSION is deliberately not
 * awaited (archive.ts rule 2): it runs on the libuv threadpool against files nothing reads, and a
 * launch must not spend tens of seconds on it. A failure anywhere is logged and swallowed; this
 * function never rejects, because a preference about tidying files may not prevent an app start.
 */
export async function rotateLogsBeforeTail(): Promise<RotateResult | null> {
  const prefs = getLogArchivePrefs()
  if (!prefs.enabled) return null
  try {
    const result = await rotate({
      logsDir: eqLogsDir(),
      prefs,
      eqRunning: eqRunningNow,
      now: () => new Date(),
      onError: (message, err) => logError('main:logArchive', { message, err })
    })
    // PROMOTE BEFORE ANYTHING ELSE LOOKS AT THE STORE. The file just renamed is precisely the file
    // the PREVIOUS session folded into its `live` bucket, so that bucket IS this archive's history
    // and no byte has to be re-read to know it (log/historyPersist.ts). Done here, at startup and
    // before the fold, because `seedArchivedHistory` runs moments later and must already see it.
    for (const r of result.rotated) promoteRotated(r)
    if (result.rotated.length > 0) {
      const names = result.rotated.map((r) => `${r.logFile} (${mb(r.bytes)} MB)`).join(', ')
      logInfo(`[everquest-companion] archived ${String(result.rotated.length)} log(s): ${names}`)
      // Report the compression's outcome when it lands, so a user reading errors.log can tell a
      // finished rotation from one whose plain text is still sitting in Archive/.
      void result.compressed.then(() => {
        logInfo('[everquest-companion] log archive compression finished')
      })
    } else if (result.skipped === 'eq-running') {
      logInfo('[everquest-companion] log archiving deferred: EverQuest is running')
    }
    return result
  } catch (err) {
    logError('main:logArchive', err)
    return null
  }
}

/**
 * Move one rotated log's history from `live` into its own archive bucket.
 *
 * The bucket key is the ARCHIVE's filename (`…-20260818-214124.txt.gz`), not the character log's:
 * it is unique per rotation, which is what makes re-promotion detectable, and it names a file that
 * still exists on disk for anyone reconciling the two by hand.
 *
 * A log whose name does not parse into a character is skipped rather than guessed at — `rotate()`
 * only ever matches `eqlog_*.txt`, so this is a belt-and-braces refusal, not a path.
 */
function promoteRotated(rotated: RotatedLog): void {
  const ref = parseLogName(rotated.logFile)
  if (!ref) return
  promoteRotatedLog(characterId(ref), `${basename(rotated.archivedPath)}.gz`)
}

/** Bytes as whole megabytes, for a log line. */
function mb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024))
}
