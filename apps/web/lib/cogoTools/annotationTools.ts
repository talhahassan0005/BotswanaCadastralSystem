/**
 * ANNOTATION TOOLS — calculation logic only (no UI). All four place a WText
 * on the canvas at a computed anchor position.
 */

import { formatDms } from "@/lib/server/angles";
import { inverse, polygonArea, type Point } from "@/lib/server/geometry";
import type { ToolResult, WLine, WPoint, WPolygon } from "./types";

function requirePoint(v: any, label: string): WPoint {
  if (!v || typeof v.east !== "number") throw new Error(`Pick a ${label}.`);
  return v;
}
function requireLine(v: any, label: string): WLine {
  if (!v || typeof v.aE !== "number") throw new Error(`Pick a ${label}.`);
  return v;
}
function requirePolygon(v: any, label: string): WPolygon {
  if (!v || !Array.isArray(v.points)) throw new Error(`Pick a ${label}.`);
  return v;
}

export function pointLabel(v: Record<string, any>): ToolResult {
  const p = requirePoint(v.point, "point");
  const text = v.format === "name" ? p.name : `${p.name}  (${p.east.toFixed(2)}, ${p.north.toFixed(2)})`;
  return { texts: [{ text, east: p.east, north: p.north, size: Number(v.size) || 12 }] };
}

export function lineLabel(v: Record<string, any>): ToolResult {
  const l = requireLine(v.line, "line");
  const [bearing, distance] = inverse({ east: l.aE, north: l.aN } as Point, { east: l.bE, north: l.bN } as Point);
  const text = `${formatDms(bearing)}  ${distance.toFixed(2)}m`;
  return { texts: [{ text, east: (l.aE + l.bE) / 2, north: (l.aN + l.bN) / 2, size: Number(v.size) || 12 }] };
}

export function areaLabel(v: Record<string, any>): ToolResult {
  const poly = requirePolygon(v.polygon, "polygon");
  if (poly.points.length < 3) throw new Error("Polygon needs at least 3 vertices.");
  const areaHa = Math.abs(polygonArea(poly.points as Point[])) / 10_000;
  const cE = poly.points.reduce((s, p) => s + p.east, 0) / poly.points.length;
  const cN = poly.points.reduce((s, p) => s + p.north, 0) / poly.points.length;
  return { texts: [{ text: `${areaHa.toFixed(4)} ha`, east: cE, north: cN, size: Number(v.size) || 12 }] };
}

export function noteTool(v: Record<string, any>): ToolResult {
  const p = requirePoint(v.point, "anchor point");
  const text = String(v.text ?? "").trim();
  if (!text) throw new Error("Enter the note text.");
  return { texts: [{ text, east: p.east, north: p.north, size: Number(v.size) || 12 }] };
}
