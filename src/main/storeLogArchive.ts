// storeLogArchive.ts — the persisted half of "rotate the log before it gets huge".
//
// A SIXTH MODULE THROUGH THE `settingsStore` DOOR (uiScale.ts, storeRespawn.ts, storeSoundPacks.ts,
// storeOverlaySnap.ts, storeProcessPriority.ts): store.ts sits at the repo's 400-code-line
// factoring ceiling and the stated answer to that is a split rather than a widened threshold. It
// owes the same discipline every accessor in store.ts follows and pays it — read through
// `normalizeLogArchivePrefs`, write back through the SAME normalizer.
//
// NO SCHEMA BUMP, and that is the documented rule rather than an omission. storeProcessPriority.ts
// states the carve-out it did NOT qualify for: the additive-optional exemption is for keys whose
// absence already means today's behaviour. `processPriority` defaults ON, so its absence meant the
// opposite of the shipped feature and it earned a v12 step. This key defaults OFF — an absent
// `logArchive` means "this app does not touch your logs", which is precisely what every store
// written before this commit meant. There is nothing for a migration to state.
//
// WHAT the setting means, and what rotating actually does to the files, lives in
// shared/logArchive.ts and src/main/log/archive.ts. This file is storage and nothing else.

import { settingsStore } from './store'
import { normalizeLogArchivePrefs, type LogArchivePrefs } from '../shared/logArchive'

/** The stored blob, defaulted. Never throws, never returns a partial. */
export function getLogArchivePrefs(): LogArchivePrefs {
  return normalizeLogArchivePrefs(settingsStore.get('logArchive'))
}

/**
 * Merge-patch the blob; returns the stored (re-normalized) value, so no caller has to assume its
 * write landed on the value it sent. VALIDATED HERE because the renderer supplies it (the
 * `sounds:getData` rule) — a threshold typed into a settings field reaches disk through this.
 */
export function setLogArchivePrefs(patch: Partial<LogArchivePrefs>): LogArchivePrefs {
  const next = normalizeLogArchivePrefs({ ...getLogArchivePrefs(), ...patch })
  settingsStore.set('logArchive', next)
  return next
}
