// log/campPersist.ts — the one place camp pins meet the store.
//
// `modules/campPins.ts` is the fold and stays store-free (it has to be constructible under plain
// node — the bench and tests/foldDeterminism.test.mts both do it). This binds it: the seed on the
// way in, the write on the way out, and the watch list that is the module's second arming signal.
//
// PER CHARACTER, like `historyPersist.ts` beside it, and seeded from `resetWorldFor` for the same
// reason: it must be in place before the scan folds a single line, or a historical replay would
// re-ask questions the player answered weeks ago.
//
// WRITTEN ON ANSWER, NOT ON A TIMER — the opposite of logHistory's cadence, and deliberately. A
// history bucket is a CACHE of what the fold derived and can be rebuilt by re-reading the log; a
// camp pin is an INTERACTION, the player's answer to a question, and nothing can re-derive it
// because the log never states where a kill happened. So there is no interval here and no dirty
// flag: the module calls back the moment a `/loc` lands, and that write is the whole of it.

import { characterId } from './config'
import { campPinsModule } from '../pipeline'
import { getCampPins, setCampPins } from '../storeCampPins'
import { getRespawnPrefs } from '../storeRespawn'
import { logError } from '../errorLog'
import type { CampPins } from '../../shared/campPins'
import type { CharacterRef } from '../../shared/types'

/** The character whose camps the callback writes. Null before the first tail. */
let activeCharId: string | null = null

/**
 * Seed this character's camps and arm the module's second signal — called from `resetWorldFor`,
 * before the scan.
 *
 * THE WATCH LIST IS THE HALF THAT COVERS WHAT THE ROSTER MISSES, and namedDb.ts has the
 * measurement of how much that is. A mob the player explicitly asked for a respawn clock on is an
 * instruction; it outranks any published roster and never goes stale.
 */
export function seedCampPins(ref: CharacterRef): void {
  const charId = characterId(ref)
  activeCharId = charId
  try {
    campPinsModule.setPins(getCampPins(charId))
    campPinsModule.setWatched(watchedNames())
    campPinsModule.setPersist(persist)
  } catch (err) {
    // Camps we cannot read must cost the pins, never the launch.
    logError('main:campPins', { message: 'could not seed camp pins', err })
  }
}

/** Keep the arming list in step when the user edits their watch list while the app runs. */
export function refreshCampWatchList(): void {
  try {
    campPinsModule.setWatched(watchedNames())
  } catch (err) {
    logError('main:campPins', { message: 'could not refresh the camp watch list', err })
  }
}

/** The mobs the user has asked for a respawn clock on (JOS-194's opt-in list). */
function watchedNames(): string[] {
  // `key` is the canonicalized name a death line folds to, which is exactly what the module
  // compares against; `display` is for showing and would miss on case.
  return getRespawnPrefs().watches.map((w) => w.key)
}

/** Write the answered pins. Never throws: a failed write may not break a fold mid-session. */
function persist(pins: CampPins): void {
  if (activeCharId === null) return
  try {
    setCampPins(activeCharId, pins)
  } catch (err) {
    logError('main:campPins', { message: 'could not write camp pins', err })
  }
}
