// loc module — WHERE YOU SAID YOU WERE, in the game's own words.
//
// Folds the `loc` event (shared/maps.ts LocEvent, parsed by log/parseWorld.ts classifyLoc) into
// the one thing worth keeping: the most recent reading, tagged with the zone it was printed in.
// Read that event's header first — this line was believed not to exist in the log at all, and the
// map marker shipped as a paste box because of it.
//
// ============================================================================================
// ONE READING, AND NO TRAIL. This is the load-bearing decision in the file.
// ============================================================================================
//
// The obvious design keeps a history and draws a breadcrumb between the points. It is wrong, and
// not subtly: `/loc` answers ONLY when a player types it, so two readings can be a minute or an
// hour apart, and the line between them asserts a route through whatever walls happen to lie on
// the segment. That is precisely what law 1 forbids (anything inferred is LABELED inferred, never
// silently guessed) and what law 6 means by saying what the log cannot say. A drawn line is not
// labelled a guess; it reads as a path.
//
// With no line to draw, there is nothing for a history to be for. The join this module was
// originally going to serve — a kill pinned to a nearby reading — does not need one either: the
// fold processes events IN ORDER, so when a kill arrives the current reading already IS the most
// recent prior one. So the module keeps one reading and the file stays small.
//
// THE TIMESTAMP IS NOT DECORATION. A reading is a fact about an INSTANT and says nothing about the
// time on either side of it, so every consumer gets `ts` and is expected to say how old the marker
// is. That matters most right after a fold: a historical replay ends on the last `/loc` in the
// log, which may be days old. MEASURED on a reporter's logs — a 253 MB archive of ordinary play
// contains ZERO readings, and the live log two, sixteen seconds apart. A module serving a bare
// `{x, y}` would make "this is from last Tuesday" impossible to say.

import type { EqModule } from './types'
import type { LogEvent } from '../../shared/logEvents'
import type { LocDelta, LocReading, LocSnap } from '../../shared/maps'

export class LocModule implements EqModule<LocSnap, LocDelta> {
  readonly id = 'loc'
  private current: LocReading | null = null
  private zone: string | undefined
  private seq = 0
  private pending: LocReading | null = null

  reset(): void {
    this.current = null
    this.zone = undefined
    this.seq = 0
    this.pending = null
  }

  /** The newest reading, or null. Read directly by main-side consumers that must not wait on IPC. */
  reading(): LocReading | null {
    return this.current
  }

  onEvent(ev: LogEvent): void {
    this.seq = ev.seq
    if (ev.kind === 'epoch') {
      // Character rebirth (Task #49): where a dead same-name character stood is not where YOU
      // stood. `zone` is world state and survives, exactly as loot.ts treats it — the next zone
      // line refreshes it either way.
      this.current = null
      this.pending = null
      return
    }
    if (ev.kind === 'zone') {
      this.zone = ev.zone
      return
    }
    if (ev.kind !== 'loc') return
    // TAGGED WITH THE ZONE THE FOLD STANDS IN, at the instant it was printed. A later zone line
    // must never re-file an earlier reading, which is why the tag rides the ROW rather than being
    // read off the module when somebody asks.
    const reading: LocReading = {
      ts: ev.ts,
      ns: ev.ns,
      ew: ev.ew,
      z: ev.z,
      ...(this.zone === undefined ? {} : { zone: this.zone })
    }
    this.current = reading
    this.pending = reading
  }

  snapshot(): { seq: number; state: LocSnap } {
    return { seq: this.seq, state: { current: this.current } }
  }

  flushDelta(): { seq: number; delta: LocDelta } | null {
    if (this.pending === null) return null
    const delta: LocDelta = { current: this.pending }
    this.pending = null
    return { seq: this.seq, delta }
  }
}
