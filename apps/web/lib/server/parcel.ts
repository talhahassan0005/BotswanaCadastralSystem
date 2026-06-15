/**
 * Cadastral parcel construction & topology (Module D + parcel validation).
 * Pure TypeScript — safe to import on client or server. Builds on geometry.ts.
 *
 * A parcel is an ordered ring of beacon ids (CCW or CW; orientation is
 * normalised internally). Coordinates are easting/northing in survey metres;
 * bearings are clockwise from grid north in degrees.
 */

import { formatDms, round } from "./angles";
import { inverse, polygonArea, type Point } from "./geometry";
import type { Beacon, Parcel, ParcelMetrics, ParcelSide } from "../types";

export interface Check {
  rule: string;
  severity: "pass" | "warning" | "error";
  message: string;
}

const COORD_TOL = 0.005; // 5 mm — beacons closer than this are "the same point"

export function beaconMap(beacons: Beacon[]): Map<string, Beacon> {
  const m = new Map<string, Beacon>();
  for (const b of beacons) m.set(b.id, b);
  return m;
}

/** Resolve a ring of beacon ids to points; skips ids with no beacon. */
export function ringPoints(beaconIds: string[], by: Map<string, Beacon>): Point[] {
  const pts: Point[] = [];
  for (const id of beaconIds) {
    const b = by.get(id);
    if (b) pts.push({ east: b.east, north: b.north, name: id });
  }
  return pts;
}

/** Area (m²/ha), perimeter, and per-side bearing/distance for a parcel ring. */
export function parcelMetrics(beaconIds: string[], by: Map<string, Beacon>): ParcelMetrics {
  const pts = ringPoints(beaconIds, by);
  const closed = pts.length >= 3;
  const sides: ParcelSide[] = [];
  if (pts.length >= 2) {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      // For an open chain skip the closing leg; for a ring include it.
      if (i === pts.length - 1 && pts.length < 3) break;
      const [bearing, distance] = inverse(a, b);
      sides.push({
        from: a.name ?? "?",
        to: b.name ?? "?",
        bearing: round(bearing, 4),
        bearing_dms: formatDms(bearing),
        distance: round(distance, 3),
      });
    }
  }
  const area = closed ? Math.abs(polygonArea(pts)) : 0;
  const perim = sides.reduce((s, x) => s + x.distance, 0);
  return {
    area_m2: round(area, 3),
    area_ha: round(area / 10_000, 4),
    perimeter: round(perim, 3),
    sides,
    closed,
  };
}

// ---------------------------------------------------------------------------
// Geometry primitives for topology
// ---------------------------------------------------------------------------
function orient(a: Point, b: Point, c: Point): number {
  // >0 counter-clockwise, <0 clockwise, 0 collinear
  return (b.east - a.east) * (c.north - a.north) - (b.north - a.north) * (c.east - a.east);
}

/** Signed area sign: +1 CCW, -1 CW. */
export function ringIsCCW(pts: Point[]): boolean {
  return polygonArea(pts) > 0;
}

/** Strict (interior) crossing of segments ab and cd — shared endpoints/touching do NOT count. */
function segmentsProperlyCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = orient(c, d, a);
  const d2 = orient(c, d, b);
  const d3 = orient(a, b, c);
  const d4 = orient(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Point strictly inside polygon (on-boundary returns false). Ray casting. */
export function strictlyInside(p: Point, ring: Point[]): boolean {
  const n = ring.length;
  if (n < 3) return false;
  // reject on-boundary
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    if (Math.abs(orient(a, b, p)) < 1e-9) {
      const within =
        p.east >= Math.min(a.east, b.east) - 1e-9 &&
        p.east <= Math.max(a.east, b.east) + 1e-9 &&
        p.north >= Math.min(a.north, b.north) - 1e-9 &&
        p.north <= Math.max(a.north, b.north) + 1e-9;
      if (within) return false; // on an edge
    }
  }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = ring[i].north,
      yj = ring[j].north,
      xi = ring[i].east,
      xj = ring[j].east;
    const intersect = yi > p.north !== yj > p.north && p.east < ((xj - xi) * (p.north - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Do two parcel rings overlap in their interiors (touching/adjacent does NOT count)? */
export function ringsOverlap(ringA: Point[], ringB: Point[]): boolean {
  if (ringA.length < 3 || ringB.length < 3) return false;
  // 1. any pair of edges properly crosses
  for (let i = 0; i < ringA.length; i++) {
    const a1 = ringA[i];
    const a2 = ringA[(i + 1) % ringA.length];
    for (let j = 0; j < ringB.length; j++) {
      const b1 = ringB[j];
      const b2 = ringB[(j + 1) % ringB.length];
      if (segmentsProperlyCross(a1, a2, b1, b2)) return true;
    }
  }
  // 2. a vertex of one strictly inside the other (containment / nesting)
  if (ringA.some((p) => strictlyInside(p, ringB))) return true;
  if (ringB.some((p) => strictlyInside(p, ringA))) return true;
  // 3. centroid containment (catches one fully inside with no vertex test hit)
  const cA = centroid(ringA);
  const cB = centroid(ringB);
  if (strictlyInside(cA, ringB) || strictlyInside(cB, ringA)) return true;
  return false;
}

/** Does a single ring cross itself (non-adjacent edges properly intersect)? */
export function isSelfIntersecting(ring: Point[]): boolean {
  const n = ring.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a1 = ring[i];
    const a2 = ring[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // skip edges that share a vertex (adjacent, including the wrap-around pair)
      if ((j + 1) % n === i || (i + 1) % n === j) continue;
      const b1 = ring[j];
      const b2 = ring[(j + 1) % n];
      if (segmentsProperlyCross(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

export function centroid(pts: Point[]): Point {
  let e = 0,
    n = 0;
  for (const p of pts) {
    e += p.east;
    n += p.north;
  }
  return { east: e / pts.length, north: n / pts.length };
}

// ---------------------------------------------------------------------------
// Subdivision — split a parcel ring along a chord between two of its beacons.
// ---------------------------------------------------------------------------
export interface SubdivisionResult {
  childA: string[]; // ordered beacon ids
  childB: string[];
}

export function subdivide(beaconIds: string[], idFrom: string, idTo: string): SubdivisionResult {
  const i = beaconIds.indexOf(idFrom);
  const j = beaconIds.indexOf(idTo);
  if (i < 0 || j < 0) throw new Error("split beacons must be on the parcel boundary");
  if (i === j) throw new Error("choose two different beacons");
  const lo = Math.min(i, j);
  const hi = Math.max(i, j);
  // child A: lo .. hi ; child B: hi .. end + start .. lo (both share the chord lo-hi)
  const childA = beaconIds.slice(lo, hi + 1);
  const childB = [...beaconIds.slice(hi), ...beaconIds.slice(0, lo + 1)];
  if (childA.length < 3 || childB.length < 3)
    throw new Error("split must leave at least 3 beacons on each side (pick non-adjacent beacons)");
  return { childA, childB };
}

// ---------------------------------------------------------------------------
// Consolidation — merge adjacent parcels by cancelling shared (internal) edges
// and tracing the remaining outer boundary. Uses beacon ids, so shared edges
// match exactly. Falls back to a convex hull if parcels are not edge-adjacent.
// ---------------------------------------------------------------------------
export interface ConsolidationResult {
  beaconIds: string[];
  method: "boundary-trace" | "convex-hull";
  warning?: string;
}

function normaliseCCW(beaconIds: string[], by: Map<string, Beacon>): string[] {
  const pts = ringPoints(beaconIds, by);
  return ringIsCCW(pts) ? beaconIds : [...beaconIds].reverse();
}

export function consolidate(parcels: Parcel[], by: Map<string, Beacon>): ConsolidationResult {
  if (parcels.length < 2) throw new Error("select at least two parcels to consolidate");

  // Build directed edges (a->b) for every ring, all oriented CCW.
  const edges = new Map<string, [string, string]>(); // key "a|b"
  for (const p of parcels) {
    const ring = normaliseCCW(p.beaconIds, by);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const fwd = `${a}|${b}`;
      const rev = `${b}|${a}`;
      if (edges.has(rev)) edges.delete(rev); // shared internal edge — cancel both
      else edges.set(fwd, [a, b]);
    }
  }

  // Trace the surviving edges into one ring.
  const next = new Map<string, string>();
  for (const [a, b] of edges.values()) next.set(a, b);

  const trace: string[] = [];
  if (next.size) {
    const start = next.keys().next().value as string;
    let cur = start;
    const guard = next.size + 1;
    for (let k = 0; k < guard; k++) {
      trace.push(cur);
      const nx = next.get(cur);
      if (nx == null) break;
      cur = nx;
      if (cur === start) break;
    }
  }

  const traceClosed = trace.length >= 3 && next.get(trace[trace.length - 1]) === trace[0];
  if (traceClosed && trace.length === next.size) {
    return { beaconIds: trace, method: "boundary-trace" };
  }

  // Fallback: convex hull of all distinct beacons (parcels weren't edge-adjacent).
  const ids = Array.from(new Set(parcels.flatMap((p) => p.beaconIds)));
  const hull = convexHull(ids, by);
  return {
    beaconIds: hull,
    method: "convex-hull",
    warning: "Parcels are not edge-adjacent (no shared boundary) — merged as the convex hull of all beacons.",
  };
}

function convexHull(ids: string[], by: Map<string, Beacon>): string[] {
  const pts = ids.map((id) => ({ id, b: by.get(id)! })).filter((x) => x.b);
  if (pts.length <= 3) return pts.map((p) => p.id);
  pts.sort((p, q) => (p.b.east - q.b.east) || (p.b.north - q.b.north));
  const cross = (o: Beacon, a: Beacon, b: Beacon) =>
    (a.east - o.east) * (b.north - o.north) - (a.north - o.north) * (b.east - o.east);
  const lower: typeof pts = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2].b, lower[lower.length - 1].b, p.b) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: typeof pts = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2].b, upper[upper.length - 1].b, p.b) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper].map((p) => p.id);
}

// ---------------------------------------------------------------------------
// Parcel topology validation (Module F — parcel side) + smart warnings.
// ---------------------------------------------------------------------------
export function validateParcels(beacons: Beacon[], parcels: Parcel[]): Check[] {
  const checks: Check[] = [];
  const by = beaconMap(beacons);

  // 1. Duplicate beacon ids.
  const seen = new Set<string>();
  const dupIds = new Set<string>();
  for (const b of beacons) {
    if (seen.has(b.id)) dupIds.add(b.id);
    seen.add(b.id);
  }
  checks.push(
    dupIds.size
      ? { rule: "Duplicate beacon ids", severity: "error", message: `Duplicate beacon ids: ${[...dupIds].join(", ")}.` }
      : { rule: "Duplicate beacon ids", severity: "pass", message: `No duplicate beacon ids across ${beacons.length} beacons.` }
  );

  // 2. Coordinate consistency — distinct beacons sharing (near-)identical coordinates.
  const coincident: string[] = [];
  for (let i = 0; i < beacons.length; i++) {
    for (let j = i + 1; j < beacons.length; j++) {
      const a = beacons[i];
      const b = beacons[j];
      if (Math.hypot(a.east - b.east, a.north - b.north) < COORD_TOL) coincident.push(`${a.id}=${b.id}`);
    }
  }
  if (coincident.length)
    checks.push({
      rule: "Coordinate consistency",
      severity: "warning",
      message: `Beacons at the same coordinates (possible duplicate/typo): ${coincident.join(", ")}.`,
    });

  // 3. Per-parcel polygon closure + degenerate-side checks.
  for (const p of parcels) {
    const label = p.number || p.name || p.id;
    const m = parcelMetrics(p.beaconIds, by);
    const distinct = new Set(p.beaconIds).size;
    if (p.beaconIds.length !== distinct) {
      checks.push({ rule: `Parcel ${label} closure`, severity: "error", message: `Parcel ${label} repeats a beacon in its ring.` });
    }
    if (distinct < 3) {
      checks.push({ rule: `Parcel ${label} closure`, severity: "error", message: `Parcel ${label} has only ${distinct} beacon(s); a polygon needs at least 3.` });
      continue;
    }
    const missing = p.beaconIds.filter((id) => !by.has(id));
    if (missing.length)
      checks.push({ rule: `Parcel ${label} beacons`, severity: "error", message: `Parcel ${label} references missing beacon(s): ${missing.join(", ")}.` });
    const zero = m.sides.filter((s) => s.distance < COORD_TOL);
    if (zero.length)
      checks.push({ rule: `Parcel ${label} sides`, severity: "error", message: `Parcel ${label} has zero-length side(s): ${zero.map((s) => `${s.from}-${s.to}`).join(", ")}.` });
    if (m.area_m2 < 1 && distinct >= 3)
      checks.push({ rule: `Parcel ${label} area`, severity: "warning", message: `Parcel ${label} area is ${m.area_m2} m² — sliver/degenerate polygon?` });
    if (!missing.length && isSelfIntersecting(ringPoints(p.beaconIds, by)))
      checks.push({ rule: `Parcel ${label} boundary`, severity: "error", message: `Parcel ${label} boundary self-intersects — beacons are likely in the wrong order.` });
  }

  // 4. Pairwise parcel overlaps (interior intersection).
  const overlaps: string[] = [];
  for (let i = 0; i < parcels.length; i++) {
    for (let j = i + 1; j < parcels.length; j++) {
      const ra = ringPoints(parcels[i].beaconIds, by);
      const rb = ringPoints(parcels[j].beaconIds, by);
      if (ringsOverlap(ra, rb)) {
        const la = parcels[i].number || parcels[i].name || parcels[i].id;
        const lb = parcels[j].number || parcels[j].name || parcels[j].id;
        overlaps.push(`${la} ↔ ${lb}`);
      }
    }
  }
  if (parcels.length >= 2)
    checks.push(
      overlaps.length
        ? { rule: "Parcel overlap", severity: "error", message: `Overlapping parcels: ${overlaps.join(", ")}.` }
        : { rule: "Parcel overlap", severity: "pass", message: `No parcel overlaps detected across ${parcels.length} parcels.` }
    );

  // 5. Duplicate parcel numbers.
  const numSeen = new Set<string>();
  const numDup = new Set<string>();
  for (const p of parcels) {
    const num = p.number.trim();
    if (!num) continue;
    if (numSeen.has(num)) numDup.add(num);
    numSeen.add(num);
  }
  if (numDup.size)
    checks.push({ rule: "Parcel numbering", severity: "warning", message: `Duplicate parcel numbers: ${[...numDup].join(", ")}.` });

  return checks;
}
