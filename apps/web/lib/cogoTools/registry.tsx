/**
 * Central COGO tool registry (client req 2026-08-13, Phase 1 = POINT TOOLS).
 * The drawing toolbar renders buttons by mapping over TOOL_REGISTRY — no tool
 * is ever a hardcoded button. Adding a new tool = add its calculation function
 * to a category file (e.g. pointTools.ts, lineTools.ts, ...), then add one
 * entry here with its icon + input fields.
 */

import type { ToolDef } from "./types";
import * as pt from "./pointTools";
import * as ln from "./lineTools";
import * as cv from "./curveTools";
import * as pg from "./polygonTools";

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

const LINE_TOOLS: ToolDef[] = [
  {
    id: "line-between-points",
    category: "line",
    label: "Line Between Points",
    description: "Draw a straight line connecting two known points.",
    icon: iconLineBetween,
    fields: [
      { key: "pointA", label: "Point A", type: "point" },
      { key: "pointB", label: "Point B", type: "point" },
      { key: "name", label: "Line name (optional)", type: "text" },
    ],
    run: ln.lineBetweenPoints,
  },
  {
    id: "line-bearing-distance",
    category: "line",
    label: "Line by Bearing & Distance",
    description: "Draw a line from a known point along a bearing for a given distance (also plots the new end point).",
    icon: iconLineBearingDistance,
    fields: [
      { key: "from", label: "From point", type: "point" },
      { key: "bearing", label: "Bearing (DDD.MMSS or decimal)", type: "text" },
      { key: "distance", label: "Distance (m)", type: "number" },
      { key: "name", label: "New point name", type: "text", default: "New" },
    ],
    run: ln.lineByBearingDistance,
  },
  {
    id: "polyline-traverse",
    category: "line",
    label: "Polyline / Traverse Line",
    description: "From a start point, walk a sequence of bearing+distance legs, drawing a connected chain of segments.",
    icon: iconPolyline,
    fields: [
      { key: "start", label: "Start point", type: "point" },
      { key: "legs", label: "Legs — one per line: bearing, distance", type: "textarea", default: "0.00.00, 50" },
      { key: "prefix", label: "New point name prefix", type: "text", default: "T" },
    ],
    run: ln.polylineTraverse,
  },
  {
    id: "extend-line",
    category: "line",
    label: "Extend Line",
    description: "Lengthen a line past one of its ends by a given distance.",
    icon: iconExtendLine,
    fields: [
      { key: "line", label: "Line", type: "line" },
      { key: "end", label: "Extend past", type: "select", options: [{ value: "b", label: "End B" }, { value: "a", label: "End A" }] },
      { key: "distance", label: "Extend by (m)", type: "number" },
      { key: "name", label: "Result line name (optional)", type: "text" },
    ],
    run: ln.extendLine,
  },
  {
    id: "trim-line",
    category: "line",
    label: "Trim Line",
    description: "Shorten a line by pulling one end inward by a given distance.",
    icon: iconTrimLine,
    fields: [
      { key: "line", label: "Line", type: "line" },
      { key: "end", label: "Trim from", type: "select", options: [{ value: "b", label: "End B" }, { value: "a", label: "End A" }] },
      { key: "distance", label: "Trim by (m)", type: "number" },
      { key: "name", label: "Result line name (optional)", type: "text" },
    ],
    run: ln.trimLine,
  },
  {
    id: "offset-line",
    category: "line",
    label: "Parallel / Offset Line",
    description: "Draw a copy of a line offset to one side by a given distance.",
    icon: iconOffsetLine,
    fields: [
      { key: "line", label: "Line", type: "line" },
      { key: "offset", label: "Offset (m, + right / − left)", type: "number" },
      { key: "name", label: "Result line name (optional)", type: "text" },
    ],
    run: ln.offsetLine,
  },
  {
    id: "perpendicular-line",
    category: "line",
    label: "Perpendicular Line",
    description: "Draw a line at 90° to a reference line, starting from a chosen point.",
    icon: iconPerpLine,
    fields: [
      { key: "line", label: "Reference line", type: "line" },
      { key: "from", label: "Start point", type: "point" },
      { key: "length", label: "Length (m)", type: "number" },
      { key: "name", label: "New point name", type: "text", default: "New" },
    ],
    run: ln.perpendicularLine,
  },
];

const ARC_TYPE_OPTIONS = [{ value: "minor", label: "Minor arc (shorter)" }, { value: "major", label: "Major arc (longer)" }];
const SIDE_OPTIONS = [{ value: "right", label: "Right of A→B" }, { value: "left", label: "Left of A→B" }];

const CURVE_TOOLS: ToolDef[] = [
  {
    id: "arc-radius-2points",
    category: "curve",
    label: "Arc by Radius + 2 Points",
    description: "A circular arc of a given radius connecting two known points.",
    icon: iconArcRadius2Points,
    fields: [
      { key: "pointA", label: "Start point", type: "point" },
      { key: "pointB", label: "End point", type: "point" },
      { key: "radius", label: "Radius (m)", type: "number" },
      { key: "side", label: "Centre side", type: "select", options: SIDE_OPTIONS },
      { key: "arcType", label: "Arc", type: "select", options: ARC_TYPE_OPTIONS },
      { key: "name", label: "Arc name (optional)", type: "text" },
    ],
    run: cv.arcByRadiusAnd2Points,
  },
  {
    id: "arc-3points",
    category: "curve",
    label: "Arc by 3 Points",
    description: "The circular arc that passes through three known points.",
    icon: iconArc3Points,
    fields: [
      { key: "pointA", label: "Start point", type: "point" },
      { key: "pointB", label: "Point on arc (between start and end)", type: "point" },
      { key: "pointC", label: "End point", type: "point" },
      { key: "name", label: "Arc name (optional)", type: "text" },
    ],
    run: cv.arcBy3Points,
  },
  {
    id: "arc-chord-bearing",
    category: "curve",
    label: "Arc by Chord + Bearing",
    description: "From a start point, a chord bearing and length define the end point; a radius bends it into an arc.",
    icon: iconArcChordBearing,
    fields: [
      { key: "pointA", label: "Start point", type: "point" },
      { key: "chordBearing", label: "Chord bearing", type: "text" },
      { key: "chordLength", label: "Chord length (m)", type: "number" },
      { key: "radius", label: "Radius (m)", type: "number" },
      { key: "side", label: "Centre side", type: "select", options: SIDE_OPTIONS },
      { key: "arcType", label: "Arc", type: "select", options: ARC_TYPE_OPTIONS },
      { key: "name", label: "New point / arc name", type: "text", default: "New" },
    ],
    run: cv.arcByChordAndBearing,
  },
  {
    id: "arc-tangent",
    category: "curve",
    label: "Arc by Tangent",
    description: "Tangent-in curve: from a PC point with a known tangent bearing, radius and deflection angle, compute the arc and its PT.",
    icon: iconArcTangent,
    fields: [
      { key: "pointA", label: "PC (start) point", type: "point" },
      { key: "tangentBearing", label: "Tangent-in bearing", type: "text" },
      { key: "radius", label: "Radius (m)", type: "number" },
      { key: "deflection", label: "Deflection angle (°)", type: "number" },
      { key: "turn", label: "Turn direction", type: "select", options: [{ value: "right", label: "Right" }, { value: "left", label: "Left" }] },
      { key: "name", label: "PT (end) point name", type: "text", default: "PT" },
    ],
    run: cv.arcByTangent,
  },
  {
    id: "fillet",
    category: "curve",
    label: "Fillet (rounded corner)",
    description: "Rounds the corner where two lines meet with an arc of the given radius, trimming both lines to the tangent points.",
    icon: iconFillet,
    fields: [
      { key: "lineA", label: "First line", type: "line" },
      { key: "lineB", label: "Second line", type: "line" },
      { key: "radius", label: "Fillet radius (m)", type: "number" },
      { key: "nameA", label: "Tangent point 1 name", type: "text", default: "T1" },
      { key: "nameB", label: "Tangent point 2 name", type: "text", default: "T2" },
    ],
    run: cv.fillet,
  },
];

const POLYGON_TOOLS: ToolDef[] = [
  {
    id: "draw-polygon",
    category: "polygon",
    label: "Draw Polygon",
    description: "Build a closed polygon (closed traverse) from a list of already-plotted point names, in boundary order.",
    icon: iconDrawPolygon,
    fields: [
      { key: "pointNames", label: "Vertices in order — one point name per line", type: "textarea" },
      { key: "name", label: "Polygon name (optional)", type: "text" },
    ],
    run: pg.drawPolygon,
  },
  {
    id: "auto-close-boundary",
    category: "polygon",
    label: "Auto-close Boundary",
    description: "Adds the missing closing segment from the last point of an open chain back to its first point.",
    icon: iconAutoClose,
    fields: [
      { key: "firstPoint", label: "First point of the chain", type: "point" },
      { key: "lastPoint", label: "Last point of the chain", type: "point" },
      { key: "name", label: "Closing line name (optional)", type: "text" },
    ],
    run: pg.autoCloseBoundary,
  },
  {
    id: "calculate-area",
    category: "polygon",
    label: "Calculate Area",
    description: "Area, hectares and perimeter of an already-drawn polygon.",
    icon: iconCalcArea,
    fields: [{ key: "polygon", label: "Polygon", type: "polygon" }],
    run: pg.calculatePolygonArea,
  },
  {
    id: "split-polygon",
    category: "polygon",
    label: "Split Polygon",
    description: "Splits a polygon into two along the chord between two of its own vertices.",
    icon: iconSplitPolygon,
    fields: [
      { key: "polygon", label: "Polygon", type: "polygon" },
      { key: "vertexA", label: "First split vertex", type: "point" },
      { key: "vertexB", label: "Second split vertex", type: "point" },
      { key: "nameA", label: "First piece name (optional)", type: "text" },
      { key: "nameB", label: "Second piece name (optional)", type: "text" },
    ],
    run: pg.splitPolygon,
  },
  {
    id: "merge-polygons",
    category: "polygon",
    label: "Merge Polygons",
    description: "Merges two polygons that share a boundary edge into one outer ring.",
    icon: iconMergePolygons,
    fields: [
      { key: "polygonA", label: "First polygon", type: "polygon" },
      { key: "polygonB", label: "Second polygon", type: "polygon" },
      { key: "name", label: "Merged polygon name (optional)", type: "text" },
    ],
    run: pg.mergePolygons,
  },
  {
    id: "offset-polygon",
    category: "polygon",
    label: "Offset / Buffer Polygon",
    description: "Moves every vertex outward (or inward) along its corner bisector by a given distance.",
    icon: iconOffsetPolygon,
    fields: [
      { key: "polygon", label: "Polygon", type: "polygon" },
      { key: "offset", label: "Offset (m, + outward / − inward)", type: "number" },
      { key: "name", label: "Result polygon name (optional)", type: "text" },
    ],
    run: pg.offsetPolygon,
  },
];

// Future phases (Traverse/Query/Annotation/Edit) append their category arrays
// here — the toolbar and TOOL_REGISTRY don't change shape.
export const TOOL_REGISTRY: ToolDef[] = [...POINT_TOOLS, ...LINE_TOOLS, ...CURVE_TOOLS, ...POLYGON_TOOLS];

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

function iconLineBetween(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <circle cx="4" cy="20" r="1.8" fill={c} stroke="none" />
      <circle cx="20" cy="4" r="1.8" fill={c} stroke="none" />
      <path d="M4 20L20 4" />
    </svg>
  );
}
function iconLineBearingDistance(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <circle cx="4" cy="20" r="1.8" fill={c} stroke="none" />
      <path d="M4 20L19 5M19 5v6M19 5h-6" />
    </svg>
  );
}
function iconPolyline(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M3 19l6-10 5 4 7-10" strokeLinejoin="round" />
      <circle cx="3" cy="19" r="1.5" fill={c} stroke="none" />
      <circle cx="9" cy="9" r="1.5" fill={c} stroke="none" />
      <circle cx="14" cy="13" r="1.5" fill={c} stroke="none" />
      <circle cx="21" cy="3" r="1.5" fill={c} stroke="none" />
    </svg>
  );
}
function iconExtendLine(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M2 20L14 8" />
      <path d="M14 8L22 2" strokeDasharray="2.5 2.5" />
      <circle cx="2" cy="20" r="1.6" fill={c} stroke="none" />
    </svg>
  );
}
function iconTrimLine(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M6 18L18 6" />
      <path d="M3 3l6 6M3 9l6-6" strokeWidth="1.6" />
    </svg>
  );
}
function iconOffsetLine(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M3 18L15 6" />
      <path d="M8 21L20 9" strokeDasharray="2.5 2.5" />
    </svg>
  );
}
function iconPerpLine(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M3 15h18" />
      <path d="M13 15V4" />
      <path d="M13 15l-2-2M13 15l2-2" strokeWidth="1.4" />
    </svg>
  );
}

function iconArcRadius2Points(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M4 18C4 9 9 4 18 4" />
      <circle cx="4" cy="18" r="1.6" fill={c} stroke="none" />
      <circle cx="18" cy="4" r="1.6" fill={c} stroke="none" />
    </svg>
  );
}
function iconArc3Points(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M4 18C4 9 9 4 18 4" />
      <circle cx="4" cy="18" r="1.5" fill={c} stroke="none" />
      <circle cx="10.5" cy="7.3" r="1.5" fill={c} stroke="none" />
      <circle cx="18" cy="4" r="1.5" fill={c} stroke="none" />
    </svg>
  );
}
function iconArcChordBearing(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M4 18C4 9 9 4 18 4" />
      <path d="M4 18L18 4" strokeDasharray="2 2" />
    </svg>
  );
}
function iconArcTangent(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M2 14h8" />
      <path d="M10 14c0-6 4-10 10-10" />
    </svg>
  );
}
function iconFillet(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M3 4v9a8 8 0 0 0 8 8h9" />
      <path d="M3 13a8 8 0 0 1 8-8" strokeDasharray="2 2" />
    </svg>
  );
}

function iconDrawPolygon(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M4 9l7-6 9 4-3 11-13 2z" fill={c} fillOpacity="0.12" strokeLinejoin="round" />
    </svg>
  );
}
function iconAutoClose(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M4 6v9l16 3V9z" strokeDasharray="0" />
      <path d="M4 15l7-11" strokeDasharray="2 2" />
    </svg>
  );
}
function iconCalcArea(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.6">
      <path d="M4 6l8-2 8 3-3 11-11 1z" fill={c} fillOpacity="0.18" />
      <text x="12" y="14" fontSize="7" fill={c} stroke="none" textAnchor="middle">A</text>
    </svg>
  );
}
function iconSplitPolygon(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M4 6l8-2 8 3-3 11-11 1z" />
      <path d="M8 4.5L16 17" strokeDasharray="2 2" />
    </svg>
  );
}
function iconMergePolygons(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M3 10l5-6 6 2-1 8-7 2z" fillOpacity="0" />
      <path d="M10 6l6-2 5 6-2 8-6 2-2-6z" fillOpacity="0" />
      <circle cx="10" cy="12" r="1.4" fill={c} stroke="none" />
    </svg>
  );
}
function iconOffsetPolygon(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M6 8l6-3 6 3-2 8-8 2z" />
      <path d="M3 5l7-3.5 7 3.5-2.3 9.3L3 13z" strokeDasharray="2 2" opacity="0.7" />
    </svg>
  );
}
