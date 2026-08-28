/**
 * Shared utilities for anything that draws MULTIPLE numbered plots on one
 * sheet (General Plan, Working Plan) — kept here so both modules operate on
 * the exact same logic instead of two independently-drifting copies.
 */

export interface PlotPoint {
  name: string | null;
  east: number;
  north: number;
}

export interface Plot {
  number: string;
  points: PlotPoint[];
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

export interface BlockCorner {
  id: string;
  east: number;
  north: number;
  /** How many distinct plots' boundaries touch this point. */
  plotCount: number;
}

/** A "block corner" — where the road/block grid turns — has no dedicated
 *  entity anywhere in the app's data model (there's no Road/Block concept at
 *  all). The only geometric signal available is: a point where 3+ DISTINCT
 *  plots' boundaries all have a vertex is where multiple blocks/road edges
 *  converge; an ordinary shared edge between just two adjoining lots is not
 *  (client req 2026-08-27, spec Part 2g/4). */
export function findBlockCorners(plots: Plot[]): BlockCorner[] {
  const groups: { east: number; north: number; plotNumbers: Set<string> }[] = [];
  for (const plot of plots) {
    for (const p of plot.points) {
      let g = groups.find((g) => sameWorldPoint(g, p));
      if (!g) {
        g = { east: p.east, north: p.north, plotNumbers: new Set() };
        groups.push(g);
      }
      g.plotNumbers.add(plot.number);
    }
  }
  return groups
    .filter((g) => g.plotNumbers.size >= 3)
    .map((g, i) => ({ id: `BC${i + 1}`, east: g.east, north: g.north, plotCount: g.plotNumbers.size }));
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
