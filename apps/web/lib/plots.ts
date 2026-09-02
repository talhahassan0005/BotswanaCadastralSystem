/**
 * Shared utilities for anything that draws MULTIPLE numbered plots on one
 * sheet (General Plan, Working Plan) — kept here so both modules operate on
 * the exact same logic instead of two independently-drifting copies.
 */
import RBush from "rbush";

export interface PlotPoint {
  name: string | null;
  east: number;
  north: number;
}

export interface Plot {
  number: string;
  points: PlotPoint[];
}

/** "37455-37458" for a contiguous numeric run of lot numbers, "100-110, 113"
 *  when there's a gap in the middle — each contiguous stretch collapses to
 *  its own "X-Y" (or bare "X" for a run of one), joined by ", " (client req
 *  2026-09-03, screenshot: a gap at 111/112 was making the WHOLE range fall
 *  back to listing every single number individually, "100, 101, 102, ...,
 *  110, 113" — this now only expands the stretch that actually has the gap
 *  in it, not the whole set). Non-numeric lot numbers still fall back to a
 *  plain comma join, same as before (client req 2026-08-26, Part 33b;
 *  promoted out of WorkingPlan.tsx 2026-08-30 so the General Plan module's
 *  own title block — "LOTS {range} {name}", matching the GC-122 reference —
 *  can reuse it instead of forking a second copy). */
export function formatLotRange(numbers: string[]): string {
  const trimmed = numbers.map((n) => n.trim()).filter(Boolean);
  const allNumeric = trimmed.length > 0 && trimmed.every((n) => /^\d+$/.test(n));
  if (!allNumeric) return trimmed.join(", ");
  const sorted = [...new Set(trimmed.map(Number))].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0], prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const v = sorted[i];
    if (v === prev + 1) { prev = v; continue; }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    if (i < sorted.length) { start = v; prev = v; }
  }
  return parts.join(", ");
}

/** Points that appear in more than one plot (same name = a shared boundary
 *  beacon between adjoining subdivisions) are kept once — first plot to use
 *  the name wins (client req 2026-08-26, Part 33a; promoted out of
 *  WorkingPlan.tsx 2026-08-27 so the General Plan module can reuse it
 *  verbatim rather than forking a second copy). */
export function dedupePoints(plots: Plot[]): PlotPoint[] {
  const named = new Map<string, PlotPoint>();
  const anon: PlotPoint[] = [];
  for (const plot of plots) {
    for (const p of plot.points) {
      if (p.name) {
        if (!named.has(p.name)) named.set(p.name, p);
      } else {
        anon.push(p);
      }
    }
  }
  return [...named.values(), ...anon];
}

/** Rotate a single (east, north) point around a pivot by `angleDeg`, matching
 *  CogoWorkspace.tsx's on-screen rotation sense (positive = clockwise as
 *  drawn) even though this operates on WORLD coordinates, not screen ones.
 *  North is the "flipped" axis relative to screen-y (north-up display maps
 *  increasing north to a SMALLER screen y), so a straight screen-space
 *  rotation matrix applied directly to (east, north) would spin the
 *  opposite way from what the same slider value produces in CogoWorkspace —
 *  this compensates so every module's rotation looks the same for the same
 *  `config.displayRotation` value (client req 2026-08-28: rotation must be
 *  consistent everywhere, not just the COGO canvas). Pure display maths —
 *  callers use this to build a ROTATED COPY of points to feed through their
 *  existing fit-to-bounds/screen transform unchanged; it never writes back
 *  to the actual stored beacon coordinates. */
export function rotateWorldPoint(
  e: number,
  n: number,
  angleDeg: number,
  pivotE: number,
  pivotN: number
): { east: number; north: number } {
  if (!angleDeg) return { east: e, north: n };
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const de = e - pivotE, dn = n - pivotN;
  return { east: pivotE + de * cos + dn * sin, north: pivotN - de * sin + dn * cos };
}

/** Rotates every point in `points` around their shared centroid — the
 *  natural pivot for "spin this drawing in place" (client req 2026-08-28),
 *  same idea as rotating a photo around its own centre in an image editor.
 *  Returns the input unchanged (same references) when angleDeg is falsy, so
 *  callers can unconditionally pipe every point list through this without a
 *  separate "is rotation active" branch. */
export function rotateAroundCentroid<T extends { east: number; north: number }>(points: T[], angleDeg: number): T[] {
  if (!angleDeg || !points.length) return points;
  const cE = points.reduce((a, p) => a + p.east, 0) / points.length;
  const cN = points.reduce((a, p) => a + p.north, 0) / points.length;
  return points.map((p) => ({ ...p, ...rotateWorldPoint(p.east, p.north, angleDeg, cE, cN) }));
}

/** Metres — matches computeDiagramLayout's own point-identity tolerance
 *  (diagramLayout.ts's `isSamePoint`/`DUP_TOL`) and Diagrams.tsx's Part 37
 *  auto-adjacency detection. Kept here too (not just those two places) so
 *  every "is this the same survey point" check across the app agrees. */
export const ADJACENCY_TOL = 0.01;

export function sameWorldPoint(
  a: { east: number; north: number },
  b: { east: number; north: number },
  tol = ADJACENCY_TOL
): boolean {
  return Math.abs(a.east - b.east) < tol && Math.abs(a.north - b.north) < tol;
}

/** Drops a redundant closing vertex equal to the first point (client req
 *  2026-09-02: a "0.00 / 00.00.00" distance+bearing label was still showing
 *  at lot corners after buildFigureFromPoints (CogoWorkspace.tsx) was fixed
 *  to strip this at SAVE time — that only prevents the bug in NEWLY saved
 *  plots; any plot saved before that fix still carries the duplicate point
 *  in its stored fig.points, since a code fix doesn't retroactively clean
 *  already-saved data). Every consumer that treats a plot's point list as
 *  an implicitly-closed ring via `pts[(i+1) % pts.length]` — General Plan's
 *  edge-dimension labels chief among them — needs this applied at READ
 *  time too, not just at the one place data gets saved. */
export function dropClosingDuplicate<T extends PlotPoint>(points: T[]): T[] {
  return points.length >= 2 && sameWorldPoint(points[0], points[points.length - 1]) ? points.slice(0, -1) : points;
}

export interface DetectedLot {
  points: PlotPoint[];
}

/** Reconstructs individual rectangular lot boundaries from a flat, ungrouped
 *  point cloud (client req 2026-08-28) — real survey exports often list every
 *  beacon of a whole grid subdivision as one flat "name,east,north" file with
 *  no lot-grouping column at all. For a rectilinear grid layout (every lot an
 *  axis-aligned rectangle, adjoining lots sharing corner beacons) that alone
 *  is enough to reconstruct each lot on its own: a point's nearest same-row
 *  neighbour to the east and nearest same-column neighbour to the north
 *  define two edges of "its" lot; the fourth corner only closes the rectangle
 *  if it is ALSO the nearest neighbour of those two points back toward this
 *  one — that check rejects a coincidentally-matching but non-elementary
 *  rectangle (e.g. one that actually spans an un-subdivided gap because a
 *  beacon in between is missing). Points that never anchor a rectangle this
 *  way (outer parent-boundary beacons, block corners, splayed/chamfered
 *  corner lots) are simply left out — `usedPointCount` tells the caller how
 *  many of `points` were consumed, so the rest can be reported as needing
 *  manual placement with the Polygon tool.
 *
 * Neighbour/corner lookups run through an RBush spatial index (client req
 * 2026-08-31: "optimize karo", "library use karo scratch se na") instead of
 * scanning every point for every query — a real subdivision file this is
 * built for (hundreds to low thousands of beacons) turns an O(n²) scan into
 * O(n log n), which matters once files grow past what a single client's
 * test data has exercised so far.
 *
 * A single real subdivision file is rarely ONE consistent grid, though —
 * different blocks follow different road alignments, not true north, so
 * they sit at slightly different rotations from each other (client req
 * 2026-08-31, confirmed against the real Charleshill file: one block is
 * exactly axis-aligned, an adjoining one sits at a consistent -2.6°, and a
 * pure axis-aligned pass silently drops every point in the tilted block to
 * "leftover"). This runs the axis-aligned pass above repeatedly: pass 1 at
 * 0° (identical to, and a strict superset of, the plain axis-aligned
 * behaviour — critical so nothing already working regresses), then for
 * whatever's left un-detected, estimates that remainder's own dominant tilt
 * from real nearest-neighbour pairs, de-rotates just that remainder around
 * its own centroid (via the existing `rotateAroundCentroid`, same
 * convention used everywhere else rotation happens in this app), reruns the
 * same detector on it, and maps any newly-found lots' points back to their
 * REAL (never-rotated) coordinates before returning — rotation here is
 * purely an internal detection aid, exactly as `rotateWorldPoint`'s own doc
 * comment already establishes for display use. Repeats until nothing more
 * is found or a pass cap is hit, so a file with several differently-tilted
 * blocks gets each one in turn without assuming a single global angle. */
const MAX_ROTATION_PASSES = 8;
const MIN_DETECTABLE_ANGLE = 0.2; // degrees — below this, treat as already axis-aligned (float dust)
const ANGLE_NEIGHBOUR_MIN_D = 3; // metres — plausible lot-edge length range used only to estimate tilt
const ANGLE_NEIGHBOUR_MAX_D = 60;
// A road-edge/pedway strip running the length of a whole block can have 4
// corners that satisfy the elementary-rectangle check just as validly as a
// real lot does (client req 2026-09-01: verified against the real 1026-
// point file — 43 of 376 "lots" were 3m-wide, up to 183m-long slivers,
// nowhere near any real building lot's proportions, visible as thin strips
// squeezed in among the real grid and badly distorting the whole sheet's
// scale). No real lot in this kind of subdivision is this narrow or this
// elongated, so these two sanity bounds reject a candidate before it's ever
// accepted — its points stay available for whatever real rectangle (or
// manual Polygon-tool placement) they actually belong to, rather than being
// consumed by a false one.
const MIN_LOT_SIDE = 5; // metres
const MAX_LOT_ASPECT_RATIO = 6; // longest side / shortest side
// Absolute cap on a side's length, independent of aspect ratio. A moderately
// elongated (ratio <= 6) but still very long rectangle can still be a false
// road-strip match rather than a real lot — verified on real client data
// (Charleshill 1026-point file): every genuine lot's longest side is <= 38m,
// then there's a clean gap with NOTHING between ~38m and ~90m before the next
// (false-positive) cluster starts. 60m sits in that gap with margin on both
// sides. These false positives were the direct cause of a reported bug: long
// stray lines cutting straight through several unrelated rows on the General
// Plan sheet.
const MAX_LOT_SIDE = 60; // metres

/** One axis-aligned detection pass — the exact original algorithm, just
 *  generic over any point shape so a rotated (temporary) copy can carry a
 *  back-reference to its real-world original alongside it. */
function detectAxisAlignedPass<T extends PlotPoint>(pts: T[], tol: number): { lots: T[][]; used: Set<T> } {
  interface PtBox { minX: number; minY: number; maxX: number; maxY: number; p: T }
  const tree = new RBush<PtBox>();
  tree.load(pts.map((p) => ({ minX: p.east, minY: p.north, maxX: p.east, maxY: p.north, p })));

  function nearest(from: T, axis: "east" | "north", dir: 1 | -1): T | null {
    const inf = Infinity;
    const box =
      axis === "east"
        ? { minX: dir === 1 ? from.east + tol : -inf, maxX: dir === 1 ? inf : from.east - tol, minY: from.north - tol, maxY: from.north + tol }
        : { minX: from.east - tol, maxX: from.east + tol, minY: dir === 1 ? from.north + tol : -inf, maxY: dir === 1 ? inf : from.north - tol };
    let best: T | null = null;
    let bestDelta = Infinity;
    for (const c of tree.search(box)) {
      if (c.p === from) continue;
      const delta = (c.p[axis] - from[axis]) * dir;
      if (delta <= tol) continue; // wrong side, or effectively the same point
      if (delta < bestDelta) { bestDelta = delta; best = c.p; }
    }
    return best;
  }

  const lots: T[][] = [];
  const used = new Set<T>();

  for (const p of pts) {
    const right = nearest(p, "east", 1);
    const up = nearest(p, "north", 1);
    if (!right || !up) continue;
    const cornerBox = { minX: right.east - tol, minY: up.north - tol, maxX: right.east + tol, maxY: up.north + tol };
    const corner = tree.search(cornerBox).map((c) => c.p).find((q) => q !== p && q !== right && q !== up);
    if (!corner) continue;
    // Elementary-face check: walking back from the corner must land on
    // exactly these same two edge points, not skip past a missing beacon.
    if (nearest(corner, "east", -1) !== up || nearest(corner, "north", -1) !== right) continue;

    // Sliver/road-strip rejection — see MIN_LOT_SIDE/MAX_LOT_ASPECT_RATIO's
    // own comment above.
    const sideEast = Math.abs(right.east - p.east);
    const sideNorth = Math.abs(up.north - p.north);
    const shortSide = Math.min(sideEast, sideNorth);
    const longSide = Math.max(sideEast, sideNorth);
    if (shortSide < MIN_LOT_SIDE || longSide > MAX_LOT_SIDE || longSide / shortSide > MAX_LOT_ASPECT_RATIO) continue;

    lots.push([p, right, corner, up]);
    used.add(p); used.add(right); used.add(corner); used.add(up);
  }

  return { lots, used };
}

/** Estimates a point set's own dominant tilt from real nearest-neighbour
 *  pairs (distance-bounded to plausible lot-edge lengths, so an outer-
 *  boundary point's far-away nearest neighbour doesn't skew it) — folded
 *  into (-45°, 45°] so a "row" pair and the perpendicular "column" pair
 *  vote for the SAME angle, then the median taken (robust against the
 *  minority of leftover points that aren't part of any grid at all, e.g.
 *  splayed corners or block corners). Returns null when there's too little
 *  data to trust, or the set already reads as axis-aligned. */
function estimateDominantAngle(points: PlotPoint[]): number | null {
  if (points.length < 4) return null;
  interface PtBox { minX: number; minY: number; maxX: number; maxY: number; p: PlotPoint }
  const tree = new RBush<PtBox>();
  tree.load(points.map((p) => ({ minX: p.east, minY: p.north, maxX: p.east, maxY: p.north, p })));

  const angles: number[] = [];
  for (const p of points) {
    const box = {
      minX: p.east - ANGLE_NEIGHBOUR_MAX_D, minY: p.north - ANGLE_NEIGHBOUR_MAX_D,
      maxX: p.east + ANGLE_NEIGHBOUR_MAX_D, maxY: p.north + ANGLE_NEIGHBOUR_MAX_D,
    };
    let best: PlotPoint | null = null;
    let bestD = Infinity;
    for (const c of tree.search(box)) {
      if (c.p === p) continue;
      const d = Math.hypot(c.p.east - p.east, c.p.north - p.north);
      if (d < ANGLE_NEIGHBOUR_MIN_D || d > ANGLE_NEIGHBOUR_MAX_D) continue;
      if (d < bestD) { bestD = d; best = c.p; }
    }
    if (!best) continue;
    let deg = (Math.atan2(best.north - p.north, best.east - p.east) * 180) / Math.PI;
    deg = ((deg % 90) + 90) % 90; // fold row/column pairs onto the same representative angle
    if (deg > 45) deg -= 90; // smallest-magnitude deviation from either axis
    angles.push(deg);
  }
  if (angles.length < 4) return null;
  angles.sort((a, b) => a - b);
  const median = angles[Math.floor(angles.length / 2)];
  return Math.abs(median) < MIN_DETECTABLE_ANGLE ? null : median;
}

export function detectRectangularLots(points: PlotPoint[], tol = 0.05): { lots: DetectedLot[]; usedPointCount: number } {
  interface Working extends PlotPoint { __orig: PlotPoint }
  let remaining: Working[] = points
    .filter((p) => Number.isFinite(p.east) && Number.isFinite(p.north))
    .map((p) => ({ ...p, __orig: p }));

  const lots: DetectedLot[] = [];
  const usedOriginal = new Set<PlotPoint>();

  // Pass 1 is always angle 0 — identical to, and a strict superset of, the
  // plain axis-aligned detector (nothing already working can regress).
  let angle = 0;
  for (let pass = 0; pass < MAX_ROTATION_PASSES && remaining.length >= 4; pass++) {
    // rotateAroundCentroid returns the input UNCHANGED (same references)
    // when angleDeg is falsy — so pass 1 (angle 0) runs detection on the
    // exact same Working objects as `remaining`, byte-for-byte the old
    // behaviour, not a rotated copy of it.
    const rotated = rotateAroundCentroid(remaining, angle);
    const { lots: foundGroups } = detectAxisAlignedPass(rotated, tol);

    if (foundGroups.length === 0) {
      // Nothing at this angle — try the remainder's own dominant tilt
      // instead of giving up after only ever trying 0°.
      const nextAngle = estimateDominantAngle(remaining);
      if (nextAngle == null || Math.abs(nextAngle - angle) < MIN_DETECTABLE_ANGLE) break;
      angle = nextAngle;
      continue;
    }

    // foundGroups' points are the ROTATED copies detectAxisAlignedPass
    // actually saw (fresh objects whenever angle is non-zero —
    // rotateAroundCentroid never mutates `remaining` in place), so they
    // can't be matched against `remaining`'s own Working objects by
    // reference. `__orig` is the one identity that survives rotation (a
    // plain spread, so it's copied through unchanged) — filter by THAT.
    const usedOrigThisPass = new Set<PlotPoint>();
    for (const group of foundGroups) {
      lots.push({ points: group.map((wp) => wp.__orig) });
      for (const wp of group) { usedOriginal.add(wp.__orig); usedOrigThisPass.add(wp.__orig); }
    }
    remaining = remaining.filter((wp) => !usedOrigThisPass.has(wp.__orig));
    angle = estimateDominantAngle(remaining) ?? 0;
  }

  return { lots, usedPointCount: usedOriginal.size };
}

/** Traces the single outer ring of the union of `plots` — every plot edge
 *  with no matching edge on any other plot (see `sameWorldPoint`) is an
 *  "outer" edge of the whole layout; walking those in sequence traces its
 *  boundary, same idea as the General Plan's auto REMAINDER OF CADASTRE
 *  labels (which flag the same unmatched edges individually) but chained
 *  into one ring for the bottom traverse table (client req 2026-08-27, §2h).
 *  Assumes the common case — a simple, hole-free block of adjoining lots,
 *  where every outer vertex touches exactly two outer edges — and returns
 *  [] rather than guessing at a malformed ring for anything irregular. */
export function findOuterBoundary(plots: Plot[]): PlotPoint[] {
  const nodes: PlotPoint[] = [];
  function nodeIndex(p: PlotPoint): number {
    const i = nodes.findIndex((n) => sameWorldPoint(n, p));
    if (i !== -1) {
      if (!nodes[i].name && p.name) nodes[i] = { ...nodes[i], name: p.name };
      return i;
    }
    nodes.push({ east: p.east, north: p.north, name: p.name });
    return nodes.length - 1;
  }

  const edges: [number, number][] = [];
  for (let pi = 0; pi < plots.length; pi++) {
    const pts = plots[pi].points;
    if (pts.length < 3) continue;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const matched = plots.some((other, oi) => {
        if (oi === pi) return false;
        return other.points.some((oa, j) => {
          const ob = other.points[(j + 1) % other.points.length];
          return (sameWorldPoint(a, oa) && sameWorldPoint(b, ob)) || (sameWorldPoint(a, ob) && sameWorldPoint(b, oa));
        });
      });
      if (!matched) edges.push([nodeIndex(a), nodeIndex(b)]);
    }
  }
  if (edges.length < 3) return [];

  const adj = new Map<number, number[]>();
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }
  for (const ns of adj.values()) {
    if (ns.length !== 2) return []; // not a single simple ring
  }

  const startIdx = edges[0][0];
  const ring = [startIdx];
  let prev = -1, cur = startIdx;
  for (let steps = 0; steps < edges.length + 1; steps++) {
    const [n1, n2] = adj.get(cur)!;
    const next = n1 === prev ? n2 : n1;
    if (next === startIdx) break;
    ring.push(next);
    prev = cur;
    cur = next;
  }
  if (ring.length !== adj.size) return []; // didn't close into one connected ring

  return ring.map((i) => nodes[i]);
}
