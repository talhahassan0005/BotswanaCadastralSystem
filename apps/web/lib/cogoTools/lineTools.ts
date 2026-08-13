/**
 * LINE TOOLS — calculation logic only (no UI). Lines are stored as resolved
 * endpoint coordinates (see WLine in types.ts) — a snapshot at creation time,
 * not a live link back to the points that built them.
 */

import { forward, inverse, type Point } from "@/lib/server/geometry";
import { normalizeDeg, parseBearing } from "@/lib/server/angles";
import type { ToolContext, ToolResult, WLine, WPoint } from "./types";

function asPoint(p: WPoint): Point {
  return { east: p.east, north: p.north, name: p.name };
}
function requirePoint(v: any, label: string): WPoint {
  if (!v || typeof v.east !== "number") throw new Error(`Pick a ${label}.`);
  return v;
}
function requireLine(v: any, label: string): WLine {
  if (!v || typeof v.aE !== "number") throw new Error(`Pick a ${label}.`);
  return v;
}
function requireNumber(v: any, label: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number.`);
  return n;
}
function bearingOf(l: WLine): number {
  return inverse({ east: l.aE, north: l.aN }, { east: l.bE, north: l.bN })[0];
}

export function lineBetweenPoints(v: Record<string, any>): ToolResult {
  const a = requirePoint(v.pointA, "point A");
  const b = requirePoint(v.pointB, "point B");
  return { lines: [{ name: v.name, aE: a.east, aN: a.north, bE: b.east, bN: b.north }] };
}

export function lineByBearingDistance(v: Record<string, any>): ToolResult {
  const from = requirePoint(v.from, "from-point");
  const bearing = parseBearing(v.bearing);
  const dist = requireNumber(v.distance, "Distance");
  if (dist <= 0) throw new Error("Distance must be greater than zero.");
  const end = forward(asPoint(from), bearing, dist, v.name || "New");
  return {
    points: [{ name: end.name!, east: end.east, north: end.north }],
    lines: [{ name: v.name, aE: from.east, aN: from.north, bE: end.east, bN: end.north }],
  };
}

/** Polyline / traverse line: from a start point, walk a sequence of
 *  "bearing, distance" legs — one per line — building a connected chain of
 *  points and segments. */
export function polylineTraverse(v: Record<string, any>): ToolResult {
  const start = requirePoint(v.start, "start point");
  const legLines: string[] = String(v.legs ?? "")
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (legLines.length === 0) throw new Error("Enter at least one leg (bearing, distance per line).");

  const points: { name: string; east: number; north: number }[] = [];
  const lines: { name?: string; aE: number; aN: number; bE: number; bN: number }[] = [];
  let cur: Point = asPoint(start);
  legLines.forEach((line, i) => {
    const [brgText, distText] = line.split(/[, \t]+/);
    const bearing = parseBearing(brgText);
    const dist = Number(distText);
    if (!Number.isFinite(dist) || dist <= 0) throw new Error(`Leg ${i + 1}: distance must be a positive number.`);
    const next = forward(cur, bearing, dist, `${v.prefix || "T"}${i + 1}`);
    lines.push({ aE: cur.east, aN: cur.north, bE: next.east, bN: next.north });
    points.push({ name: next.name!, east: next.east, north: next.north });
    cur = next;
  });
  return { points, lines };
}

export function extendLine(v: Record<string, any>): ToolResult {
  const line = requireLine(v.line, "line");
  const dist = requireNumber(v.distance, "Extend distance");
  const end = v.end === "a" ? "a" : "b";
  const brg = bearingOf(line);
  if (end === "b") {
    const p = forward({ east: line.bE, north: line.bN }, brg, dist);
    return { lines: [{ name: v.name, aE: line.aE, aN: line.aN, bE: p.east, bN: p.north }] };
  }
  // Extending past A means walking backwards along the line's bearing.
  const p = forward({ east: line.aE, north: line.aN }, normalizeDeg(brg + 180), dist);
  return { lines: [{ name: v.name, aE: p.east, aN: p.north, bE: line.bE, bN: line.bN }] };
}

/** Shortens a line by pulling one end inward by a given distance. (A full
 *  boundary/cutting-object trim is a v2 CAD feature — this is the "trim by
 *  length" variant, the complement of Extend.) */
export function trimLine(v: Record<string, any>): ToolResult {
  const line = requireLine(v.line, "line");
  const dist = requireNumber(v.distance, "Trim distance");
  const end = v.end === "a" ? "a" : "b";
  const full = inverse({ east: line.aE, north: line.aN }, { east: line.bE, north: line.bN })[1];
  if (dist >= full) throw new Error("Trim distance must be shorter than the line's length.");
  const brg = bearingOf(line);
  if (end === "b") {
    const p = forward({ east: line.bE, north: line.bN }, normalizeDeg(brg + 180), dist);
    return { lines: [{ name: v.name, aE: line.aE, aN: line.aN, bE: p.east, bN: p.north }] };
  }
  const p = forward({ east: line.aE, north: line.aN }, brg, dist);
  return { lines: [{ name: v.name, aE: p.east, aN: p.north, bE: line.bE, bN: line.bN }] };
}

export function offsetLine(v: Record<string, any>): ToolResult {
  const line = requireLine(v.line, "line");
  const offset = requireNumber(v.offset, "Offset");
  const brg = bearingOf(line);
  const perp = brg + 90;
  const a2 = forward({ east: line.aE, north: line.aN }, perp, offset);
  const b2 = forward({ east: line.bE, north: line.bN }, perp, offset);
  return { lines: [{ name: v.name, aE: a2.east, aN: a2.north, bE: b2.east, bN: b2.north }] };
}

export function perpendicularLine(v: Record<string, any>): ToolResult {
  const line = requireLine(v.line, "reference line");
  const from = requirePoint(v.from, "start point");
  const length = requireNumber(v.length, "Length");
  const brg = bearingOf(line);
  const end = forward(asPoint(from), brg + 90, length, v.name || "New");
  return {
    points: [{ name: end.name!, east: end.east, north: end.north }],
    lines: [{ name: v.name, aE: from.east, aN: from.north, bE: end.east, bN: end.north }],
  };
}
