import type { LogEventBase } from './logEvents'

// Map-viewer data model (docs/plans/map-viewer.md §3).
//
// TYPES ONLY — no runtime dependency on Electron or Node, because both halves of the feature
// import from here: the main-side parser (src/main/maps/parseMap.ts) that reads <eqRoot>\maps,
// and the renderer that draws the result. Nothing in this file executes.
//
// The two shapes below carry the whole performance argument for the feature, so they are
// spelled out rather than left to a later refactor:
//
//   * Geometry is COLUMNAR and COLOUR-BUCKETED. Measured max is 26,383 line segments in one
//     zone (everfrost.txt; p95 = 12,738 across 701 base files). 26k plain objects are slow to
//     structured-clone across IPC and slow to walk per frame; a Float32Array is neither.
//     Bucketing by colour lets the canvas issue one Path2D per palette entry (measured max
//     19 distinct colours in a real file) instead of 26k individual strokes.
//   * Points are PLAIN OBJECTS. Measured max is 316 per zone, and they need hit-testing,
//     tooltips and search — DOM-shaped work, at a scale where object cost is irrelevant.

/** A zone's short name — the map-file stem, lowercased. 'airplane', 'befallen'. */
export type ZoneShort = string

/** Which layer a record came from. 0 = base file, 1..3 = the _N files. */
export type MapLayer = 0 | 1 | 2 | 3

/**
 * Line geometry in COLUMNAR, COLOUR-BUCKETED form.
 *
 * Columnar because a zone is up to 26,383 segments (measured, everfrost.txt) and an array of
 * 26k objects is both slow to structured-clone across IPC and slow to iterate per frame.
 * Colour-bucketed because the canvas renderer wants ONE Path2D per colour (≈10-20 strokes per
 * zone) instead of 26k individual strokes — and main can compute the buckets for free while it
 * is already walking the file.
 */
export interface MapLines {
  /** [x1,y1,z1,x2,y2,z2] × count, flattened. */
  coords: Float32Array
  /** Distinct colours, packed [r,g,b] × paletteSize. */
  palette: Uint8Array
  /** Palette index per segment; length === count. */
  colorIndex: Uint8Array
  /** Layer per segment; length === count. Lets the renderer toggle without re-fetching. */
  layer: Uint8Array
  count: number
}

/** One labelled point of interest. Small in every zone (measured max 316), so plain objects. */
export interface MapPoint {
  x: number
  y: number
  z: number
  /** 0-255 each. */
  r: number
  g: number
  b: number
  /** Text size class 1..3 (small / medium / large). NOT a radius. */
  size: 1 | 2 | 3
  /** RAW label, underscores intact, exactly as the file spells it (law 2 — display raw). */
  label: string
  /** `label.replace(/_/g,' ')` — what the user reads and what search matches against. */
  display: string
  layer: MapLayer
}

/** Axis-aligned extent in MAP coordinates. Computed EXCLUDING layer 2 (see §2.3). */
export interface MapBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
}

/** Where one layer's records actually came from. Layers may be sourced from DIFFERENT packs. */
export interface MapSource {
  layer: MapLayer
  packId: string
  file: string
}

/** The pack's recommended z-slice band, mined from a layer-2 `Height_Filter:_N/M` label. */
export interface MapHeightHint {
  low: number
  high: number
}

/** Everything the viewer needs for one zone, from one pack selection. */
export interface MapData {
  zone: ZoneShort
  /** Which pack each layer actually came from — layers may be sourced from DIFFERENT packs. */
  sources: MapSource[]
  lines: MapLines
  points: MapPoint[]
  /** Bounds over layers 0/1/3 only. Never includes the legend layer. */
  bounds: MapBounds
  /** Distinct z values seen in geometry, ascending — the floor picker's input (§8). */
  zLevels: number[]
  /** `Height_Filter:_N/M` mined from layer 2 when present (51/577 Brewall files have one). */
  heightHint?: MapHeightHint
  /** Attribution mined from layer 2's credit points. Surfaced in the UI (§9). */
  credits: string[]
  /** Lines that failed to parse. Non-zero ⇒ a diagnosable bad pack, never a thrown error. */
  skipped: number
}

// ---- pack model (§3.1) ----------------------------------------------------------------
//
// Declared here rather than in the main-side pack module because `MapData.sources` already
// names a `packId`, and the renderer needs the pack rows to render the per-layer source
// chips. Nothing below is used by the parser; it is the vocabulary the resolution layer and
// the IPC surface share.

/** An installed map pack — a directory of <zone>[_N].txt files. */
export interface MapPack {
  /** Stable id: 'default' for <eqRoot>\maps itself, else the lowercased subdir name. */
  id: string
  /** Display name — the subdir's real casing, or 'Game default maps'. */
  name: string
  /** Absolute directory. Main-side only; never sent to the renderer. */
  dir: string
  /** Where it came from. 'game' = shipped/inside the EQ dir; 'user' = installed by us. */
  origin: 'game' | 'user'
  /** Distinct zone stems this pack provides. */
  zoneCount: number
  /** Total .txt files. */
  fileCount: number
}

/** The renderer-visible pack row (no absolute path). */
export type MapPackInfo = Omit<MapPack, 'dir'>

/** Per-layer pack preference. Missing key ⇒ fall back to the resolution order. */
export interface MapPackPrefs {
  /** Pack for base geometry. */
  geometry?: string
  /** Pack for labels/POIs — usually a DIFFERENT pack (§1a). */
  labels?: string
}

// ---- IPC payloads (§4.2) --------------------------------------------------------------
//
// The four `maps:*` channels' result shapes. Here rather than in `shared/ipc.ts` (which is
// channel NAMES only, by construction) so main, preload and the renderer all read one
// definition. Every one of them is a RESULT, never a throw: an error crossing IPC loses its
// type and its message, so failures come back as data — the established shape in this app.

/** Reply of `maps:listPacks`. An absent EQ dir is an empty list + prose, not a rejection. */
export interface MapPackListResult {
  packs: MapPackInfo[]
  /** Absent EQ dir / absent maps dir — the UI shows a quiet empty state, not an error. */
  error?: string
}

/** Reply of `maps:get`. `ok:false` covers "no map files for that zone", the common case. */
export type MapGetResult = { ok: true; data: MapData } | { ok: false; error: string }

/** Argument of `maps:search`. Omitting `zone` searches the whole corpus (§7.2). */
export interface MapSearchOpts {
  /** Restrict to one zone. Omit for a corpus-wide search. */
  zone?: ZoneShort
  /** Hit cap; clamped at the handler so a renderer bug can't ask for an unbounded payload. */
  limit?: number
  /**
   * The viewer's per-layer pack preference, for an IN-ZONE search only.
   *
   * In-zone search ranks over the FULL parsed zone — the very `MapData` the pane is drawing —
   * so it must resolve that zone under the SAME prefs `maps:get` did. Without this the hit list
   * would rank over a different pack's labels than the ones on screen the moment a user
   * overrides a pack. The CORPUS index is built once under default prefs (one index, not one
   * per preference) and ignores this field.
   */
  prefs?: MapPackPrefs
}

/** One scored label hit. Carries the point itself, so the caller can pan straight to it. */
export interface MapSearchHit {
  zone: ZoneShort
  point: MapPoint
  score: number
}

/**
 * `Your Location is 1918.98, 144.79, 30.07` — the answer to a typed `/loc`.
 *
 * THIS LINE WAS BELIEVED NOT TO EXIST, and the belief is worth recording because it shaped a whole
 * feature. `renderer/features/maps/locMarker.ts` states, as a measurement: *"`Your Location`
 * appears ZERO times in it, re-measured across the owner's whole 116.8 MB
 * `eqlog_Primitive_freeport.txt`... because /loc answers in the game window and is never written
 * to the file the app tails"*, and the map marker was therefore built as a PASTE box. The
 * measurement was true; the causal claim drawn from it was not. The owner had simply never typed
 * `/loc`, so the game never had occasion to log one.
 *
 * MEASURED 2026-08-19 on a reporter's live EQ Legends log: ZERO occurrences across a 253 MB
 * archive of ordinary play, then TWO sixteen seconds apart the moment the player typed the
 * command. The shape matches the one locMarker.ts had already reverse-engineered from 24 wiki
 * walkthrough pages, character for character — a parser written correctly for a line its author
 * believed could never arrive.
 *
 * IT IS THE ONLY POSITIONAL LINE IN THE LOG, and it exists only when ASKED FOR. There is no
 * tracking here and none may be implied: the app knows where you were at the instants you typed
 * `/loc`, and nothing about the time in between.
 */
export interface LocEvent extends LogEventBase {
  kind: 'loc'
  /** North/south, the first number the game prints. */
  ns: number
  /** West/east, the second. */
  ew: number
  /** Elevation, the third. */
  z: number
}

/**
 * ONE `/loc` reading: where the player said they were, and WHEN they said it.
 *
 * The timestamp is not decoration. `/loc` answers only when typed, so a reading is a fact about an
 * INSTANT and says nothing about the time on either side of it; a surface drawing one is expected
 * to say how old it is. See `src/main/modules/loc.ts` for why this is a trail rather than a
 * position.
 */
export interface LocReading {
  /** When the game printed it (log clock, ms). */
  ts: number
  /** North/south, the first number `/loc` prints. */
  ns: number
  /** West/east, the second. */
  ew: number
  /** Elevation, the third. */
  z: number
  /** The zone the fold stood in when it was printed. Absent before any zone line has been seen. */
  zone?: string
}

/**
 * The loc module's snapshot: the ONE most recent reading, or null before any `/loc` was typed.
 *
 * ONE READING, NOT A TRAIL, and that is a ruling rather than a simplification. Two `/loc`s minutes
 * apart say where you stood twice; the path between them is not in the log and must never be drawn
 * (laws 1 and 6). A straight line between two readings cuts through walls and asserts a route
 * nobody took - it is the one part of the obvious design that is actively a lie. With no line to
 * draw there is no history to keep, so there is none.
 *
 * The zone is NOT repeated here: the reading carries its own, and the character module already
 * serves the zone the fold stands in. Two sources for one fact is two things to disagree.
 */
export interface LocSnap {
  current: LocReading | null
}

/** A newer reading. Emitted only when one arrives, so the renderer simply replaces what it holds. */
export interface LocDelta {
  current: LocReading
}
