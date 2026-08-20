// CampPrompt — "a named just died; type /loc and I will remember the camp".
//
// ALWAYS MOUNTED, like AlertPlayer beside it, because a named dies while you are looking at
// whatever tab you were already on. A prompt that only appeared on the Maps tab would be a prompt
// nobody ever sees: you are in the fight, not in the map viewer.
//
// THE COPY IS THE FEATURE, so it is worth saying why each word is there:
//   * "type /loc" — the app is asking for something only the player can supply. The log states no
//     position on any combat line, which is the whole reason this is a question rather than a
//     calculation (shared/campPins.ts).
//   * "camp", never "spawn point" — a pin records where YOU stood, and the app cannot tell whether
//     you typed it on the corpse or at the zone line. A camp is a claim about you, true either way.
//   * The COUNTDOWN, because the window is real: a `/loc` after it closes pins nothing, and a card
//     that vanished without saying it was timed would read as the feature being broken.
//
// NO DISMISS BUTTON. Ignoring it IS the dismissal — the window closes on its own and that mob then
// goes quiet for five minutes (petNudge's QUIET, and its reasoning). A button would add a decision
// to a moment when the player is looting a corpse, and the honest answer to "I do not want this" is
// the same as the answer to "I did not notice", so they may as well be the same gesture.

import { useEffect, useState, type JSX } from 'react'
import { Box, Card, Stack, Typography } from '@mui/material'
import PlaceIcon from '@mui/icons-material/Place'
import { CAMP_SHOW_MS, type CampDelta, type CampSnap } from '@shared/campPins'
import { useModule } from '../../lib/useModule'

export interface CampPromptProps {
  /** The mob that died and the zone it died in, or null when nothing is pending. */
  prompt: { mob: string; zone: string; killedTs: number } | null
}

export function CampPrompt({ prompt }: CampPromptProps): JSX.Element | null {
  // A LOCAL CLOCK, because the countdown has to move between deltas. Main re-sends the module on
  // its own tick, but the seconds must fall smoothly rather than in whatever steps the fold
  // happens to flush - and a clock that only runs while a prompt is up costs nothing the rest of
  // the time.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (prompt === null) return undefined
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [prompt])

  if (prompt === null) return null
  const left = Math.max(0, Math.ceil((prompt.killedTs + CAMP_SHOW_MS - now) / 1000))

  return (
    <Box
      sx={{
        position: 'fixed',
        left: '50%',
        bottom: 24,
        transform: 'translateX(-50%)',
        zIndex: (t) => t.zIndex.snackbar,
        pointerEvents: 'none'
      }}
      data-testid="camp-prompt"
    >
      <Card variant="outlined" sx={{ px: 2, py: 1.25, borderColor: 'info.main' }}>
        <Stack direction="row" spacing={1.25} alignItems="center">
          <PlaceIcon fontSize="small" color="info" />
          <Stack spacing={0.25}>
            <Typography variant="body2">
              <strong>{prompt.mob}</strong> down in {prompt.zone}
            </Typography>
            {/* NO EM DASHES IN COPY (JOS-106) - a normal dash with spaces. */}
            <Typography variant="caption" color="text.secondary">
              Type /loc to pin its camp - {left}s
            </Typography>
          </Stack>
        </Stack>
      </Card>
    </Box>
  )
}

/**
 * The one subscription, HERE rather than in App.tsx for two reasons: App is at the repo's
 * 400-code-line cap and the stated answer is to move something out, and the module reports a
 * revision of its own (JOS-87) so it pushes far more often than the views around it care about -
 * keeping the subscription in its own component stops every tick re-rendering the whole app.
 */
export function CampPromptHost(): JSX.Element | null {
  const snap = useModule<CampSnap, CampDelta>('campPins', (_state, delta) => delta)
  return <CampPrompt prompt={snap?.prompt ?? null} />
}
