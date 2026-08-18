// log/archive.ts — ROTATE A CHARACTER LOG, THEN COMPRESS IT OFF THE CRITICAL PATH.
//
// The mechanism behind shared/logArchive.ts (read that header first: why the feature exists, why
// it is opt-in, what the threshold means). This file is Electron-free and takes every environmental
// answer as an injected probe, so the ordering rules below are unit-testable without a game, a
// registry or a 240 MB file.
//
// ============================================================================================
// THE ORDER OF OPERATIONS IS THE WHOLE DESIGN. Three rules, each paid for.
// ============================================================================================
//
// 1. NEVER ROTATE WHILE THE GAME HOLDS THE HANDLE.
//    EverQuest opens the log when you type `/log on` and keeps that handle for the session. A
//    Windows handle follows the FILE OBJECT, not the path — so renaming the log out from under a
//    running client does not make the client start a new file, it makes the client keep appending
//    into the archive we just moved aside, while the app tails a path that never grows again. That
//    failure is silent and would look exactly like "the app stopped seeing my log". The gate is
//    `eqRunning` (src/main/presenceNative.ts already enumerates `eqgame.exe` for the overlays), and
//    when the game is up we simply DEFER — the next launch is the next chance, and there is always
//    a next launch.
//
// 2. RENAME FIRST, COMPRESS SECOND, AND NEVER THE OTHER WAY ROUND.
//    Compressing before the rename would put the whole cost on the launch path, in front of the
//    fold, to save a startup this feature exists to make fast. MEASURED, that cost is smaller than
//    it looks (about two seconds for a 240 MB log — see the level note below), so this ordering is
//    worth less than it first appears; it is still the right way round, because the saving scales
//    with a log this app does not control and a disk it knows nothing about, and because a tail
//    must never attach to a file that is about to be renamed. Do not read rule 2 as "compression
//    is slow" - read it as "the launch path owes the fold everything it has".
//    A rename inside one directory is a metadata write: it is effectively instant, it is
//    atomic, and after it the app can attach its tail and get on with life. The compression then
//    runs on the libuv threadpool (`createGzip` deflates off the main thread) against a file
//    nothing is reading any more. `rotate()` returns as soon as the renames are done and hands
//    back the compression promise separately, so a caller decides whether to wait — startup does
//    not.
//
// 3. THE SOURCE IS DELETED LAST, AND ONLY AFTER A VERIFIED `.gz` EXISTS.
//    Compression writes to `<name>.gz.part` and renames it to `<name>.gz` only on a clean finish;
//    the plain `.txt` is unlinked only after THAT rename returns. Kill the process at any point
//    and what survives is either the original text in `Archive/` or a complete `.gz` — never a
//    truncated archive standing in for a log. A `.part` left behind is inert (it is not a `.gz`
//    and nothing reads it) and is overwritten by the next attempt.
//
// COMPRESSION LEVEL 6, NOT 9 — a deliberate departure from feedback/slice.ts, which uses 9. That
// path gzips a few thousand lines where every byte crosses a network, so it buys ratio at any
// price. Here the file is written to the user's own disk and never uploaded, and an EQ log is
// about as compressible as text gets. MEASURED on a real 240 MB character log (level 6, 64 MB
// sample, 2026-08-17): 11.6x, at 132 MB/s — the whole log compresses in roughly two seconds. Level
// 9 would spend several times that CPU chasing a few percent of a ratio that is already an order
// of magnitude, on a core the game may want back. If that trade is ever revisited, re-measure it:
// these numbers are one machine's, and the ratio in particular is a property of EQ's log format.
//
// A FRESH EMPTY LOG IS RECREATED, on purpose. `listCharacters()` reads the Logs directory, so a
// rotated-away log means a character that vanishes out of the app's own switcher until the player
// launches the game again. EverQuest opens its log for append and is perfectly happy to find an
// empty file waiting, which is the same state it would have created for itself.

import { createReadStream, createWriteStream } from 'fs'
import { rename, stat, unlink, mkdir, writeFile, readdir } from 'fs/promises'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { createGzip } from 'zlib'
import { archiveBaseName, shouldArchive, type LogArchivePrefs } from '../../shared/logArchive'

/** The directory rotated logs land in, beside the logs themselves. */
export const ARCHIVE_DIR_NAME = 'Archive'

/** The character-log filename the game writes. Same shape discovery.ts matches, deliberately. */
const EQLOG_RE = /^eqlog_.+\.txt$/i

/** What `rotate` needs from the world. Injected so every rule above is testable without a disk. */
export interface ArchiveDeps {
  /** The `Logs` directory holding the character logs. */
  logsDir: string
  /** The user's stored preferences. */
  prefs: LogArchivePrefs
  /** Is EverQuest running right now? Rule 1 — a `true` defers the whole pass. */
  eqRunning: () => boolean
  /** Clock, so the archive stamp is deterministic under test. */
  now: () => Date
  /** Report a non-fatal problem. Rotation never throws at its caller; a failure is a log line. */
  onError: (message: string, err: unknown) => void
}

/** One log's outcome, so the caller can say what happened without re-reading the directory. */
export interface RotatedLog {
  /** The character log's filename, e.g. `eqlog_Taelenya_rivervale.txt`. */
  logFile: string
  /** Bytes the log held when it was rotated. */
  bytes: number
  /** Absolute path of the archived text, before compression renames it to `.gz`. */
  archivedPath: string
}

/** Why a pass did nothing. A caller's log line needs the reason, not just the absence. */
export type RotateSkip = 'disabled' | 'eq-running' | 'nothing-big-enough' | null

/** What a whole pass did. */
export interface RotateResult {
  rotated: RotatedLog[]
  skipped: RotateSkip
  /**
   * Resolves when every rotated log has been compressed and its plain text removed. SEPARATE from
   * the call itself (rule 2): startup does not await this, tests do.
   */
  compressed: Promise<void>
}

/**
 * Rotate every character log over the threshold. Resolves once the RENAMES are done — see rule 2;
 * the compression is carried on `result.compressed`.
 *
 * Never throws: a rotation that fails for one log reports through `onError` and leaves that log
 * exactly where it was. There is no partial state to clean up because the rename either happened
 * or it did not.
 */
export async function rotate(deps: ArchiveDeps): Promise<RotateResult> {
  const idle = (skipped: RotateSkip): RotateResult => ({
    rotated: [],
    skipped,
    compressed: Promise.resolve()
  })
  if (!deps.prefs.enabled) return idle('disabled')
  // Rule 1. Asked BEFORE the directory is read: if the game is up, nothing here is safe and the
  // cheapest correct thing is to do nothing at all.
  if (deps.eqRunning()) return idle('eq-running')

  const candidates = await oversizedLogs(deps)
  if (candidates.length === 0) return idle('nothing-big-enough')

  const archiveDir = join(deps.logsDir, ARCHIVE_DIR_NAME)
  try {
    await mkdir(archiveDir, { recursive: true })
  } catch (err) {
    deps.onError('could not create the archive directory', err)
    return idle(null)
  }

  const rotated: RotatedLog[] = []
  for (const c of candidates) {
    const done = await rotateOne(c, archiveDir, deps)
    if (done) rotated.push(done)
  }
  if (rotated.length === 0) return idle(null)
  return { rotated, skipped: null, compressed: compressAll(rotated, deps) }
}

/** The logs big enough to rotate, with the size that made them candidates. */
async function oversizedLogs(deps: ArchiveDeps): Promise<RotatedLog[]> {
  let names: string[]
  try {
    names = (await readdir(deps.logsDir)).filter((n) => EQLOG_RE.test(n))
  } catch (err) {
    deps.onError('could not read the logs directory', err)
    return []
  }
  const out: RotatedLog[] = []
  for (const logFile of names.sort()) {
    try {
      const { size } = await stat(join(deps.logsDir, logFile))
      if (shouldArchive(size, deps.prefs)) out.push({ logFile, bytes: size, archivedPath: '' })
    } catch (err) {
      deps.onError(`could not stat ${logFile}`, err)
    }
  }
  return out
}

/**
 * Move ONE log aside and leave a fresh empty one in its place. Returns null (having reported) if
 * the move failed — most plausibly because something still holds the handle, which is exactly the
 * case rule 1 is trying to avoid and which must never be forced.
 */
async function rotateOne(
  candidate: RotatedLog,
  archiveDir: string,
  deps: ArchiveDeps
): Promise<RotatedLog | null> {
  const src = join(deps.logsDir, candidate.logFile)
  const archivedPath = join(archiveDir, `${archiveBaseName(candidate.logFile, deps.now())}.txt`)
  try {
    await rename(src, archivedPath)
  } catch (err) {
    deps.onError(`could not archive ${candidate.logFile}`, err)
    return null
  }
  try {
    // The replacement. A failure here is cosmetic — the game recreates the file the moment it
    // next writes a line — so it is reported and the rotation still counts as done.
    await writeFile(src, '')
  } catch (err) {
    deps.onError(`archived ${candidate.logFile} but could not recreate it`, err)
  }
  return { ...candidate, archivedPath }
}

/** Compress each archived text in turn, one at a time so a pass never holds two cores. */
async function compressAll(rotated: readonly RotatedLog[], deps: ArchiveDeps): Promise<void> {
  for (const r of rotated) {
    try {
      await compressOne(r.archivedPath)
    } catch (err) {
      // Rule 3's payoff: the plain text is still sitting in Archive/, so nothing was lost.
      deps.onError(`archived ${r.logFile} but could not compress it`, err)
    }
  }
}

/** `<path>` → `<path>.gz`, through a `.part` file, deleting the source only on success (rule 3). */
async function compressOne(archivedPath: string): Promise<void> {
  const finalPath = `${archivedPath}.gz`
  const partPath = `${finalPath}.part`
  await pipeline(
    createReadStream(archivedPath),
    createGzip({ level: 6 }),
    createWriteStream(partPath)
  )
  await rename(partPath, finalPath)
  await unlink(archivedPath)
}
