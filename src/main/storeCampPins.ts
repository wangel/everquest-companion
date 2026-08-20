// storeCampPins.ts — the persisted half of "where you camp a named".
//
// AN EIGHTH MODULE THROUGH THE `settingsStore` DOOR (uiScale.ts, storeRespawn.ts,
// storeSoundPacks.ts, storeOverlaySnap.ts, storeProcessPriority.ts, storeLogArchive.ts,
// storeLogHistory.ts): store.ts sits at the repo's 400-code-line factoring ceiling and the stated
// answer to that is a split.
//
// PER CHARACTER, because a camp is a thing a PLAYER learned. Two characters in one guild camp the
// same room and both are entitled to their own answer — and a shared file would let one character's
// `/loc` move another's marker, which is the sort of quiet cross-talk that is impossible to debug
// from a screenshot.
//
// NO SCHEMA BUMP, by storeLogArchive.ts's documented carve-out: an absent `campPins` means "you
// have pinned nothing", which is what every store written before this commit meant and what a
// store on a machine that never answers a prompt keeps meaning.
//
// UNLIKE `logHistory`, THIS IS NOT A CACHE. A pin is something the user DID — they stood
// somewhere and typed `/loc` in answer to a question. Nothing can re-derive it, because the log
// never says where a kill happened; that is the whole reason the feature is a prompt. So it is
// written the instant it is answered rather than on a timer, and it is never discarded to be
// rebuilt (shared/campPins.ts carries the argument).

import { settingsStore } from './store'
import { emptyCampPins, normalizeCampPins, type CampPins } from '../shared/campPins'

/** Every character's camps, defaulted. Never throws, never returns a partial. */
function allCamps(): Record<string, CampPins> {
  const raw = settingsStore.get('campPins')
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, CampPins> = {}
  for (const [charId, value] of Object.entries(raw as Record<string, unknown>)) {
    out[charId] = normalizeCampPins(value)
  }
  return out
}

/** One character's camps. An unknown character has pinned nothing. */
export function getCampPins(charId: string): CampPins {
  return allCamps()[charId] ?? emptyCampPins()
}

/** Replace one character's camps, leaving every other character's alone. */
export function setCampPins(charId: string, pins: CampPins): void {
  settingsStore.set('campPins', { ...allCamps(), [charId]: pins })
}
