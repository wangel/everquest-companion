// CAMP PINS — where you camp a named, drawn on the map, with the clock it already has.
//
// A FOURTH AUTHORITY NEEDS A FOURTH SYMBOL. This surface already carries three, and a user must
// never have to ask which source a mark came from (MapLocMarker.tsx states the first three):
//
//   * the MAP FILE's own labels — the pack author's colours, which ENCODE a category;
//   * the WIKI's spawn pins and the search flash — the theme's WARNING tone, "the app found this";
//   * the typed `/loc` marker — the theme's INFO tone and a crosshair, "the one point YOU stated".
//
// A camp is the fourth: a place you told the app about AND a mob you are tracking. It takes the
// theme's SUCCESS tone, which nothing else on the surface uses, and a filled teardrop rather than
// a crosshair — a crosshair says "this exact point", and a camp is a place you stand, not a
// coordinate you measured. It carries the mob's NAME beside it, because a map with five identical
// dots on it answers none of the questions a camp list is asked.
//
// THE CLOCK IS NOT COMPUTED HERE. `respawnReading` is the one place a countdown is derived
// (shared/respawn.ts), the Timers tab reads it, the respawn overlay reads it, and so does this.
// A second arithmetic for "how long until it is up" would be a second answer to the question the
// whole feature exists to answer.
//
// A CAMP WITHOUT A CLOCK STILL DRAWS. The pin is a fact the player stated; the countdown is an
// estimate that may not exist yet (a mob killed once has no gap to learn from). So the label falls
// back to the name alone rather than inventing a time or hiding the pin — the same "say what you
// know, say nothing else" the row bars follow.
//
// INERT, like every other overlay layer here: `pointerEvents:'none'` so drag-to-pan works straight
// through, re-enabled on the pin itself so its tooltip works.

import type { JSX } from 'react'
import { useTheme } from '@mui/material'
import type { RespawnRow } from '@shared/respawn'
import { mapClockText } from './mapClock'
import type { CampPin } from '@shared/campPins'
import { mapFromLoc } from './mapGeometry'
import type { MapViewport } from './useMapViewport'

/** Diameter of the pin's head, CSS pixels. Fixed, like every other mark: a pin is not a distance. */
const PIN_PX = 14

export interface MapCampPinsProps {
  /** This zone's camps. */
  pins: readonly CampPin[]
  /** The watched rows, so a camp can show the clock the respawn module already keeps for it. */
  rows: readonly RespawnRow[]
  /** One shared 1 Hz clock — the same instant every countdown on the app reads. */
  now: number
  vp: MapViewport
}

export function MapCampPins({ pins, rows, now, vp }: MapCampPinsProps): JSX.Element {
  const theme = useTheme()
  const color = theme.palette.success.main
  // KEYED BY ZONE **AND** MOB, because a row id is `<zone key>::<mob key>` and the same name is
  // watched in more than one zone all the time - EQ names are massively duplicated, which is the
  // whole reason JOS-194 made respawn clocks zone-scoped. Keying on the mob alone silently took
  // whichever row happened to come last, so a camp could show another zone's clock: the Timers tab
  // read `4m 04s` for a supplier in Guk while the map read `due` off a different row entirely.
  const byKey = new Map(rows.map((r) => [`${r.zone.trim().toLowerCase()}::${r.key}`, r]))

  return (
    <div
      data-testid="maps-camp-pins"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      aria-hidden
    >
      {pins.map((pin) => {
        const at = mapFromLoc({ ns: pin.ns, ew: pin.ew, z: pin.z })
        const p = vp.toScreen(at.x, at.y)
        const row = byKey.get(`${pin.zone.trim().toLowerCase()}::${pin.mob.trim().toLowerCase()}`)
        const left = mapClockText(row, now)
        return (
          <div
            key={`${pin.mob}:${pin.zone}`}
            data-camp={pin.mob}
            style={{ position: 'absolute', left: p.px, top: p.py, width: 0, height: 0 }}
          >
            <span
              title={`${pin.mob} - camp you pinned${left === null ? '' : ` - ${left}`}`}
              style={{
                position: 'absolute',
                left: -PIN_PX / 2,
                top: -PIN_PX / 2,
                width: PIN_PX,
                height: PIN_PX,
                borderRadius: '50% 50% 50% 0',
                transform: 'rotate(-45deg)',
                background: color,
                border: `1px solid ${theme.palette.background.paper}`,
                pointerEvents: 'auto'
              }}
            />
            {/* The NAME, and the clock when there is one. Left-aligned off the pin so a cluster of
                camps reads as a list rather than a pile. */}
            <span
              style={{
                position: 'absolute',
                left: PIN_PX,
                top: -PIN_PX / 2,
                whiteSpace: 'nowrap',
                font: theme.typography.caption.fontFamily
                  ? `${String(theme.typography.caption.fontSize)} ${theme.typography.caption.fontFamily}`
                  : undefined,
                fontSize: 11,
                color,
                textShadow: `0 0 3px ${theme.palette.background.default}`
              }}
            >
              {pin.mob}
              {left === null ? '' : ` · ${left}`}
            </span>
          </div>
        )
      })}
    </div>
  )
}
