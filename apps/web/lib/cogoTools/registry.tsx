/**
 * Central COGO tool registry (client req 2026-08-13, Phase 1 = POINT TOOLS).
 * The drawing toolbar renders buttons by mapping over TOOL_REGISTRY — no tool
 * is ever a hardcoded button. Adding a new tool = add its calculation function
 * to a category file (e.g. pointTools.ts, lineTools.ts, ...), then add one
 * entry here with its icon + input fields.
 */

import type { ToolDef } from "./types";
import * as pt from "./pointTools";

const POINT_TOOLS: ToolDef[] = [
  {
    id: "add-point",
    category: "point",
    label: "Add Point",
    description: "Place a point at a manually entered coordinate.",
    icon: iconAddPoint,
    fields: [
      { key: "name", label: "Point name", type: "text", default: "New" },
      { key: "east", label: "Easting", type: "number" },
      { key: "north", label: "Northing", type: "number" },
    ],
    run: pt.addPointManual,
  },
  {
    id: "point-bearing-distance",
    category: "point",
    label: "Point by Bearing & Distance",
    description: "Forward/polar: from a known point, travel a bearing and distance to a new point.",
    icon: iconBearingDistance,
    fields: [
      { key: "from", label: "From point", type: "point" },
      { key: "bearing", label: "Bearing (DDD.MMSS or decimal)", type: "text" },
      { key: "distance", label: "Distance (m)", type: "number" },
      { key: "name", label: "New point name", type: "text", default: "New" },
    ],
    run: pt.pointByBearingDistance,
  },
  {
    id: "point-angle-distance",
    category: "point",
    label: "Point by Angle & Distance",
    description: "From an occupied point, turn a horizontal angle off a backsight direction, then measure a distance.",
    icon: iconAngleDistance,
    fields: [
      { key: "from", label: "Occupied point", type: "point" },
      { key: "backsight", label: "Backsight point (angle measured from this direction)", type: "point" },
      { key: "angle", label: "Angle turned (°, clockwise from backsight)", type: "number" },
      { key: "distance", label: "Distance (m)", type: "number" },
      { key: "name", label: "New point name", type: "text", default: "New" },
    ],
    run: pt.pointByAngleDistance,
  },
  {
    id: "intersection-bb",
    category: "point",
    label: "Intersection: Bearing–Bearing",
    description: "Two rays, each a known point + bearing — where they cross.",
    icon: iconIntersectBB,
    fields: [
      { key: "pointA", label: "Point A", type: "point" },
      { key: "bearingA", label: "Bearing from A", type: "text" },
      { key: "pointB", label: "Point B", type: "point" },
      { key: "bearingB", label: "Bearing from B", type: "text" },
      { key: "name", label: "New point name", type: "text", default: "New" },
    ],
    run: pt.intersectionBB,
  },
  {
    id: "intersection-dd",
    category: "point",
    label: "Intersection: Distance–Distance",
    description: "Two circles, each a known point + radius — where they cross.",
    icon: iconIntersectDD,
    fields: [
      { key: "pointA", label: "Point A", type: "point" },
      { key: "radiusA", label: "Radius from A (m)", type: "number" },
      { key: "pointB", label: "Point B", type: "point" },
      { key: "radiusB", label: "Radius from B (m)", type: "number" },
      { key: "side", label: "Solution", type: "select", options: [{ value: "right", label: "Right of A→B" }, { value: "left", label: "Left of A→B" }] },
      { key: "name", label: "New point name", type: "text", default: "New" },
    ],
    run: pt.intersectionDD,
  },
  {
    id: "intersection-bd",
    category: "point",
    label: "Intersection: Bearing–Distance",
    description: "A ray from A (bearing) meets a circle of given radius about B.",
    icon: iconIntersectBD,
    fields: [
      { key: "pointA", label: "Point A (bearing origin)", type: "point" },
      { key: "bearingA", label: "Bearing from A", type: "text" },
      { key: "pointB", label: "Point B (radius origin)", type: "point" },
      { key: "radiusB", label: "Radius from B (m)", type: "number" },
      { key: "solution", label: "Solution", type: "select", options: [{ value: "far", label: "Far intersection" }, { value: "near", label: "Near intersection" }] },
      { key: "name", label: "New point name", type: "text", default: "New" },
    ],
    run: pt.intersectionBD,
  },
  {
    id: "point-on-line",
    category: "point",
    label: "Point on Line",
    description: "A point at a given chainage (station distance) along the line from A to B.",
    icon: iconPointOnLine,
    fields: [
      { key: "pointA", label: "Line start (A)", type: "point" },
      { key: "pointB", label: "Line end (B)", type: "point" },
      { key: "chainage", label: "Chainage from A (m)", type: "number" },
      { key: "name", label: "New point name", type: "text", default: "New" },
    ],
    run: pt.pointOnLine,
  },
  {
    id: "perpendicular-offset",
    category: "point",
    label: "Perpendicular Offset Point",
    description: "A point offset left/right of the A→B line, at a given chainage.",
    icon: iconPerpOffset,
    fields: [
      { key: "pointA", label: "Line start (A)", type: "point" },
      { key: "pointB", label: "Line end (B)", type: "point" },
      { key: "chainage", label: "Chainage from A (m)", type: "number" },
      { key: "offset", label: "Offset (m, + right / − left)", type: "number" },
      { key: "name", label: "New point name", type: "text", default: "New" },
    ],
    run: pt.perpendicularOffsetPoint,
  },
  {
    id: "resection",
    category: "point",
    label: "Resection (3-point)",
    description: "Tienstra 3-point resection: locate an unknown station from three known points and two observed angles.",
    icon: iconResection,
    fields: [
      { key: "pointA", label: "Known point A", type: "point" },
      { key: "pointB", label: "Known point B", type: "point" },
      { key: "pointC", label: "Known point C", type: "point" },
      { key: "angleAB", label: "Angle A–station–B (°)", type: "number" },
      { key: "angleBC", label: "Angle B–station–C (°)", type: "number" },
      { key: "name", label: "Station name", type: "text", default: "Station" },
    ],
    run: pt.resection,
  },
  {
    id: "midpoint",
    category: "point",
    label: "Midpoint",
    description: "The point exactly halfway between two known points.",
    icon: iconMidpoint,
    fields: [
      { key: "pointA", label: "Point A", type: "point" },
      { key: "pointB", label: "Point B", type: "point" },
      { key: "name", label: "New point name", type: "text", default: "Mid" },
    ],
    run: pt.midpoint,
  },
];

// Future phases (Line/Curve/Polygon/Traverse/Query/Annotation/Edit) append their
// category arrays here — the toolbar and TOOL_REGISTRY don't change shape.
export const TOOL_REGISTRY: ToolDef[] = [...POINT_TOOLS];

function iconAddPoint(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <circle cx="12" cy="12" r="2.4" fill={c} stroke="none" />
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
    </svg>
  );
}
function iconBearingDistance(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <circle cx="5" cy="19" r="1.8" />
      <path d="M5 19L19 5M19 5v6M19 5h-6" />
    </svg>
  );
}
function iconAngleDistance(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M5 19h14M5 19L17 7" />
      <path d="M5 19a8 8 0 0 1 6.5-13" strokeDasharray="2 2" />
    </svg>
  );
}
function iconIntersectBB(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M3 3l18 10M21 3L3 13" />
      <circle cx="12" cy="8" r="2" fill={c} stroke="none" />
    </svg>
  );
}
function iconIntersectDD(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.6">
      <circle cx="9" cy="13" r="7" />
      <circle cx="16" cy="13" r="7" />
    </svg>
  );
}
function iconIntersectBD(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M3 20L18 5" />
      <circle cx="17" cy="15" r="6" strokeWidth="1.6" />
    </svg>
  );
}
function iconPointOnLine(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <circle cx="4" cy="20" r="1.8" />
      <circle cx="20" cy="4" r="1.8" />
      <path d="M4 20L20 4" />
      <circle cx="12" cy="12" r="2" fill={c} stroke="none" />
    </svg>
  );
}
function iconPerpOffset(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M3 18h18" />
      <path d="M12 18V8" />
      <circle cx="12" cy="8" r="1.8" fill={c} stroke="none" />
    </svg>
  );
}
function iconResection(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <circle cx="4" cy="6" r="1.6" />
      <circle cx="20" cy="6" r="1.6" />
      <circle cx="12" cy="20" r="1.6" />
      <path d="M4 6l16 0M4 6l8 14M20 6l-8 14" strokeDasharray="2 2" />
      <circle cx="12" cy="11" r="2" fill={c} stroke="none" />
    </svg>
  );
}
function iconMidpoint(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <circle cx="4" cy="20" r="1.8" />
      <circle cx="20" cy="4" r="1.8" />
      <path d="M4 20L20 4" strokeDasharray="2 2" />
      <circle cx="12" cy="12" r="2.4" fill={c} stroke="none" />
    </svg>
  );
}
