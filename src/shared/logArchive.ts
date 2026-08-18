// shared/logArchive.ts — THE PURE HALF of "the log gets rotated before it gets huge".
//
// WHY THIS EXISTS. EverQuest appends to one `eqlog_<Char>_<server>.txt` forever; nothing in the
// game ever rolls it. On the machine this was built against that file had reached 228 MB and
// 2,890,641 lines, and the companion re-folds the WHOLE thing on every launch — 31.3 s of replay
// for 2,901,826 events, MEASURED (perf-startup.json, v1.4.0). The fold is not the problem: at
// ~158k events/sec it is within 8% of the engine's benchmarked rate. The INPUT is the problem.
// Rotating the log is the only lever that reduces the event count itself, and it is the same
// thing every other EQ log tool does (a `LogArchive.zip` sits in that machine's retail EQ folder,
// written by one of them).
//
// OPT-IN, AND THAT IS NOT TIMIDITY. This feature MOVES A FILE THE GAME OWNS, inside the user's
// game install. Every other preference in this app changes what the app does to itself; this one
// changes what is on someone else's disk, and a player who has never heard of it must never
// discover it by finding their log gone. So `enabled` defaults FALSE and the absence of the key
// means exactly what the app does today. That is also what keeps this key inside
// storeProcessPriority.ts's additive-optional carve-out and out of the migration chain: a key
// whose absence already means today's behaviour states nothing a v-bump would need to write.
//
// THE THRESHOLD IS A SIZE, NOT AN AGE. "Older than N days" cannot be answered without reading the
// file, which is the cost being avoided; `stat().size` is one syscall and is the quantity that
// actually predicts the replay. 50 MB is the default because it is roughly a quarter of the
// measured log and folds in single-digit seconds, and because it is the number the owner of that
// machine picked when describing the feature.
//
// A ZERO-IMPORT module, for the same reason `shared/processPriority.ts` and `shared/perf.ts` are.
// The MECHANISM — which files, renamed when, compressed how, and what happens when the game holds
// the handle — lives in `src/main/log/archive.ts`.

/** The persisted blob. A blob rather than two bare keys, the `perfHud`/`processPriority` shape. */
export interface LogArchivePrefs {
  /** Rotate character logs that exceed the threshold at startup. OFF until a user says otherwise. */
  enabled: boolean
  /** Rotate a log once it is at least this many megabytes. */
  thresholdMb: number
}

/** OFF, at 50 MB. See the header: this moves a file inside the user's game install. */
export const DEFAULT_LOG_ARCHIVE_PREFS: LogArchivePrefs = { enabled: false, thresholdMb: 50 }

/**
 * The band the threshold may sit in.
 *
 * The FLOOR is not taste. A rotation costs a fresh replay of everything the app knows from the
 * log, so a threshold small enough to fire most launches would trade a slow startup for a
 * permanently amnesiac one. 5 MB is well under any real session's output and still far above the
 * point where rotating is pointless. The CEILING is only there so a typo cannot store a number
 * that disables the feature while the switch reads "on".
 */
export const MIN_ARCHIVE_THRESHOLD_MB = 5
export const MAX_ARCHIVE_THRESHOLD_MB = 4096

/** Megabytes as this feature counts them: binary, matching what Explorer shows for a big file. */
export const BYTES_PER_MB = 1024 * 1024

/**
 * Defaulted field by field from `unknown` — the same value arrives from the store file and from a
 * renderer toggle. A malformed or out-of-band number is replaced by the documented default rather
 * than coerced, and a non-integer is rounded rather than refused (a slider can produce 49.999).
 */
export function normalizeLogArchivePrefs(value: unknown): LogArchivePrefs {
  const v: Record<string, unknown> =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : DEFAULT_LOG_ARCHIVE_PREFS.enabled,
    thresholdMb: normalizeThresholdMb(v.thresholdMb)
  }
}

/** Clamp to the band, round to a whole megabyte, and fall back on anything that is not a number. */
function normalizeThresholdMb(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_LOG_ARCHIVE_PREFS.thresholdMb
  }
  const whole = Math.round(value)
  if (whole < MIN_ARCHIVE_THRESHOLD_MB) return MIN_ARCHIVE_THRESHOLD_MB
  if (whole > MAX_ARCHIVE_THRESHOLD_MB) return MAX_ARCHIVE_THRESHOLD_MB
  return whole
}

/** Is this file big enough to rotate? The one size comparison, so no caller re-derives the unit. */
export function shouldArchive(sizeBytes: number, prefs: LogArchivePrefs): boolean {
  return prefs.enabled && sizeBytes >= prefs.thresholdMb * BYTES_PER_MB
}

/**
 * The archive's basename for a log rotated at `at`: `eqlog_Taelenya_rivervale-20260817-140530`.
 *
 * LOCAL TIME, and stamped to the SECOND. Local because every other date this app shows a user is
 * local (`lib/formatDate`, repo law) and an archive filename is read by a human standing in
 * Explorer, not joined against anything. To the second because two rotations of one log inside a
 * minute is not a shape worth a collision, and because the format sorts lexically, which is the
 * property that makes a directory listing useful.
 *
 * The extension is dropped and re-added by the caller: this function names the archive, it does
 * not decide it is a `.txt` on the way to a `.gz`.
 */
export function archiveBaseName(logFileName: string, at: Date): string {
  const stem = logFileName.replace(/\.txt$/i, '')
  const p = (n: number, width = 2): string => String(n).padStart(width, '0')
  const stamp =
    `${p(at.getFullYear(), 4)}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
  return `${stem}-${stamp}`
}
