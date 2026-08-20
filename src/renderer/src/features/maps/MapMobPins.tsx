// The WIKI PIN LAYER — where the catalog says this zone's named mobs spawn.
//
// A SECOND, CLEARLY DIFFERENT SYMBOL. `MapPointsLayer` draws the map file's own labels in the
// pack author's colours, because those colours ENCODE a category (zone connection, banker,
// merchant…) and recolouring them would destroy meaning. These pins are not that: they come from
// a different authority (the wiki catalog, not the map file), so they get one deliberate colour
// of their own — the theme's warning tone, the same one the search-jump ring already uses — and
// a triangular pin shape rather than a round dot. A user must never have to ask which source a
// mark came from.
//
// EVERY PIN CARRIES ITS MOB'S NAME. A tooltip answers "what is this one?" only for the pin the
// mouse is already on, which is the wrong question for a map — you read a map to find WHERE a mob
// is, so the name has to be legible without hunting. The name is drawn in the pin's own warning
// tone; when the mob is WATCHED the label switches to the success tone and appends the countdown,
// so "tracked" and "untracked" differ by colour at a glance rather than by presence of text.
//
// ONE LABEL PER MOB, NOT PER PIN. A page may state eight spawn points (`60% @ (a,b), 40% @ (c,d)`)
// and eight copies of the same name is a pile, not a list — so only a row's FIRST pin is labelled
// and the rest stay bare dots. Their tooltips still name them, which is what a tooltip is for.
//
// IT ONLY DRAWS WHAT THE PANE IS SHOWING. The pins follow the pane's filtered mob list, so
// typing "sarnak" narrows the map as well as the list. That is also what keeps the layer honest
// at scale: unfiltered Kael Drakkel is 343 named mobs, several of which state eight spawn points
// each, and `pinsForRows` caps the drawn set (reported, never silently trimmed).
//
// INERT, like the label layer: `pointerEvents:'none'` on the container so drag-to-pan works
// straight through it, re-enabled on each pin so its tooltip works. Clicking a pin is
// deliberately NOT a gesture — selection lives in the pane, where the row can also say "no
// location on the wiki page", and two selection surfaces would be two things to keep in sync.

import { Fragment, useMemo, type JSX } from 'react'
import { useTheme } from '@mui/material'
import type { PlacedPin } from './mobPins'
import type { MapViewport } from './useMapViewport'
import type { RespawnRow } from '@shared/respawn'
import { mapClockText } from './mapClock'

/** Pin body size in CSS pixels. Does not scale with zoom, for the same reason label text doesn't. */
const PIN_PX = 9

export interface MapMobPinsProps {
  /** The pins to draw — already capped and keyed by `pinsForRows`, in list order. */
  pins: readonly PlacedPin[]
  vp: MapViewport
  /**
   * The pane's selected row id. It raises that row's pins above the rest; the RING around the
   * selection is drawn once by MapsView, for mobs and map labels alike, so there is exactly one
   * "this is the thing you clicked" symbol on the surface.
   */
  selectedId: string | null
  /**
   * The watched rows of this zone, by folded mob name — a pin whose mob you are tracking draws its
   * countdown. Absent when nothing is watched, which is the fresh-install case and most zones.
   */
  clocks?: Map<string, RespawnRow>
  /** The app's one 1 Hz clock. Only read when `clocks` has a hit. */
  now?: number
}

export function MapMobPins({ pins, vp, selectedId, clocks, now }: MapMobPinsProps): JSX.Element {
  const { toScreen } = vp
  // The SAME token the search-jump marker paints with (`warning.main`), read from the theme
  // rather than spelled as a hex literal so a theme change can never leave the two disagreeing.
  const theme = useTheme()
  const pinColor = theme.palette.warning.main
  // The clock is the USER's claim (they asked for it), so it takes the tone nothing else
  // on this surface uses - the same one the camps layer paints with.
  const clockColor = theme.palette.success.main
  // Keyed on the pin array and the projection, exactly like the label layer's declutter memo:
  // this recomputes per view CHANGE, not per frame.
  const placed = useMemo(() => pins.map((p) => ({ ...p, at: toScreen(p.pin.x, p.pin.y) })), [pins, toScreen])

  return (
    <div
      data-testid="maps-mob-pins"
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}
    >
      {placed.map(({ row, pin, key, at }) => {
        const selected = row.id === selectedId
        // THE CLOCK THIS APP ALREADY KEEPS, on the pin the app already draws. A watched mob's
        // countdown belongs where the mob is, and the wiki has placed 6,304 of them for us - there
        // was never a reason to ask the player for a position the catalog already had.
        const clock = mapClockText(clocks?.get(row.name.trim().toLowerCase()), now ?? 0)
        // Reference equality against the row's own array — `pinsForRows` pushes `row.pins[i]`
        // itself, so this is "is this the first spawn point of its mob" without re-deriving an
        // index from the React key.
        const labelled = row.pins[0] === pin
        return (
          <Fragment key={key}>
          <span
            data-testid="maps-mob-pin"
            title={
              pin.pct === undefined
                ? row.name
                : // The page's OWN number, verbatim — never rounded into "likely" or "rare".
                  `${row.name} - ${String(pin.pct)}% of spawns`
            }
            style={{
              position: 'absolute',
              left: at.px,
              top: at.py,
              width: PIN_PX,
              height: PIN_PX,
              marginLeft: -PIN_PX / 2,
              marginTop: -PIN_PX / 2,
              borderRadius: '50% 50% 50% 0',
              transform: 'rotate(-45deg)',
              background: pinColor,
              boxShadow: '0 0 0 1px rgba(0,0,0,0.85)',
              opacity: selected ? 1 : 0.85,
              pointerEvents: 'auto',
              zIndex: selected ? 3 : 1
            }}
          />
          {labelled && (
            // THE NAME, and the countdown when the mob is watched. The clock takes the SUCCESS
            // tone rather than the pin's warning one: the pin is "the wiki placed this", the clock
            // is "and you are tracking it" - two different claims, and the second is the user's.
            <span
              data-testid="maps-mob-label"
              data-mob={row.name}
              {...(clock === null ? {} : { 'data-clock': clock })}
              style={{
                position: 'absolute',
                left: at.px + PIN_PX,
                top: at.py - PIN_PX / 2,
                whiteSpace: 'nowrap',
                fontSize: 11,
                color: clock === null ? pinColor : clockColor,
                textShadow: '0 0 3px rgba(0,0,0,0.9)',
                pointerEvents: 'none',
                zIndex: clock === null ? 2 : 3
              }}
            >
              {row.name}
              {clock === null ? '' : ` · ${clock}`}
            </span>
          )}
          </Fragment>
        )
      })}
    </div>
  )
}
