// LOG ROTATION — the pure decisions, and the three ordering rules that make it safe.
//
// Two layers, the discovery.ts split exactly:
//   1. the PURE half (shared/logArchive.ts) — normalizer, threshold, archive naming — testable to
//      the character with no disk at all;
//   2. the MECHANISM (src/main/log/archive.ts) against REAL files in a temp dir, because the whole
//      feature is a claim about what ends up on a filesystem and a mocked `rename` would prove
//      nothing about the property that matters (rule 3: what survives an interrupted run).
//
// The rules under test are stated in archive.ts's header. Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { gunzipSync } from 'zlib'
import {
  DEFAULT_LOG_ARCHIVE_PREFS,
  MAX_ARCHIVE_THRESHOLD_MB,
  MIN_ARCHIVE_THRESHOLD_MB,
  archiveBaseName,
  normalizeLogArchivePrefs,
  shouldArchive,
  type LogArchivePrefs
} from '../src/shared/logArchive'
import { ARCHIVE_DIR_NAME, rotate, type ArchiveDeps } from '../src/main/log/archive'

// --- the pure half ----------------------------------------------------------

test('normalizeLogArchivePrefs: OFF by default, and a malformed value never turns it on', () => {
  // THE LOAD-BEARING DEFAULT. This feature moves a file inside the user's game install, so every
  // path that cannot produce an explicit `true` must produce `false`.
  assert.deepEqual(normalizeLogArchivePrefs(undefined), DEFAULT_LOG_ARCHIVE_PREFS)
  assert.deepEqual(normalizeLogArchivePrefs(null), DEFAULT_LOG_ARCHIVE_PREFS)
  assert.deepEqual(normalizeLogArchivePrefs('yes'), DEFAULT_LOG_ARCHIVE_PREFS)
  assert.deepEqual(normalizeLogArchivePrefs([]), DEFAULT_LOG_ARCHIVE_PREFS)
  assert.deepEqual(normalizeLogArchivePrefs({ enabled: 'true' }), DEFAULT_LOG_ARCHIVE_PREFS)
  assert.equal(normalizeLogArchivePrefs({ enabled: false }).enabled, false)
  assert.equal(normalizeLogArchivePrefs({ enabled: true }).enabled, true)
})

test('normalizeLogArchivePrefs: the threshold is clamped to its band and rounded', () => {
  const mb = (v: unknown): number => normalizeLogArchivePrefs({ thresholdMb: v }).thresholdMb
  assert.equal(mb(200), 200)
  // A slider can produce a fraction; that is rounded, not refused.
  assert.equal(mb(49.999), 50)
  // Out of band in both directions clamps rather than falling back, so an over-eager number still
  // expresses the direction the user meant.
  assert.equal(mb(1), MIN_ARCHIVE_THRESHOLD_MB)
  assert.equal(mb(0), MIN_ARCHIVE_THRESHOLD_MB)
  assert.equal(mb(-5), MIN_ARCHIVE_THRESHOLD_MB)
  assert.equal(mb(99_999), MAX_ARCHIVE_THRESHOLD_MB)
  // Not a number at all falls back to the documented default.
  assert.equal(mb('50'), DEFAULT_LOG_ARCHIVE_PREFS.thresholdMb)
  assert.equal(mb(Number.NaN), DEFAULT_LOG_ARCHIVE_PREFS.thresholdMb)
  assert.equal(mb(Number.POSITIVE_INFINITY), DEFAULT_LOG_ARCHIVE_PREFS.thresholdMb)
})

test('shouldArchive: a disabled preference is never big enough, whatever the size', () => {
  const on: LogArchivePrefs = { enabled: true, thresholdMb: 50 }
  const off: LogArchivePrefs = { enabled: false, thresholdMb: 50 }
  const mb = (n: number): number => n * 1024 * 1024
  assert.equal(shouldArchive(mb(50), on), true, 'the threshold is inclusive')
  assert.equal(shouldArchive(mb(50) - 1, on), false)
  assert.equal(shouldArchive(mb(228), on), true)
  // The switch dominates the size — no size can act while the feature is off.
  assert.equal(shouldArchive(mb(10_000), off), false)
})

test('archiveBaseName: local time, sortable to the second, extension dropped', () => {
  const at = new Date(2026, 7, 17, 14, 5, 3) // local, August is month 7
  assert.equal(
    archiveBaseName('eqlog_Taelenya_rivervale.txt', at),
    'eqlog_Taelenya_rivervale-20260817-140503'
  )
  // Lexical sort == chronological sort, which is the property that makes the listing useful.
  const later = archiveBaseName('eqlog_A_b.txt', new Date(2026, 7, 17, 14, 5, 4))
  assert.ok(archiveBaseName('eqlog_A_b.txt', at) < later)
  // A name that is not `.txt` keeps whatever it has rather than being mangled.
  assert.equal(archiveBaseName('eqlog_A_b', at), 'eqlog_A_b-20260817-140503')
})

// --- the mechanism, against real files --------------------------------------

/** A temp Logs dir plus the deps that point at it. `sizes` is per-file bytes of filler. */
function harness(
  sizes: Record<string, number>,
  over: Partial<ArchiveDeps> = {}
): { dir: string; deps: ArchiveDeps; errors: string[]; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'eqc-archive-'))
  for (const [name, bytes] of Object.entries(sizes)) {
    // Repetitive text, like a real log — so the gzip assertions below are about a realistic ratio.
    writeFileSync(join(dir, name), '[Mon Aug 17 00:00:00 2026] You have entered Freeport.\n'.repeat(Math.ceil(bytes / 52)))
  }
  const errors: string[] = []
  const deps: ArchiveDeps = {
    logsDir: dir,
    prefs: { enabled: true, thresholdMb: MIN_ARCHIVE_THRESHOLD_MB },
    eqRunning: () => false,
    now: () => new Date(2026, 7, 17, 14, 5, 3),
    onError: (m, e) => errors.push(`${m}: ${String(e)}`),
    ...over
  }
  return { dir, deps, errors, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const SIX_MB = 6 * 1024 * 1024

test('rotate: RULE 1 — the game holding the log defers the whole pass, untouched', async () => {
  // The silent-corruption case. A Windows handle follows the file OBJECT, so renaming a log out
  // from under a running client leaves the client appending into the archive. Nothing may move.
  const h = harness({ 'eqlog_Taelenya_rivervale.txt': SIX_MB }, { eqRunning: () => true })
  try {
    const res = await rotate(h.deps)
    assert.equal(res.skipped, 'eq-running')
    assert.deepEqual(res.rotated, [])
    assert.ok(existsSync(join(h.dir, 'eqlog_Taelenya_rivervale.txt')), 'the log is exactly where it was')
    assert.ok(!existsSync(join(h.dir, ARCHIVE_DIR_NAME)), 'no archive directory is even created')
    assert.deepEqual(h.errors, [])
  } finally {
    h.cleanup()
  }
})

test('rotate: a disabled preference does nothing at all, and says so', async () => {
  const h = harness(
    { 'eqlog_Taelenya_rivervale.txt': SIX_MB },
    { prefs: { enabled: false, thresholdMb: MIN_ARCHIVE_THRESHOLD_MB } }
  )
  try {
    const res = await rotate(h.deps)
    assert.equal(res.skipped, 'disabled')
    assert.ok(existsSync(join(h.dir, 'eqlog_Taelenya_rivervale.txt')))
    assert.ok(!existsSync(join(h.dir, ARCHIVE_DIR_NAME)))
  } finally {
    h.cleanup()
  }
})

test('rotate: a log under the threshold is left alone', async () => {
  const h = harness({ 'eqlog_Small_server.txt': 1024 })
  try {
    const res = await rotate(h.deps)
    assert.equal(res.skipped, 'nothing-big-enough')
    assert.ok(existsSync(join(h.dir, 'eqlog_Small_server.txt')))
  } finally {
    h.cleanup()
  }
})

test('rotate: the whole round trip — archived, gzipped, byte-identical, fresh log in its place', async () => {
  const h = harness({ 'eqlog_Taelenya_rivervale.txt': SIX_MB, 'eqlog_Small_server.txt': 1024 })
  try {
    const original = readFileSync(join(h.dir, 'eqlog_Taelenya_rivervale.txt'))
    const smallBefore = readFileSync(join(h.dir, 'eqlog_Small_server.txt'))
    const res = await rotate(h.deps)

    // RULE 2: the renames are done when `rotate` resolves; compression is still in flight.
    assert.equal(res.rotated.length, 1, 'only the oversized log rotated')
    assert.equal(res.rotated[0].logFile, 'eqlog_Taelenya_rivervale.txt')
    assert.equal(res.skipped, null)

    // The fresh empty log is already in place, so the character never leaves the switcher.
    const live = join(h.dir, 'eqlog_Taelenya_rivervale.txt')
    assert.ok(existsSync(live), 'a replacement log exists immediately')
    assert.equal(readFileSync(live).length, 0, 'and it is empty')
    // The under-threshold log was never touched - byte for byte, not merely still present.
    assert.deepEqual(readFileSync(join(h.dir, 'eqlog_Small_server.txt')), smallBefore)

    await res.compressed

    const archiveDir = join(h.dir, ARCHIVE_DIR_NAME)
    const listing = readdirSync(archiveDir)
    assert.deepEqual(listing, ['eqlog_Taelenya_rivervale-20260817-140503.txt.gz'])
    // RULE 3: the plain text is gone only because a complete .gz replaced it — and NOT ONE BYTE
    // of the log changed on the way. This is the assertion the whole feature has to earn.
    assert.deepEqual(gunzipSync(readFileSync(join(archiveDir, listing[0]))), original)
    // No `.part` survives a clean run.
    assert.equal(listing.filter((n) => n.endsWith('.part')).length, 0)
    assert.deepEqual(h.errors, [])
  } finally {
    h.cleanup()
  }
})

test('rotate: every oversized character log goes, and nothing else in the directory does', async () => {
  const h = harness({
    'eqlog_Taelenya_rivervale.txt': SIX_MB,
    'eqlog_Vaeloria_rivervale.txt': SIX_MB,
    // The real Logs dir is full of these. None of them is a character log and none may move.
    'dbg.txt': SIX_MB,
    'Sky.txt': SIX_MB,
    'MemoryStrategy.txt': 0
  })
  try {
    const res = await rotate(h.deps)
    await res.compressed
    assert.deepEqual(
      res.rotated.map((r) => r.logFile).sort(),
      ['eqlog_Taelenya_rivervale.txt', 'eqlog_Vaeloria_rivervale.txt']
    )
    for (const bystander of ['dbg.txt', 'Sky.txt', 'MemoryStrategy.txt']) {
      assert.ok(existsSync(join(h.dir, bystander)), `${bystander} is not a character log`)
    }
    assert.equal(readdirSync(join(h.dir, ARCHIVE_DIR_NAME)).length, 2)
  } finally {
    h.cleanup()
  }
})

test('rotate: a missing logs directory is reported, never thrown', async () => {
  // Startup calls this before the tail attaches; a throw here would be a launch failure over a
  // directory the user may simply not have yet.
  const h = harness({})
  h.cleanup() // the directory is gone before the call
  const errors: string[] = []
  const res = await rotate({ ...h.deps, onError: (m, e) => errors.push(`${m}: ${String(e)}`) })
  assert.deepEqual(res.rotated, [])
  assert.equal(res.skipped, 'nothing-big-enough')
  assert.equal(errors.length, 1)
  assert.match(errors[0], /could not read the logs directory/)
})
