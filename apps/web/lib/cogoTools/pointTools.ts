/**
 * POINT TOOLS — calculation logic only (no UI). Each function is the `run`
 * handler for one entry in registry.tsx. Field values arrive already resolved:
 * "point"-type fields are the matching WPoint object, "number" fields may still
 * be strings (validated/parsed here), "text" bearing fields are parsed with
 * parseBearing so any supported notation (decimal, DDD.MMSS, DMS) works.
 */

import { forward, inverse, intersectBearingBearing, intersectDistanceDistance, intersectBearingDistance, type Point } from "@/lib/server/geometry";
import { normalizeDeg, parseBearing } from "@/lib/server/angles";
import type { ToolResult, WPoint } from "./types";

function asPoint(p: WPoint): Point {
  return { east: p.east, north: p.north, name: p.name };
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

export function addPointManual(v: Record<string, any>): ToolResult {
  const east = requireNumber(v.east, "Easting");
  const north = requireNumber(v.north, "Northing");
  return { points: [{ name: v.name || "New", east, north }] };
}

export function pointByBearingDistance(v: Record<string, any>): ToolResult {
  const from = requirePoint(v.from, "from-point");
  const bearing = parseBearing(v.bearing);
  const dist = requireNumber(v.distance, "Distance");
  if (dist <= 0) throw new Error("Distance must be greater than zero.");
  const p = forward(asPoint(from), bearing, dist, v.name || "New");
  return { points: [{ name: p.name!, east: p.east, north: p.north }] };
}

export function pointByAngleDistance(v: Record<string, any>): ToolResult {
  const from = requirePoint(v.from, "occupied point");
  const backsight = requirePoint(v.backsight, "backsight point");
  const angle = requireNumber(v.angle, "Angle");
  const dist = requireNumber(v.distance, "Distance");
  if (dist <= 0) throw new Error("Distance must be greater than zero.");
  const [bsBearing] = inverse(asPoint(from), asPoint(backsight));
  const bearing = normalizeDeg(bsBearing + angle);
  const p = forward(asPoint(from), bearing, dist, v.name || "New");
  return { points: [{ name: p.name!, east: p.east, north: p.north }] };
}

export function intersectionBB(v: Record<string, any>): ToolResult {
  const a = requirePoint(v.pointA, "point A");
  const b = requirePoint(v.pointB, "point B");
  const brgA = parseBearing(v.bearingA);
  const brgB = parseBearing(v.bearingB);
  const p = intersectBearingBearing(asPoint(a), brgA, asPoint(b), brgB);
  return { points: [{ name: v.name || "New", east: p.east, north: p.north }] };
}

export function intersectionDD(v: Record<string, any>): ToolResult {
  const a = requirePoint(v.pointA, "point A");
  const b = requirePoint(v.pointB, "point B");
  const ra = requireNumber(v.radiusA, "Radius from A");
  const rb = requireNumber(v.radiusB, "Radius from B");
  const preferRight = v.side !== "left";
  const p = intersectDistanceDistance(asPoint(a), ra, asPoint(b), rb, preferRight);
  return { points: [{ name: v.name || "New", east: p.east, north: p.north }] };
}

export function intersectionBD(v: Record<string, any>): ToolResult {
  const a = requirePoint(v.pointA, "point A (bearing origin)");
  const b = requirePoint(v.pointB, "point B (radius origin)");
  const brgA = parseBearing(v.bearingA);
  const rb = requireNumber(v.radiusB, "Radius from B");
  const preferFar = v.solution !== "near";
  const p = intersectBearingDistance(asPoint(a), brgA, asPoint(b), rb, preferFar);
  return { points: [{ name: v.name || "New", east: p.east, north: p.north }] };
}

export function pointOnLine(v: Record<string, any>): ToolResult {
  const a = requirePoint(v.pointA, "line start point");
  const b = requirePoint(v.pointB, "line end point");
  const chainage = requireNumber(v.chainage, "Chainage");
  const [brg] = inverse(asPoint(a), asPoint(b));
  const p = forward(asPoint(a), brg, chainage, v.name || "New");
  return { points: [{ name: p.name!, east: p.east, north: p.north }] };
}

export function perpendicularOffsetPoint(v: Record<string, any>): ToolResult {
  const a = requirePoint(v.pointA, "line start point");
  const b = requirePoint(v.pointB, "line end point");
  const chainage = requireNumber(v.chainage, "Chainage");
  const offset = requireNumber(v.offset, "Offset");
  const [brg] = inverse(asPoint(a), asPoint(b));
  const base = forward(asPoint(a), brg, chainage);
  // Positive offset = right of the A->B direction, negative = left.
  const p = forward(base, brg + 90, offset, v.name || "New");
  return { points: [{ name: p.name!, east: p.east, north: p.north }] };
}

export function midpoint(v: Record<string, any>): ToolResult {
  const a = requirePoint(v.pointA, "point A");
  const b = requirePoint(v.pointB, "point B");
  return {
    points: [{ name: v.name || "Mid", east: (a.east + b.east) / 2, north: (a.north + b.north) / 2 }],
  };
}

/** Interior angle at P between rays P->Q and P->R, in [0, 180]. */
function angleAt(p: Point, q: Point, r: Point): number {
  const [b1] = inverse(p, q);
  const [b2] = inverse(p, r);
  const d = Math.abs(b1 - b2);
  return d > 180 ? 360 - d : d;
}
const cot = (deg: number) => 1 / Math.tan((deg * Math.PI) / 180);

/**
 * 3-point resection (Tienstra's method): given three known points A, B, C and
 * the two horizontal angles observed at the unknown station — α = angle A-station-B,
 * β = angle B-station-C — solve for the station's coordinates.
 */
export function resection(v: Record<string, any>): ToolResult {
  const A = requirePoint(v.pointA, "point A");
  const B = requirePoint(v.pointB, "point B");
  const C = requirePoint(v.pointC, "point C");
  const alpha = requireNumber(v.angleAB, "Angle A-station-B");
  const beta = requireNumber(v.angleBC, "Angle B-station-C");
  if (alpha <= 0 || beta <= 0 || alpha + beta >= 360) {
    throw new Error("Angles must be positive and sum to less than 360°.");
  }
  const a = asPoint(A), b = asPoint(B), c = asPoint(C);
  const angA = angleAt(a, b, c);
  const angB = angleAt(b, a, c);
  const angC = 180 - angA - angB;
  if (angC <= 0) throw new Error("A, B and C are collinear — pick three points that form a real triangle.");

  const gamma = 360 - alpha - beta;
  const k1 = 1 / (cot(angA) - cot(alpha));
  const k2 = 1 / (cot(angB) - cot(beta));
  const k3 = 1 / (cot(angC) - cot(gamma));
  const ksum = k1 + k2 + k3;
  if (Math.abs(ksum) < 1e-9) {
    throw new Error("The station lies on the 'danger circle' through A, B, C — resection is indeterminate here.");
  }
  const east = (k1 * a.east + k2 * b.east + k3 * c.east) / ksum;
  const north = (k1 * a.north + k2 * b.north + k3 * c.north) / ksum;
  return { points: [{ name: v.name || "Station", east, north }] };
}
