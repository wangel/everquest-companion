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
import { campPinsModule, registry, respawnModule } from '../pipeline'
import { getCampPins, setCampPins } from '../storeCampPins'
import { getRespawnPrefs, setRespawnPrefs } from '../storeRespawn'
import { logError } from '../errorLog'
import { idKey } from './parser'
import { respawnWithWatch } from '../../shared/respawn'
import type { CampPin, CampPins } from '../../shared/campPins'
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

/**
 * An answered prompt: write the pin, and START THE CLOCK.
 *
 * ANSWERING IS AN OPT-IN, and this is the line that makes the feature worth having. JOS-194 made
 * respawn tracking opt-in per mob because "a clock nobody asked for is a clock about a mob the app
 * cannot identify" - and typing `/loc` in answer to "this named just died" is about as explicit as
 * asking gets. So the mob joins the watch list, which is what turns a dot on a map into a
 * countdown, and what makes the list fill itself in for every mob the wiki roster misses.
 *
 * THE THREE DUTIES OF A WATCH WRITE, the same ones ipc/respawn.ts performs: persist it, apply it
 * to the RUNNING module, and push now. Skipping the second would leave this session's clocks
 * ignorant of a watch the file already has, which is the shape of bug that only shows up after a
 * restart "fixes" it.
 *
 * ALREADY WATCHED IS LEFT ALONE - `respawnWithWatch` replaces an entry, and replacing one would
 * discard a `customSec` the player typed. A camp answer says "I care about this mob", never "and
 * forget the respawn time I told you".
 */
function persist(pins: CampPins, answered: CampPin): void {
  if (activeCharId === null) return
  try {
    setCampPins(activeCharId, pins)
  } catch (err) {
    logError('main:campPins', { message: 'could not write camp pins', err })
  }
  try {
    startWatching(answered.mob)
  } catch (err) {
    logError('main:campPins', { message: 'could not start the clock for an answered camp', err })
  }
}

/**
 * PUT ONE MOB ON THE WATCH LIST — the whole write, in one place, for both callers.
 *
 * It was inline in `persist` until the celebration overlay grew an answer button (`respawn:watch`),
 * and two callers of a four-step write is exactly how a step goes missing in one of them. The four:
 *
 *   1. PERSIST through `setRespawnPrefs`, the same normalizer the store reader uses.
 *   2. APPLY LIVE to the running respawn module — skipping this leaves the session's clocks
 *      ignorant of a watch the FILE already has, the shape of bug a restart "fixes".
 *   3. TELL THE CAMP MODULE, so the prompt stops offering to watch a mob that now IS watched.
 *   4. PUSH NOW (`registry.flushNow`) — a watch edit advances no log seq (JOS-87), so on an idle
 *      log nothing else would ever carry it to the surfaces.
 *
 * ALREADY WATCHED IS LEFT ALONE and reported `false`. `respawnWithWatch` REPLACES an entry, and
 * replacing this one would discard a `customSec` the player typed: "I care about this mob" never
 * means "and forget the respawn time I told you".
 */
export function startWatching(mob: string): boolean {
  const key = idKey(mob)
  if (key === '') return false
  const prefs = getRespawnPrefs()
  if (prefs.watches.some((w) => w.key === key)) return false
  const next = setRespawnPrefs(respawnWithWatch(prefs, key, mob))
  respawnModule.setPrefs(next)
  campPinsModule.setWatched(next.watches.map((w) => w.key))
  registry.flushNow()
  return true
}
