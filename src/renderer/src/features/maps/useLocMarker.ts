// THE REACT HALF of the typed-/loc marker (JOS-98) — the state, the persistence effect, and the
// two gestures. Every RULE it applies lives in `locMarker.ts`, which is pure and node-tested; this
// file is the wiring, and it is deliberately the only part of the feature that cannot be driven by
// `node --test`.
//
// PERSISTED BY ONE EFFECT, not by each transition — the same shape `useZoneSelection` uses for the
// pinned zone, and for the same reason: there is exactly one place that can forget to write, and
// none of the reducers has to be impure to be correct.
//
// KEYED BY ZONE, READ BY ZONE. The whole map of markers is held in state and the CURRENT zone's is
// derived, rather than loading one zone's marker on every zone change. That is what makes walking
// out of a zone and back — or pinning another map and returning — free of a reload, and it is why
// clearing one zone's marker provably cannot touch another's (`clearLocMarker`).
//
// PLACING JUMPS, RESTORING DOES NOT. Typing a loc into the APP is a question ("where is that?")
// and the answer is useless off screen, so a placement centres the view on it at the search's own
// zoom. A marker restored from a previous session is NOT a question anyone just asked — snapping
// the viewport on mount would fight the zone's own fit and move a map the user never touched.
//
// …AND A `/loc` FROM THE LOG DOES NOT JUMP EITHER, which is the same rule read carefully rather
// than a new one. That `/loc` was typed in the GAME, by somebody who may not be looking at this
// window at all — and with an in-game social firing it every few seconds (EQBuddy documents one),
// jumping would yank a map out from under whoever IS reading it. The marker moves; the viewport
// is the user's. The chip is one click away when they want to go there.
//
// THE READING IS FILED UNDER ITS OWN ZONE, not under whatever map is open. A pinned map must not
// swallow a marker belonging to the zone the character actually stands in (`zoneFollow.ts` exists
// because the viewer used to overwrite the user's pick); filing by the reading's zone means the
// marker is simply there when you look at that map.
//
// LAST STATEMENT WINS, and no precedence table. A `/loc` from the log overwrites a pasted marker,
// a paste overwrites a logged one, `clear` forgets whichever is there, and the next `/loc` places
// it again. Both are the user saying where they are; the newer sentence is the better answer, and
// a rule richer than that would need a reason nobody has yet.

import { useCallback, useEffect, useState } from 'react'
import type { LocReading, ZoneShort } from '@shared/maps'
import { JUMP_ZOOM } from './MapBody'
import { mapFromLoc, type EqLoc } from './mapGeometry'
import { zoneShortName } from '@shared/zones'
import {
  clearLocMarker,
  loadLocMarkers,
  locFromReading,
  locMarkerFor,
  sameLoc,
  saveLocMarkers,
  setLocMarker,
  type LocMarkers
} from './locMarker'
import type { MapViewport } from './useMapViewport'

/** What the toolbar needs to state the marker, and what the surface needs to draw it. */
export interface LocMarkerState {
  /** This zone's marker in the game's own axes, or null. */
  marker: EqLoc | null
  /**
   * When the game PRINTED the reading this marker came from, or null for a pasted one.
   *
   * The age is not decoration and the surface is expected to show it: `/loc` answers only when
   * typed, so after a historical fold the newest reading can be days old. A marker with no stated
   * age is a marker implying "you are here", which is the one thing this feature cannot know.
   */
  markerTs: number | null
  /** A well-formed reading was entered: remember it for this zone, and go look at it. */
  place: (loc: EqLoc) => void
  /** Centre on the marker already placed. The chip's click. */
  show: () => void
  /** Forget this zone's marker. */
  clear: () => void
}

export function useLocMarker(
  zone: ZoneShort | null,
  vp: MapViewport,
  reading: LocReading | null
): LocMarkerState {
  const [marks, setMarks] = useState<LocMarkers>(loadLocMarkers)
  useEffect(() => {
    saveLocMarkers(marks)
  }, [marks])

  const marker = locMarkerFor(marks, zone)
  const { centerOn, zoomedIn, view } = vp

  // THE LOG-FED PLACEMENT. Keyed on the reading's own instant so a re-render cannot re-place it,
  // and filed under the READING's zone rather than the open one (see the header). A reading whose
  // zone the table cannot resolve is dropped rather than guessed at: law 12 says a cross-source
  // name is knowledge, never a fuzzy match, and a marker filed under the wrong stem is worse than
  // no marker at all.
  const readingTs = reading?.ts ?? null
  useEffect(() => {
    if (reading == null) return
    const short = zoneShortName(reading.zone)
    if (short == null) return
    setMarks((prev) => setLocMarker(prev, short, locFromReading(reading)))
    // `readingTs` is the dependency that matters; `reading` is re-created by every delta and would
    // re-run this on renders that changed nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readingTs])

  // Fitted ⇒ a marker is a few pixels from everything else, so the jump also zooms in; already
  // zoomed ⇒ keep the scale the user chose. Identical to the search jump, on purpose.
  const goTo = useCallback(
    (loc: EqLoc) => {
      const p = mapFromLoc(loc)
      centerOn(p.x, p.y, zoomedIn ? undefined : view.scale * JUMP_ZOOM)
    },
    [centerOn, zoomedIn, view.scale]
  )

  const place = useCallback(
    (loc: EqLoc) => {
      // No map open ⇒ nowhere to remember it. The field is gated on `hasMap`, so this is a guard,
      // not a path: a marker filed under no zone could never be found again.
      if (zone == null) return
      setMarks((prev) => setLocMarker(prev, zone, loc))
      goTo(loc)
    },
    [zone, goTo]
  )

  const show = useCallback(() => {
    if (marker != null) goTo(marker)
  }, [marker, goTo])

  const clear = useCallback(() => {
    if (zone == null) return
    setMarks((prev) => clearLocMarker(prev, zone))
  }, [zone])

  // The age belongs to the marker ONLY while the marker still IS that reading. Derived rather
  // than stored: a paste, a clear or a zone change all take the age away by construction, with no
  // second piece of state to fall out of step.
  const markerTs =
    reading != null && zoneShortName(reading.zone) === zone && sameLoc(marker, locFromReading(reading))
      ? reading.ts
      : null

  return { marker, markerTs, place, show, clear }
}
