/**
 * POLYGON TOOLS — calculation logic only (no UI). Polygons are stored as a
 * self-contained ordered list of vertices (see WPolygon in types.ts), the
 * same snapshot approach as lines and arcs.
 */

import { inverse, polygonArea, type Point } from "@/lib/server/geometry";
import { normalizeDeg } from "@/lib/server/angles";
import type { ToolResult, WPoint, WPolygon } from "./types";

type Vtx = { name: string; east: number; north: number };

function requirePolygon(v: any, label: string): WPolygon {
  if (!v || !Array.isArray(v.points)) throw new Error(`Pick a ${label}.`);
  return v;
}
function requirePoint(v: any, label: string): WPoint {
  if (!v || typeof v.east !== "number") throw new Error(`Pick a ${label}.`);
  return v;
}
function requireNumber(v: any, label: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number.`);
  return n;
}
function metrics(points: Vtx[]) {
  const area_m2 = Math.abs(polygonArea(points));
  let perim = 0;
  for (let i = 0; i < points.length; i++) perim += inverse(points[i], points[(i + 1) % points.length])[1];
  return { area_m2, area_ha: area_m2 / 10_000, perimeter: perim };
}

/** Build a closed polygon from a list of already-plotted point names (one per
 *  line, in boundary order). */
export function drawPolygon(v: Record<string, any>, ctx: { points: WPoint[] }): ToolResult {
  const names = String(v.pointNames ?? "")
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length < 3) throw new Error("Enter at least 3 point names (one per line) to form a polygon.");
  const points: Vtx[] = names.map((n) => {
    const p = ctx.points.find((pt) => pt.name.toLowerCase() === n.toLowerCase());
    if (!p) throw new Error(`No plotted point named "${n}" — check the spelling / import it first.`);
    return { name: p.name, east: p.east, north: p.north };
  });
  return { polygons: [{ name: v.name, points }] };
}

/** Adds the missing closing segment from the last point of an open chain back
 *  to its first point, turning it into a closed boundary. */
export function autoCloseBoundary(v: Record<string, any>): ToolResult {
  const first = requirePoint(v.firstPoint, "first point of the chain");
  const last = requirePoint(v.lastPoint, "last point of the chain");
  if (first.id === last.id) throw new Error("First and last point are the same — the boundary is already closed.");
  return { lines: [{ name: v.name, aE: last.east, aN: last.north, bE: first.east, bN: first.north }] };
}

export function calculatePolygonArea(v: Record<string, any>): ToolResult {
  const poly = requirePolygon(v.polygon, "polygon");
  if (poly.points.length < 3) throw new Error("Polygon needs at least 3 vertices.");
  const m = metrics(poly.points);
  return {
    message: `Area = ${m.area_m2.toFixed(2)} m² (${m.area_ha.toFixed(4)} ha) · Perimeter = ${m.perimeter.toFixed(2)} m`,
  };
}

/** Splits a polygon along the chord between two of its own vertices — the
 *  same chord-split used by the Parcels module's subdivide(). */
export function splitPolygon(v: Record<string, any>): ToolResult {
  const poly = requirePolygon(v.polygon, "polygon");
  const a = requirePoint(v.vertexA, "first split vertex");
  const b = requirePoint(v.vertexB, "second split vertex");
  const i = poly.points.findIndex((p) => p.name === a.name);
  const j = poly.points.findIndex((p) => p.name === b.name);
  if (i < 0 || j < 0) throw new Error("Both vertices must belong to the selected polygon.");
  if (i === j) throw new Error("Pick two different vertices.");
  const lo = Math.min(i, j), hi = Math.max(i, j);
  const childA = poly.points.slice(lo, hi + 1);
  const childB = [...poly.points.slice(hi), ...poly.points.slice(0, lo + 1)];
  if (childA.length < 3 || childB.length < 3) {
    throw new Error("Split must leave at least 3 vertices on each side — pick non-adjacent vertices.");
  }
  return {
    polygons: [
      { name: v.nameA || `${poly.name || "Poly"}-A`, points: childA },
      { name: v.nameB || `${poly.name || "Poly"}-B`, points: childB },
    ],
    replacePolygonIds: [poly.id],
  };
}

const COORD_TOL = 0.01; // 1 cm — vertices closer than this are "the same point"
const keyOf = (p: Vtx) => `${p.east.toFixed(3)},${p.north.toFixed(3)}`;

/** Merges two polygons that share a boundary edge by cancelling that shared
 *  edge (in opposite directions, one polygon per side) and tracing the
 *  surviving edges into one outer ring — the same edge-cancellation method
 *  used by the Parcels module's consolidate(). */
export function mergePolygons(v: Record<string, any>): ToolResult {
  const A = requirePolygon(v.polygonA, "first polygon");
  const B = requirePolygon(v.polygonB, "second polygon");
  const edgesOf = (poly: WPolygon) => poly.points.map((p, i) => ({ a: p, b: poly.points[(i + 1) % poly.points.length] }));
  const edgesA = edgesOf(A);
  const edgesB = edgesOf(B);
  const usedB = new Set<number>();
  const survivors: { a: Vtx; b: Vtx }[] = [];
  for (const ea of edgesA) {
    const idx = edgesB.findIndex(
      (eb, k) => !usedB.has(k) && Math.hypot(ea.a.east - eb.b.east, ea.a.north - eb.b.north) < COORD_TOL && Math.hypot(ea.b.east - eb.a.east, ea.b.north - eb.a.north) < COORD_TOL
    );
    if (idx >= 0) usedB.add(idx);
    else survivors.push(ea);
  }
  edgesB.forEach((eb, k) => { if (!usedB.has(k)) survivors.push(eb); });
  if (usedB.size === 0) throw new Error("These polygons don't share a boundary edge — nothing to merge.");

  const pointByKey = new Map<string, Vtx>();
  const nextByKey = new Map<string, string>();
  for (const e of survivors) {
    pointByKey.set(keyOf(e.a), e.a);
    pointByKey.set(keyOf(e.b), e.b);
    nextByKey.set(keyOf(e.a), keyOf(e.b));
  }
  const startKey = keyOf(survivors[0].a);
  const traceKeys: string[] = [];
  let cur = startKey;
  for (let k = 0; k < survivors.length + 1; k++) {
    traceKeys.push(cur);
    const nx = nextByKey.get(cur);
    if (nx == null) break;
    cur = nx;
    if (cur === startKey) break;
  }
  const closed = traceKeys.length >= 3 && nextByKey.get(traceKeys[traceKeys.length - 1]) === startKey;
  if (!closed || traceKeys.length !== survivors.length) {
    throw new Error("The merged boundary isn't a single closed ring — the polygons may overlap rather than share one edge.");
  }
  const points = traceKeys.map((k) => pointByKey.get(k)!);
  return {
    polygons: [{ name: v.name || `${A.name || "A"}+${B.name || "B"}`, points }],
    replacePolygonIds: [A.id, B.id],
  };
}

/** Mitred offset (buffer): moves every vertex outward/inward along the
 *  bisector of its two adjacent edges. A simplified buffer — sharp reflex
 *  vertices at large offsets can self-intersect (not auto-cleaned here). */
export function offsetPolygon(v: Record<string, any>): ToolResult {
  const poly = requirePolygon(v.polygon, "polygon");
  const offset = requireNumber(v.offset, "Offset");
  const pts = poly.points;
  const n = pts.length;
  if (n < 3) throw new Error("Polygon needs at least 3 vertices.");
  const isCCW = polygonArea(pts as Point[]) > 0;
  const outwardSign = isCCW ? 90 : -90;

  const out: Vtx[] = pts.map((cur, i) => {
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const brgIn = inverse(prev, cur)[0];
    const brgOut = inverse(cur, next)[0];
    const n1 = normalizeDeg(brgIn + outwardSign);
    const n2 = normalizeDeg(brgOut + outwardSign);
    let diff = normalizeDeg(n2 - n1);
    if (diff > 180) diff -= 360; // shortest turn, -180..180
    const bisector = normalizeDeg(n1 + diff / 2);
    const halfAngleRad = (Math.abs(diff) / 2) * (Math.PI / 180);
    const cos = Math.cos(halfAngleRad);
    if (Math.abs(cos) < 0.05) throw new Error(`Vertex "${cur.name}" is too sharp for a clean offset — try a smaller offset.`);
    const miter = offset / cos;
    const b = (bisector * Math.PI) / 180;
    return { name: cur.name, east: cur.east + miter * Math.sin(b), north: cur.north + miter * Math.cos(b) };
  });
  return { polygons: [{ name: v.name || `${poly.name || "Poly"} offset`, points: out }] };
}
