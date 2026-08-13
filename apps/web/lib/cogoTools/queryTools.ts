/**
 * QUERY TOOLS — calculation logic only (no UI). These never add geometry;
 * they always answer via ToolResult.message.
 */

import { formatDms } from "@/lib/server/angles";
import { inverse, type Point } from "@/lib/server/geometry";
import type { ToolResult, WPoint } from "./types";

function asPoint(p: WPoint): Point {
  return { east: p.east, north: p.north, name: p.name };
}
function requirePoint(v: any, label: string): WPoint {
  if (!v || typeof v.east !== "number") throw new Error(`Pick a ${label}.`);
  return v;
}

export function inverseBetweenPoints(v: Record<string, any>): ToolResult {
  const a = requirePoint(v.pointA, "point A");
  const b = requirePoint(v.pointB, "point B");
  const [bearing, distance] = inverse(asPoint(a), asPoint(b));
  return { message: `${a.name} → ${b.name}:  Bearing ${formatDms(bearing)}  ·  Distance ${distance.toFixed(3)} m` };
}

export function pointInfoLookup(v: Record<string, any>): ToolResult {
  const p = requirePoint(v.point, "point");
  return { message: `${p.name}:  Easting ${p.east.toFixed(3)}  ·  Northing ${p.north.toFixed(3)}` };
}

export function angleBetween3Points(v: Record<string, any>): ToolResult {
  const vertex = requirePoint(v.vertex, "vertex point (where the angle is measured)");
  const a = requirePoint(v.pointA, "first point");
  const b = requirePoint(v.pointB, "second point");
  const [b1] = inverse(asPoint(vertex), asPoint(a));
  const [b2] = inverse(asPoint(vertex), asPoint(b));
  let d = Math.abs(b1 - b2);
  if (d > 180) d = 360 - d;
  return { message: `Angle ${a.name}–${vertex.name}–${b.name} = ${formatDms(d)}  (${d.toFixed(4)}°)` };
}
