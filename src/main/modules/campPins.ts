// campPins module — "a named just died; type /loc and I will remember the camp".
//
// The rules, the timings and the reason this is a PROMPT rather than a calculation all live in
// `shared/campPins.ts`. Read that first. This file is the fold: which kills arm it, which `/loc`
// answers it, and what a surface is told.
//
// ============================================================================================
// WHAT ARMS IT, AND WHY NOT EVERY KILL.
// ============================================================================================
//
// A player kills thousands of things (2,304 decaying skeletons in one reporter's log), so "every
// death" is not a feature, it is an alarm clock with no off switch. Two signals already mean "this
// mob matters", and both are used:
//
//   * THE ROSTER (namedDb.ts) — the wiki's own `Notable NPCs` list, era-filtered. This is the
//     DISCOVERY half: it fires before the player has thought to watch anything.
//   * THE WATCH LIST — the mob the player explicitly asked for a respawn clock on (JOS-194). This
//     is the half that needs no data and never goes stale, and it is what covers every mob the
//     roster misses (namedDb.ts states how many that is, and why it cannot be fixed by scraping).
//
// Either is enough. Neither is inferred: the first is somebody's published editorial judgement,
// the second is the user's own instruction.
//
// THE ZONE IS THE BASE ZONE. `zoneTier` strips ` - Group 3`, ` 4 (Refined)` and the rest, because a
// Refined instance of Lower Guk is the same room as the open-world one and a camp pinned in one is
// the camp in the other. The tier is a fact about the difficulty, never about the geography.
//
// NOTHING HERE WRITES THE STORE. The module holds the arm and the pins in memory and reports them;
// `ipc/campPins.ts` persists an answered pin, the same split every other user-writable module
// keeps (the alerts module does not own alerts.json either).

import type { EqModule } from './types'
import type { LogEvent } from '../../shared/logEvents'
import { zoneTier } from '../log/parser'
import { isNamedMob } from '../namedDb'
import {
  CAMP_QUIET_MS,
  armIsLive,
  campKey,
  promptVisible,
  setCampPin,
  type CampArm,
  type CampPin,
  type CampPins
} from '../../shared/campPins'

/** What a surface is told. `prompt` is absent in every state but the one. */
export interface CampSnap {
  /** Every camp this character has pinned. */
  pins: CampPins
  /** The prompt to draw right now, if the grace has passed and the show window has not closed. */
  prompt?: { mob: string; zone: string; killedTs: number }
  /** The zone the fold stands in, so a surface can show this zone's camps without a second source. */
  zone: string | null
}

export type CampDelta = CampSnap

export class CampPinsModule implements EqModule<CampSnap, CampDelta> {
  readonly id = 'campPins'
  private pins: CampPins = { pins: {} }
  private arm: CampArm | null = null
  private zone: string | undefined
  private watched: ReadonlySet<string> = new Set()
  /** A mob that ignored its prompt asks nothing again until this instant. Key: `campKey`-folded. */
  private quietUntil = new Map<string, number>()
  private rev = 0
  private dirty = false

  reset(): void {
    this.pins = { pins: {} }
    this.arm = null
    this.zone = undefined
    this.quietUntil = new Map()
    this.dirty = false
  }

  /** Seed the persisted camps. Set at wiring, before the fold. */
  setPins(pins: CampPins): void {
    this.pins = pins
    this.bump()
  }

  /** Which mobs the user has asked for a clock on — the second thing that can arm a prompt. */
  setWatched(names: Iterable<string>): void {
    this.watched = new Set([...names].map((n) => n.trim().toLowerCase()))
  }

  /**
   * A REVISION OF ITS OWN, not the last event's seq (JOS-87). This module moves on things that are
   * not log events — a pin answered through IPC, a watch list edited in Settings — and `useModule`
   * dedupes on `seq`, so reporting the last event's number would drop those updates forever on an
   * idle log.
   */
  private bump(): void {
    this.rev++
    this.dirty = true
  }

  onEvent(ev: LogEvent): void {
    if (ev.kind === 'zone') {
      this.zone = zoneTier(ev.zone).base
      // A zone line ends any pending question: the corpse is behind you and a `/loc` typed here
      // describes somewhere else entirely.
      if (this.arm) this.arm = null
      this.bump()
      return
    }
    if (ev.kind === 'death') this.onDeath(ev.name, ev.ts)
    else if (ev.kind === 'loc') this.onLoc(ev.ns, ev.ew, ev.z, ev.ts)
  }

  private onDeath(mob: string, ts: number): void {
    const zone = this.zone
    if (zone === undefined) return
    if (!this.arms(mob, zone)) return
    const key = campKey(mob, zone)
    // QUIET: this mob's prompt was ignored recently, so it does not ask again yet.
    const quiet = this.quietUntil.get(key)
    if (quiet !== undefined && ts < quiet) return
    // ONE SLOT. A newer corpse replaces an older question - it is the one you are standing on.
    this.arm = { mob, zone, killedTs: ts }
    this.bump()
  }

  /** Does this kill deserve a question? See the header: roster OR watch list, never inference. */
  private arms(mob: string, zone: string): boolean {
    return isNamedMob(mob, zone) || this.watched.has(mob.trim().toLowerCase())
  }

  /**
   * A `/loc` answers whatever is armed — inside SHOW, whether or not a card was ever drawn (a
   * prompt answered inside GRACE is answered all the same; the card just never appeared).
   */
  private onLoc(ns: number, ew: number, z: number, ts: number): void {
    const arm = this.arm
    if (!armIsLive(arm, ts) || arm === null) return
    const pin: CampPin = { mob: arm.mob, zone: arm.zone, ns, ew, z, ts }
    this.pins = setCampPin(this.pins, pin)
    this.arm = null
    this.bump()
  }

  /**
   * The clock the prompt expires on. `onTick` rather than a timer, because a historical replay has
   * no wall clock (tests/foldDeterminism.test.mts: a replay reads none) and the registry's 1 s tick
   * is what drives time-based state while the log idles.
   */
  onTick(now: number): void {
    const arm = this.arm
    if (arm === null) return
    if (armIsLive(arm, now)) {
      // Crossing out of GRACE makes the card appear, which a surface has to be told about.
      if (promptVisible(arm, now)) this.bump()
      return
    }
    // IGNORED. It goes quiet rather than asking again on the next spawn - the player said no by
    // saying nothing, and a prompt that reappears every nine minutes is the nag petNudge's QUIET
    // exists to prevent.
    const key = campKey(arm.mob, arm.zone)
    this.quietUntil.set(key, now + CAMP_QUIET_MS)
    this.arm = null
    this.bump()
  }

  snapshot(now = Date.now()): { seq: number; state: CampSnap } {
    return { seq: this.rev, state: this.view(now) }
  }

  flushDelta(now = Date.now()): { seq: number; delta: CampDelta } | null {
    if (!this.dirty) return null
    this.dirty = false
    return { seq: this.rev, delta: this.view(now) }
  }

  /** The whole served value. A delta IS a snapshot here: the state is small and always complete. */
  private view(now: number): CampSnap {
    const arm = this.arm
    return {
      pins: this.pins,
      zone: this.zone ?? null,
      ...(promptVisible(arm, now) && arm !== null
        ? { prompt: { mob: arm.mob, zone: arm.zone, killedTs: arm.killedTs } }
        : {})
    }
  }
}
