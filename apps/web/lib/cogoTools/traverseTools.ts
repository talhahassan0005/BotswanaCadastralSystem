/**
 * TRAVERSE & ADJUSTMENT TOOLS — thin wrappers around the SAME computeTraverse()
 * engine that powers the main Cadastral/COGO Engine tab and /api/cogo/traverse
 * (lib/server/traverse.ts). No traverse math is reimplemented here — these
 * tools just give the work station canvas a quick way to plot a scratch
 * traverse without leaving it to go set one up in the full COGO Engine form.
 *
 * Scope note: link traverses (a known end station) and their extra "known end
 * point" input aren't offered here — the field schema is static (no
 * conditional fields yet), so link traverses stay in the main COGO Engine tab.
 * These tools cover closed-loop and open traverses.
 */

import { parseBearing } from "@/lib/server/angles";
import type { Point } from "@/lib/server/geometry";
import { computeTraverse, type Leg } from "@/lib/server/traverse";
import type { ToolResult, WPoint } from "./types";

function requirePoint(v: any, label: string): WPoint {
  if (!v || typeof v.east !== "number") throw new Error(`Pick a ${label}.`);
  return v;
}

function parseLegs(text: string, prefix: string): Leg[] {
  const lines = String(text ?? "").split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error("Enter at least one leg: bearing, distance[, name] per line.");
  return lines.map((line, i) => {
    const [brgText, distText, name] = line.split(/[,\t]+/).map((s) => s?.trim());
    const distance = Number(distText);
    if (!Number.isFinite(distance) || distance <= 0) throw new Error(`Leg ${i + 1}: distance must be a positive number.`);
    return { bearing: parseBearing(brgText), distance, to_name: name || `${prefix}${i + 1}` };
  });
}

/** Plot every computed vertex (after the start, which is already on the
 *  canvas) and the connecting segments; for a closed loop, also close the
 *  last leg back to the start. */
function plotResult(start: Point, points: Point[], closed: boolean): ToolResult {
  const plotted = points.slice(1); // skip the start — it's already plotted
  const lines: ToolResult["lines"] = [];
  let prev = points[0];
  for (const p of plotted) {
    lines.push({ aE: prev.east, aN: prev.north, bE: p.east, bN: p.north });
    prev = p;
  }
  if (closed && plotted.length) {
    const last = plotted[plotted.length - 1];
    lines.push({ aE: last.east, aN: last.north, bE: start.east, bN: start.north });
  }
  return {
    points: plotted.map((p) => ({ name: p.name ?? "T", east: p.east, north: p.north })),
    lines,
  };
}

export function traverseInput(v: Record<string, any>): ToolResult {
  const start = requirePoint(v.startPoint, "start point");
  const type = v.type === "open" ? "open" : "closed";
  const legs = parseLegs(v.legs, v.prefix || "T");
  const result = computeTraverse({ east: start.east, north: start.north, name: start.name }, legs, type, "none", null);
  return plotResult(result.points[0], result.points, type === "closed");
}

export function closureCheck(v: Record<string, any>): ToolResult {
  const start = requirePoint(v.startPoint, "start point");
  const legs = parseLegs(v.legs, "T");
  const result = computeTraverse({ east: start.east, north: start.north, name: start.name }, legs, "closed", "none", null);
  const c = result.closure;
  return {
    message: `Linear misclosure = ${c.linear_misclosure.toFixed(3)} m · ${c.relative_precision_text} · total distance ${c.total_distance.toFixed(2)} m`,
  };
}

function adjustAndPlot(v: Record<string, any>, method: "bowditch" | "transit" | "lsq"): ToolResult {
  const start = requirePoint(v.startPoint, "start point");
  const legs = parseLegs(v.legs, v.prefix || "T");
  const result = computeTraverse({ east: start.east, north: start.north, name: start.name }, legs, "closed", method, null);
  return plotResult(result.points[0], result.points, true);
}

export function bowditchAdjustment(v: Record<string, any>): ToolResult {
  return adjustAndPlot(v, "bowditch");
}
export function transitAdjustment(v: Record<string, any>): ToolResult {
  return adjustAndPlot(v, "transit");
}
export function leastSquaresAdjustment(v: Record<string, any>): ToolResult {
  return adjustAndPlot(v, "lsq");
}
