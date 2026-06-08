/**
 * Core coordinate geometry: forward, inverse (join), area, intersections, curves.
 * Ported from services/engine/app/cogo/geometry.py.
 *
 * Convention: easting/northing in metres, bearings clockwise from grid north in
 * decimal degrees.
 */

import { normalizeDeg } from "./angles";

export interface Point {
  east: number;
  north: number;
  name?: string | null;
}

export function pt(east: number, north: number, name?: string | null): Point {
  return { east, north, name: name ?? null };
}

/** Compute a new point from a start point, bearing and distance. */
export function forward(p: Point, bearingDeg: number, distance: number, name?: string | null): Point {
  const b = (normalizeDeg(bearingDeg) * Math.PI) / 180;
  return {
    east: p.east + distance * Math.sin(b),
    north: p.north + distance * Math.cos(b),
    name: name ?? null,
  };
}

/** Inverse / join: return [bearingDeg, distance] from point a to point b. */
export function inverse(a: Point, b: Point): [number, number] {
  const de = b.east - a.east;
  const dn = b.north - a.north;
  const distance = Math.hypot(de, dn);
  const bearing = normalizeDeg((Math.atan2(de, dn) * 180) / Math.PI);
  return [bearing, distance];
}

/**
 * Signed area (m^2) of a closed polygon via the shoelace formula.
 * Points are the ordered vertices (do NOT repeat the first point).
 */
export function polygonArea(points: Point[]): number {
  const n = points.length;
  if (n < 3) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    total += points[i].east * points[j].north - points[j].east * points[i].north;
  }
  return total / 2;
}

export function areaHectares(points: Point[]): number {
  return Math.abs(polygonArea(points)) / 10_000;
}

/** Total length along the point sequence; closed=true adds last->first leg. */
export function perimeter(points: Point[], closed = true): number {
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += inverse(points[i], points[i + 1])[1];
  }
  if (closed) total += inverse(points[points.length - 1], points[0])[1];
  return total;
}

// ---------------------------------------------------------------------------
// Intersections
// ---------------------------------------------------------------------------

/** Intersection of two rays (point + bearing). Throws if near-parallel. */
export function intersectBearingBearing(a: Point, brgA: number, b: Point, brgB: number): Point {
  const ba = (normalizeDeg(brgA) * Math.PI) / 180;
  const bb = (normalizeDeg(brgB) * Math.PI) / 180;
  const daE = Math.sin(ba);
  const daN = Math.cos(ba);
  const dbE = Math.sin(bb);
  const dbN = Math.cos(bb);
  const denom = daE * dbN - daN * dbE;
  if (Math.abs(denom) < 1e-12) throw new Error("bearings are parallel; no unique intersection");
  const t = ((b.east - a.east) * dbN - (b.north - a.north) * dbE) / denom;
  return { east: a.east + t * daE, north: a.north + t * daN };
}

/**
 * Intersection of two circles (point+radius). Returns one of two solutions.
 * preferRight selects the solution to the right of the a->b vector.
 */
export function intersectDistanceDistance(
  a: Point,
  ra: number,
  b: Point,
  rb: number,
  preferRight = true
): Point {
  const d = Math.hypot(b.east - a.east, b.north - a.north);
  if (d === 0 || d > ra + rb || d < Math.abs(ra - rb)) throw new Error("circles do not intersect");
  const aa = (ra * ra - rb * rb + d * d) / (2 * d);
  const hSq = ra * ra - aa * aa;
  const h = Math.sqrt(Math.max(hSq, 0));
  const ux = (b.east - a.east) / d;
  const uy = (b.north - a.north) / d;
  const mx = a.east + aa * ux;
  const my = a.north + aa * uy;
  const sign = preferRight ? 1 : -1;
  return { east: mx + sign * h * uy, north: my - sign * h * ux };
}

/** Intersection of a ray from a with a circle of given radius about b. */
export function intersectBearingDistance(
  a: Point,
  brg: number,
  b: Point,
  radius: number,
  preferFar = true
): Point {
  const ba = (normalizeDeg(brg) * Math.PI) / 180;
  const de = Math.sin(ba);
  const dn = Math.cos(ba);
  const fx = a.east - b.east;
  const fy = a.north - b.north;
  const bq = 2 * (de * fx + dn * fy);
  const cq = fx * fx + fy * fy - radius * radius;
  const disc = bq * bq - 4 * cq;
  if (disc < 0) throw new Error("ray does not reach the circle");
  const sq = Math.sqrt(disc);
  const t1 = (-bq + sq) / 2;
  const t2 = (-bq - sq) / 2;
  const candidates = [t1, t2].filter((t) => t >= -1e-9);
  if (candidates.length === 0) throw new Error("intersection is behind the ray origin");
  const t = preferFar ? Math.max(...candidates) : Math.min(...candidates);
  return { east: a.east + t * de, north: a.north + t * dn };
}

// ---------------------------------------------------------------------------
// Circular curves
// ---------------------------------------------------------------------------
export interface CurveResult {
  radius: number;
  deflection_deg: number;
  tangent: number;
  arc_length: number;
  chord: number;
  mid_ordinate: number;
  external: number;
}

/** Elements of a circular curve given radius and deflection (central) angle. */
export function circularCurve(radius: number, deflectionDeg: number): CurveResult {
  const delta = (deflectionDeg * Math.PI) / 180;
  return {
    radius,
    deflection_deg: deflectionDeg,
    tangent: radius * Math.tan(delta / 2),
    arc_length: radius * delta,
    chord: 2 * radius * Math.sin(delta / 2),
    mid_ordinate: radius * (1 - Math.cos(delta / 2)),
    external: radius * (1 / Math.cos(delta / 2) - 1),
  };
}
