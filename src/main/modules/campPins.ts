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
// AND THEN A THIRD CONDITION: there has to be something left to ASK. Two questions can come off
// one kill and each has its own gate (`CampAsk` in shared/campPins.ts states them):
//
//   * WHERE IT CAMPS — only when the catalog states no coordinates. 77% of in-era named mobs carry
//     wiki coordinates that `MapMobPins` has been drawing all along, so asking about those is
//     asking a player to place a pin already on screen. That question is for the 128 the wiki
//     missed, and nothing else.
//   * WHETHER TO WATCH IT — only for a mob on the wiki's NOTABLE list that the player is not
//     already watching. This one is answered by a CLICK, not by the game: EverQuest has no
//     `/watch` line for the log to state, so the card carries a button (shared/toast.ts).
//     Deliberately NOT offered for the watch-list half of `arms` below - a mob you watch is a mob
//     you watch - and never for trash, because `isNamedMob` is the entire gate on it.
//
// A kill that raises neither raises nothing. That is what keeps the third condition from becoming
// "ask about everything again": most named kills now produce one button, not one interrogation.
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
import { KILL_EXP_JOIN_MS } from '../../shared/kills'
import { catalogHasCoords, isNamedMob } from '../namedDb'
import type { CampAsk, CampDelta, CampSnap } from '../../shared/campPins'
import {
  CAMP_QUIET_MS,
  armIsLive,
  campKey,
  setCampPin,
  type CampArm,
  type CampPin,
  type CampPins
} from '../../shared/campPins'

export class CampPinsModule implements EqModule<CampSnap, CampDelta> {
  readonly id = 'campPins'
  /**
   * Told when a pin is ANSWERED, so main can write it.
   *
   * A callback rather than a store import, for the reason every module here keeps: the fold has to
   * stay constructible under plain node (the bench and tests/foldDeterminism.test.mts both do it),
   * and a module that reaches for electron-store cannot. Absent in tests, which is why the tests
   * assert the module's own state rather than the file.
   */
  private onPinned: ((pins: CampPins, answered: CampPin) => void) | null = null
  private pins: CampPins = { pins: {} }
  private arm: CampArm | null = null
  private zone: string | undefined
  private watched: ReadonlySet<string> = new Set()
  /** A mob that ignored its prompt asks nothing again until this instant. Key: `campKey`-folded. */
  private quietUntil = new Map<string, number>()
  /**
   * Mobs whose WATCH OFFER was ignored. Once, for the session — never asked again.
   *
   * QUIET IS THE WRONG CLOCK FOR THIS QUESTION, and a replay of the owner's log proved it: five
   * minutes of quiet against a ten-minute respawn means an unanswered offer comes back on EVERY
   * pop. `a ghoul supplier` asked five times in forty minutes at one camp. That is precisely the
   * nag petNudge's QUIET exists to prevent, arriving through the door QUIET left open.
   *
   * The difference is what the question is ABOUT. "Where does this mob camp?" is about a kill, so
   * asking again after a while is reasonable - you may have been busy, and the next corpse is a
   * fresh chance to answer. "Do you want a clock on this mob?" is about the MOB, and the answer
   * does not change because it spawned again. Silence is an answer, and it holds.
   *
   * NOT PERSISTED, like the arm itself: a decision this cheap to re-offer once per session costs
   * one card, and a stored "never ask me about this mob" is a preference the user never knowingly
   * set. Killing the app is how you take it back.
   */
  private declinedWatch = new Set<string>()
  /** The experience line the next death may claim. See `takeExp` - this is the CREDIT gate. */
  private pendingExpTs: number | null = null
  private rev = 0
  private dirty = false

  reset(): void {
    this.pins = { pins: {} }
    this.arm = null
    this.zone = undefined
    this.quietUntil = new Map()
    this.declinedWatch = new Set()
    this.pendingExpTs = null
    this.dirty = false
  }

  /** Where an answered pin goes. Set by main; absent under test. */
  setPersist(fn: (pins: CampPins, answered: CampPin) => void): void {
    this.onPinned = fn
  }

  /** Seed the persisted camps. Set at wiring, before the fold. */
  setPins(pins: CampPins): void {
    this.pins = pins
    this.bump()
  }

  /** Which mobs the user has asked for a clock on — the second thing that can arm a prompt. */
  setWatched(names: Iterable<string>): void {
    this.watched = new Set([...names].map((n) => n.trim().toLowerCase()))
    // A WATCH EDIT CHANGES WHAT THE LIVE CARD IS ASKING, so it has to reach the surface. Pressing
    // the card's own button lands here (ipc/respawn.ts -> startWatching), and without this the
    // prompt would go on offering a watch the player just granted until the next log line — which
    // on the idle log of somebody standing over a corpse is never (JOS-87's lesson again).
    this.bump()
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
    if (ev.kind === 'expGain') {
      this.pendingExpTs = ev.ts
      return
    }
    if (ev.kind === 'death') this.onDeath(ev.name, ev.ts)
    else if (ev.kind === 'loc') this.onLoc(ev.ns, ev.ew, ev.z, ev.ts)
  }

  /**
   * The experience line this death claims, if any. Claiming CONSUMES it, so one line can never
   * credit two kills; an unclaimed older line is replaced when a newer one arrives. Copied from
   * `modules/kills.ts` with its semantics intact, because the two ask the same question and a
   * second, subtly different answer to "was this kill mine" is the drift law 4 is a scar from.
   */
  private takeExp(ts: number): boolean {
    const at = this.pendingExpTs
    this.pendingExpTs = null
    return at !== null && ts >= at && ts - at <= KILL_EXP_JOIN_MS
  }

  private onDeath(mob: string, ts: number): void {
    // CONSUMED FIRST, whatever happens next - kills.ts consumes before its own filter for the same
    // reason: a line left pending would hand this kill's experience to the next mob that dies.
    const credited = this.takeExp(ts)
    const zone = this.zone
    if (zone === undefined) return
    // THE CREDIT GATE, and the reason it is not optional. Your log prints EVERY death in earshot,
    // including a stranger's kill across a public zone - the owner watched a ghoul executioner die
    // to somebody else and be asked about. `/loc` would then pin where HE was standing, which is a
    // fabricated camp for a mob he never fought.
    //
    // A kill is yours only when the log PAID you for it, and it says so in exactly one way: an
    // experience line immediately before the slain line (JOS's celebration fix, 2026-08-05, from
    // the same complaint one surface over). That covers a GROUP kill for free - a group-mate's
    // killing blow still pays party experience into your log - and excludes the stranger, whose
    // kill pays you nothing and prints nothing. It is the log's own answer to "was this mine",
    // which is better than any guess about whether we engaged it.
    if (!credited) return
    if (!this.arms(mob, zone)) return
    // NOTHING LEFT TO ASK, NO CARD. `askOf` is the whole of what a prompt could still want: a
    // position the catalog does not have, or a watch the player has not granted. A named you
    // already watch, whose coordinates the wiki already states, is a mob this app has no question
    // about - and before the ask existed that was silently the same test as `catalogHasCoords`.
    if (this.askOf(mob, zone) === null) return
    const key = campKey(mob, zone)
    // QUIET: this mob's prompt was ignored recently, so it does not ask again yet.
    const quiet = this.quietUntil.get(key)
    if (quiet !== undefined && ts < quiet) return
    // ONE SLOT. A newer corpse replaces an older question - it is the one you are standing on.
    this.arm = { mob, zone, killedTs: ts }
    this.bump()
  }

  /**
   * Does this kill deserve a question? Roster OR watch list, never inference - and then only when
   * the catalog cannot answer it already (see `onDeath`).
   */
  private arms(mob: string, zone: string): boolean {
    return isNamedMob(mob, zone) || this.watched.has(mob.trim().toLowerCase())
  }

  /**
   * WHAT IS STILL BEING ASKED about this mob, or null when the answer is "nothing".
   *
   * RECOMPUTED, NEVER STORED ON THE ARM. The answer changes underneath a live card — that is the
   * entire mechanism by which pressing `Watch for respawn` retires the question: `setWatched` lands
   * from the IPC handler, `offerWatch` goes false on the next read, and a card with nothing left to
   * ask stops being published. Freezing the two flags at arm time would leave the surface offering
   * a watch it had already been granted.
   */
  private askOf(mob: string, zone: string): CampAsk | null {
    const offerWatch =
      isNamedMob(mob, zone) &&
      !this.watched.has(mob.trim().toLowerCase()) &&
      !this.declinedWatch.has(campKey(mob, zone))
    const needsLoc = !catalogHasCoords(mob)
    return offerWatch || needsLoc ? { needsLoc, offerWatch } : null
  }

  /**
   * A `/loc` answers whatever is armed — inside SHOW, whether or not a card was ever drawn (a
   * prompt answered inside GRACE is answered all the same; the card just never appeared).
   */
  private onLoc(ns: number, ew: number, z: number, ts: number): void {
    const arm = this.arm
    if (!armIsLive(arm, ts) || arm === null) return
    // ONLY WHERE A POSITION WAS ASKED FOR. A card can now be live purely to offer a watch, for a
    // mob whose spawn the wiki already states — and a `/loc` typed while that card is up is the
    // player doing something else entirely. Recording it would manufacture the exact duplicate
    // (a green camp beside an orange spawn pin, a few units apart) that MapCampPins was taught to
    // hide, which is a bug worth not creating rather than worth filtering.
    if (!this.askOf(arm.mob, arm.zone)?.needsLoc) return
    const pin: CampPin = { mob: arm.mob, zone: arm.zone, ns, ew, z, ts }
    this.pins = setCampPin(this.pins, pin)
    this.arm = null
    this.bump()
    // WRITTEN THE INSTANT IT IS ANSWERED, not on a timer. A pin is a thing the player just did in
    // answer to a question the app asked; losing it to a crash would be losing an interaction, and
    // nothing can re-derive it (the log never says where a kill happened).
    this.onPinned?.(this.pins, pin)
  }

  /**
   * The clock the prompt expires on. `onTick` rather than a timer, because a historical replay has
   * no wall clock (tests/foldDeterminism.test.mts: a replay reads none) and the registry's 1 s tick
   * is what drives time-based state while the log idles.
   */
  onTick(now: number): void {
    const arm = this.arm
    if (arm === null) return
    if (armIsLive(arm, now)) return
    // IGNORED. It goes quiet rather than asking again on the next spawn - the player said no by
    // saying nothing, and a prompt that reappears every nine minutes is the nag petNudge's QUIET
    // exists to prevent.
    const key = campKey(arm.mob, arm.zone)
    this.quietUntil.set(key, now + CAMP_QUIET_MS)
    // AN IGNORED WATCH OFFER IS A NO, AND IT STICKS (see `declinedWatch`). The position question
    // may come back on the next corpse; this one may not, because it was never about the corpse.
    if (this.askOf(arm.mob, arm.zone)?.offerWatch === true) this.declinedWatch.add(key)
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
    const ask = arm === null || !armIsLive(arm, now) ? null : this.askOf(arm.mob, arm.zone)
    return {
      pins: this.pins,
      zone: this.zone ?? null,
      ...(ask !== null && arm !== null
        ? { prompt: { mob: arm.mob, zone: arm.zone, killedTs: arm.killedTs, ...ask } }
        : {})
    }
  }
}
