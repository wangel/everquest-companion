// CampPrompt — "a named just died; type /loc and I will remember the camp".
//
// IT GOES TO THE TOAST OVERLAY, NOT THE MAIN WINDOW, and that is the whole point of this file.
// The first cut drew a card in the app; the owner killed a named, typed `/loc`, and never saw it -
// because EverQuest was foreground and the app was behind it. A prompt the player cannot see while
// playing is not a prompt. The toast overlay is always-on-top, defaults OPEN, and already exists
// for exactly this shape of message (docs/plans/celebration-toasts.md).
//
// THE CARD ANSWERS ITSELF. The toast channel's own contract is that "a repeat id refreshes the card
// already on screen", so the SAME id is re-sent when the `/loc` lands, carrying the confirmation
// instead. That turns the awkward case - a card still saying "type /loc" ten seconds after you
// typed it - into the useful one: the question becomes its own receipt. No new IPC, no cancel
// channel, no second window.
//
// ALWAYS MOUNTED, like the celebration detectors it sits beside: a named dies while you are on
// whatever tab you were already on, and this producer must run regardless of which view is up.
//
// THE COPY, and why each word is there:
//   * "type /loc" - the app is asking for something only the player can supply. The log states no
//     position on any combat line, which is why this is a question rather than a calculation.
//   * "camp", never "spawn point" - a pin records where YOU stood, and the app cannot tell whether
//     you typed it on the corpse or at the zone line. A camp is true either way.
//
// NO DISMISS AFFORDANCE OF ITS OWN. Ignoring it IS the dismissal - the arm expires and that mob
// goes quiet for five minutes (petNudge's QUIET). The toast card's own × still closes it, which is
// the overlay's business rather than this feature's.

import { useEffect, useRef, type JSX } from 'react'
import { CAMP_SHOW_MS, campKey, type CampDelta, type CampSnap } from '@shared/campPins'
import { useModule } from '../../lib/useModule'

/** The toast id for one question. Stable across the ask and the receipt, so the card is replaced. */
function promptToastId(mob: string, zone: string, killedTs: number): string {
  return `camp:${campKey(mob, zone)}:${String(killedTs)}`
}

/**
 * The producer. Renders nothing: the card it asks for is drawn by the toast OVERLAY, in its own
 * always-on-top window, over the game.
 */
export function CampPromptHost(): JSX.Element | null {
  const snap = useModule<CampSnap, CampDelta>('campPins', (_state, delta) => delta)
  const prompt = snap?.prompt ?? null

  /** The question already asked, so a re-render or an unrelated delta cannot ask it twice. */
  const asked = useRef<string | null>(null)
  /** The question awaiting an answer, kept so the receipt can reuse its id after `prompt` clears. */
  const pending = useRef<{ id: string; mob: string; zone: string } | null>(null)

  useEffect(() => {
    if (prompt === null) return
    const id = promptToastId(prompt.mob, prompt.zone, prompt.killedTs)
    if (asked.current === id) return
    asked.current = id
    pending.current = { id, mob: prompt.mob, zone: prompt.zone }
    window.eq.showToast({
      id,
      kind: 'campPrompt',
      title: `${prompt.mob} down`,
      subtitle: `Type /loc to pin its camp - ${prompt.zone}`,
      // The card must not outlive the window that gives it meaning: once SHOW closes, a `/loc`
      // pins nothing, so a card still asking would be asking for something that cannot work.
      durationMs: Math.max(1000, prompt.killedTs + CAMP_SHOW_MS - Date.now())
    })
  }, [prompt])

  // THE RECEIPT. When the pin for the pending question appears, re-send its id with the answer -
  // the overlay replaces the card in place, so the question visibly becomes its confirmation.
  const pins = snap?.pins.pins
  useEffect(() => {
    const p = pending.current
    if (!p || !pins) return
    const pin = pins[campKey(p.mob, p.zone)]
    if (!pin) return
    pending.current = null
    window.eq.showToast({
      id: p.id,
      kind: 'campPrompt',
      title: `Camp pinned - ${p.mob}`,
      subtitle: `${String(Math.round(pin.ns))}, ${String(Math.round(pin.ew))} in ${p.zone}`,
      durationMs: 4000
    })
  }, [pins])

  return null
}
