// THE ONE PLACE A POSITION CAN ENTER THIS APP (JOS-98) — type or paste a `/loc`, get a marker.
//
// WHY A TEXT BOX ON A TOOLBAR THAT "DESCRIBES THE DRAWING". Because this control describes the
// drawing: it states the one position drawn on the surface, and it is one of the two ways to put
// one there.
//
// IT IS NO LONGER THE ONLY WAY, AND THE REASON IT WAS IS WORTH KEEPING. This header used to say
// "the log never says where you are standing, so the alternative to a box is no marker at all",
// and locMarker.ts still carries the measurement it rested on: `Your Location` appeared ZERO
// times across a 116.8 MB log. The measurement was true and the conclusion was not — nobody had
// typed `/loc`. The game DOES log it (shared/maps.ts LocEvent has the sample that settled it), so
// the marker now moves on its own whenever a player types the command in game.
//
// THE BOX STAYS ANYWAY, and not out of sentiment: the log can only ever say where you ARE. Typing
// a position is how you mark somewhere you are NOT — a camp you are walking to, a spot read off a
// wiki page, a corpse you are coming back for. Those are questions the log cannot answer at all.
//
// THE FIELD EMPTIES ON SUCCESS AND THE CHIP TAKES OVER. Two controls, two jobs: the box is where a
// loc goes IN, the chip is what the app currently BELIEVES — stated in the game's own words and
// order so it can be checked against the game window without translation. A box that kept the text
// would be claiming to be both, and a marker you cleared would still be sitting in it.
//
// A REFUSAL IS PROSE AND IT STAYS PUT. The message names what the parser choked on and does not
// vanish on a timer — the user is about to retype something, and an error that disappears while
// they are reading it is worse than none. It clears when they type, which is the moment it stopped
// being true.
//
// CLEARING IS ON THE CHIP, NOT ON THE MAP. The marker persists across restarts; a stray click on a
// map surface must never be able to delete something the user typed and expects to find again.
//
// NO POPPER (JOS-143). This group sits at the wrapping end of the maps toolbar, so on a narrow
// window it lands on the row BELOW the two pack selects and the zone combobox — a card opened from
// here covers them. The field's own tooltip was the worse offender for a second reason the planner
// already wrote down (`ClassFilter`, owner 2026-08-05): a hover box over an input the user types
// into floats exactly where its own affordances are and reads as the UI blocking itself. All three
// strings survive as native `title`s.

import { useState, type JSX, type KeyboardEvent } from 'react'
import { Chip, IconButton, Stack, TextField, Typography } from '@mui/material'
import AddLocationAltIcon from '@mui/icons-material/AddLocationAlt'
import CancelIcon from '@mui/icons-material/Cancel'
import PlaceIcon from '@mui/icons-material/Place'
import type { EqLoc } from './mapGeometry'
import { formatLoc, parseLoc } from './locMarker'
import { formatAge, formatDateTime } from '../../lib/formatDate'

export interface MapLocFieldProps {
  /** This zone's remembered marker, or null when it has none. */
  marker: EqLoc | null
  /**
   * When the game printed the `/loc` this marker came from, or null when it was typed here.
   *
   * SHOWN, ALWAYS, when it exists. `/loc` answers only when asked, so a logged marker is a fact
   * about an instant and can be days old — after a historical fold it usually is. A marker that
   * does not say how old it is reads as "you are here", which is the one thing this app cannot
   * know (law 6).
   */
  markerTs: number | null
  /** A well-formed reading was entered — place it, and remember it for this zone. */
  onPlace: (loc: EqLoc) => void
  /** Centre the view on the marker that is already placed. */
  onShow: () => void
  /** Forget this zone's marker. The only thing that ends one, besides entering another. */
  onClear: () => void
}

export default function MapLocField({
  marker,
  markerTs,
  onPlace,
  onShow,
  onClear
}: MapLocFieldProps): JSX.Element {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const commit = (): void => {
    const parsed = parseLoc(text)
    if (!parsed.ok) {
      setError(parsed.reason)
      return
    }
    setError(null)
    setText('')
    onPlace(parsed.loc)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Enter') return
    commit()
    e.preventDefault()
  }

  return (
    <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap data-testid="maps-loc">
      <TextField
        size="small"
        label="/loc marker"
        placeholder="1414.20, -735.55, 12.19"
        value={text}
        error={error != null}
        data-testid="maps-loc-field"
        title="Type /loc in game and paste the line here - north/south, west/east, elevation."
        slotProps={{
          htmlInput: { 'data-testid': 'maps-loc-input', 'aria-label': 'Place a marker from a /loc' }
        }}
        onChange={(e) => {
          setText(e.target.value)
          setError(null)
        }}
        onKeyDown={onKeyDown}
        sx={{ minWidth: 210 }}
      />
      {/* The span outlives its tooltip: the button is disabled until something is typed, and a
          disabled button swallows no mouse events. */}
      <span title="Place the marker">
        <IconButton
          size="small"
          aria-label="Place the marker"
          data-testid="maps-loc-place"
          disabled={text.trim() === ''}
          onClick={commit}
        >
          <AddLocationAltIcon fontSize="small" />
        </IconButton>
      </span>
      {marker != null && (
        <Chip
          size="small"
          color="info"
          variant="outlined"
          icon={<PlaceIcon />}
          data-testid="maps-loc-chip"
          title={
            markerTs == null
              ? 'The location you entered. Click to centre on it; ✕ to remove it.'
              : `From the /loc you typed in game at ${formatDateTime(markerTs)}. Type /loc again to update it. Click to centre on it; ✕ to remove it.`
          }
          label={markerTs == null ? formatLoc(marker) : `${formatLoc(marker)} · ${formatAge(markerTs)}`}
          onClick={onShow}
          onDelete={onClear}
          // NAMED, because the chip carries TWO icons and they do OPPOSITE things: the leading
          // Place icon is part of the click target that centres on the marker, and this one
          // deletes it. MUI's own class names distinguish them, but a spec that clicks
          // `[chip] svg` gets the first — which is how the clear affordance was first asserted
          // green while doing nothing at all.
          deleteIcon={<CancelIcon data-testid="maps-loc-clear" titleAccess="Remove this marker" />}
        />
      )}
      {error != null && (
        <Typography variant="caption" color="error" data-testid="maps-loc-error" sx={{ maxWidth: 420 }}>
          {error}
        </Typography>
      )}
    </Stack>
  )
}
