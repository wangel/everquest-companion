// shared/campPins.ts — WHERE YOU CAMP A NAMED, and the prompt that asks you.
//
// THE PROBLEM THIS SOLVES, and why it is a prompt rather than a calculation. The app can tell you a
// named just died (the roster in `src/main/data/named.json`) and it can read a position off the log
// (`/loc`, shared/maps.ts LocEvent), but it can NEVER know where a kill happened: the log states no
// position on any combat line. The other tool in this space joins a kill to whatever `/loc` came
// nearest in time and calls that a spawn point, which is an inference dressed as a measurement — a
// `/loc` from ten minutes and two rooms ago says nothing about where a mob died.
//
// So this asks. A named dies, the app says so, and the position comes from the player typing `/loc`
// while standing on the corpse. That turns the whole feature from an inference into a MESSAGE,
// which is law 1's own preference and the reason it needs no confidence wording anywhere.
//
// ============================================================================================
// THE ARM / CONSUME / EXPIRE CYCLE — `combat/petNudge.ts`'s shape, and its measured constants.
// ============================================================================================
//
// petNudge solved this exact problem for a different question ("your pet is unbound, order it
// once"): a thing happens, the app wants ONE answer from the player, and the failure mode is
// nagging. Its three timings are reused here for the same reasons, stated in its header:
//
//   GRACE  an answer that arrives promptly must never draw a prompt at all. A player who types
//          `/loc` out of habit right after a kill has already answered; showing a card then is the
//          app talking over somebody who is agreeing with it.
//   SHOW   how long the prompt then stands. Long enough to survive looting and the adds that
//          follow a named, short enough that a stale prompt cannot collect a `/loc` typed for an
//          unrelated reason minutes later.
//   QUIET  what stops it nagging. Once a prompt has been ignored, that mob asks nothing again for
//          a while — the player has said no by saying nothing.
//
// ONE SLOT, for the same reason petNudge has one: two prompts at once cannot both be answered by
// the next `/loc`, and guessing which one the player meant is the kind of ambiguity this app is
// supposed to refuse. A second named dying replaces the first — the newer corpse is the one you
// are standing on.
//
// ============================================================================================
// WHAT A PIN IS, AND WHAT IT IS NOT.
// ============================================================================================
//
// A pin is WHERE YOU STOOD when you answered, not where the mob spawned. Those are the same thing
// if you type `/loc` on the corpse and different if you type it at the zone line, and the app
// cannot tell which you did. So the word everywhere is CAMP, never "spawn point": a camp is a
// claim about you, which is true either way.
//
// KEYED BY MOB AND ZONE TOGETHER. EQ names are massively duplicated (JOS-194's ruling on respawn
// clocks is the same observation), so `a ghoul assassin` in Lower Guk and one in Befallen are two
// camps. The key carries both and nothing else — no instance number, because the base zone and its
// Refined instance are the same room.

/** One remembered camp: where you stood when you answered, and when you answered. */
export interface CampPin {
  /** The mob name as the LOG prints it — the death line's spelling, never the wiki's. */
  mob: string
  /** The zone, as the log states it, with instance markers already stripped by the caller. */
  zone: string
  /** North/south, west/east, elevation — the `/loc` you typed. */
  ns: number
  ew: number
  z: number
  /** When the `/loc` was printed (log clock, ms). A camp can be months old and should say so. */
  ts: number
}

/** Every camp this character has pinned, keyed by `campKey`. */
export interface CampPins {
  pins: Record<string, CampPin>
}

/**
 * The separator, SPELLED OUT. A NUL cannot appear in a mob or zone name, so it is a collision-proof
 * joiner — but written as a RAW BYTE it makes git classify this file as binary and diffs, blame and
 * grep all go dark. AGENTS.md records that being done twice before (JOS-133, JOS-150); this was the
 * third, caught by `file` reporting `data` instead of source. Same runtime value either way.
 */
const KEY_SEP = '\u0000' as const

export function campKey(mob: string, zone: string): string {
  return `${mob.trim().toLowerCase()}${KEY_SEP}${zone.trim().toLowerCase()}`
}

/** An empty set. Every reader defaults through this. */
export function emptyCampPins(): CampPins {
  return { pins: {} }
}

/** Normalize from `unknown` — a stored file is not a promise about its own shape. */
export function normalizeCampPins(value: unknown): CampPins {
  const v = asObject(value)
  const src = asObject(v.pins)
  const pins: Record<string, CampPin> = {}
  for (const [key, raw] of Object.entries(src)) {
    const pin = normalizePin(raw)
    if (pin) pins[key] = pin
  }
  return { pins }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** One pin, or null when the row cannot be believed. A partial pin is worse than none: it would
 *  draw a marker somewhere arbitrary. */
function normalizePin(value: unknown): CampPin | null {
  const v = asObject(value)
  const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
  const mob = typeof v.mob === 'string' ? v.mob : ''
  const zone = typeof v.zone === 'string' ? v.zone : ''
  const ns = num(v.ns)
  const ew = num(v.ew)
  const z = num(v.z)
  const ts = num(v.ts)
  if (mob === '' || zone === '' || ns === null || ew === null || z === null || ts === null) return null
  return { mob, zone, ns, ew, z, ts }
}

/** Record a camp, replacing whatever that mob's camp in that zone was. Pure. */
export function setCampPin(pins: CampPins, pin: CampPin): CampPins {
  return { pins: { ...pins.pins, [campKey(pin.mob, pin.zone)]: pin } }
}

/** Forget one camp. Pure, and a no-op when there was none. */
export function clearCampPin(pins: CampPins, mob: string, zone: string): CampPins {
  const key = campKey(mob, zone)
  const out: Record<string, CampPin> = {}
  for (const [k, v] of Object.entries(pins.pins)) if (k !== key) out[k] = v
  return { pins: out }
}

/** The camps in one zone, newest answer first. */
export function campsInZone(pins: CampPins, zone: string): CampPin[] {
  const want = zone.trim().toLowerCase()
  return Object.values(pins.pins)
    .filter((p) => p.zone.trim().toLowerCase() === want)
    .sort((a, b) => b.ts - a.ts)
}

// ---------------------------------------------------------------------------
// THE PROMPT
// ---------------------------------------------------------------------------

/**
 * SHOW: how long the question stands, and how long a `/loc` can still answer it.
 *
 * MEASURED AND RAISED FROM 60 s. The window counts from the DEATH, so a card that appeared late
 * had already spent part of its life; at 60 s a player mid-chain-pull could not realistically
 * finish the fight and answer. 90 s is long enough to loot a named and its adds, and still short
 * enough that a stale question cannot collect a `/loc` typed minutes later for something else.
 */
export const CAMP_SHOW_MS = 90_000
/** QUIET: after an ignored prompt, that mob asks nothing again for this long. */
export const CAMP_QUIET_MS = 300_000

/** The prompt the app is showing, if any — the whole of what a surface needs to draw one. */
export interface CampPrompt {
  mob: string
  zone: string
  /** When the mob died. The card counts down from here + CAMP_SHOW_MS. */
  killedTs: number
}

/** What the module holds between events. Not persisted: a prompt does not survive a restart. */
export interface CampArm {
  mob: string
  zone: string
  killedTs: number
}

/**
 * Is the question live at `now` — both "would a `/loc` answer it" and "should a card be drawn"?
 *
 * ONE PREDICATE, BECAUSE THE GRACE PERIOD IS GONE. It was borrowed from petNudge, where the app
 * waits ten seconds so that a player who answers immediately never sees the question. MEASURED on
 * a real session, that reasoning does not survive contact with a chain pull: a named died, the
 * card was still ten seconds from appearing, the player killed the NEXT named, and the first
 * card finally arrived 28 seconds after its own kill - in the middle of a different fight. The
 * grace was protecting against a redundant flash and paying for it with the card's usefulness.
 *
 * So the question is asked the instant the mob dies. A player who was going to type `/loc` anyway
 * still sees only one card: the ask is replaced in place by its own receipt (the toast channel
 * dedupes on id), which is what the redundant-flash worry was really about.
 */
export function armIsLive(arm: CampArm | null, now: number): boolean {
  if (arm === null) return false
  const age = now - arm.killedTs
  return age >= 0 && age < CAMP_SHOW_MS
}

/** What a surface is told. `prompt` is absent in every state but the one. */
export interface CampSnap {
  /** Every camp this character has pinned. */
  pins: CampPins
  /** The prompt to draw right now, if the grace has passed and the show window has not closed. */
  prompt?: { mob: string; zone: string; killedTs: number }
  /** The zone the fold stands in, so a surface can show this zone's camps without a second source. */
  zone: string | null
}

/**
 * A delta IS a snapshot here: the state is small and always complete, so there is nothing to
 * append and no way for a renderer to hold a partial view.
 */
export type CampDelta = CampSnap
