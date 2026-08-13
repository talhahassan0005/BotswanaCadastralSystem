/**
 * CURVE TOOLS — calculation logic only (no UI). Arcs are stored pre-resolved
 * (see WArc in types.ts): centre, radius, start/end bearings from the centre,
 * and the two SVG path flags, computed once here so the renderer just draws.
 */

import { forward, inverse, intersectBearingBearing, type Point } from "@/lib/server/geometry";
import { normalizeDeg, parseBearing } from "@/lib/server/angles";
import type { NewArc, ToolResult, WLine, WPoint } from "./types";

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

/** Build a WArc from a centre, radius and the two bearings (centre->start,
 *  centre->end), choosing the minor (<=180°) or major (>=180°) sweep. */
function arcFromCentreAndBearings(
  center: Point,
  radius: number,
  startBearing: number,
  endBearing: number,
  wantMajor: boolean
): NewArc {
  const cwSweep = normalizeDeg(endBearing - startBearing); // 0..360, clockwise start->end
  const useClockwise = wantMajor ? cwSweep >= 180 : cwSweep <= 180;
  const sweepDeg = useClockwise ? cwSweep : 360 - cwSweep;
  return {
    cE: center.east,
    cN: center.north,
    radius,
    startBearing,
    endBearing,
    largeArc: sweepDeg > 180 ? 1 : 0,
    sweep: useClockwise ? 1 : 0,
  };
}

export function arcByRadiusAnd2Points(v: Record<string, any>): ToolResult {
  const a = requirePoint(v.pointA, "start point");
  const b = requirePoint(v.pointB, "end point");
  const radius = requireNumber(v.radius, "Radius");
  if (radius <= 0) throw new Error("Radius must be greater than zero.");
  const [brgAB, chord] = inverse(asPoint(a), asPoint(b));
  const halfChord = chord / 2;
  if (halfChord > radius) throw new Error("Radius is too small to span the distance between the two points.");
  const h = Math.sqrt(radius * radius - halfChord * halfChord);
  const mid = forward(asPoint(a), brgAB, halfChord);
  const side = v.side === "left" ? -90 : 90;
  const center = h > 1e-9 ? forward(mid, brgAB + side, h) : mid; // diameter case: h=0, centre is the midpoint
  const startBearing = inverse(center, asPoint(a))[0];
  const endBearing = inverse(center, asPoint(b))[0];
  const arc = arcFromCentreAndBearings(center, radius, startBearing, endBearing, v.arcType === "major");
  return { arcs: [{ ...arc, name: v.name }] };
}

export function arcBy3Points(v: Record<string, any>): ToolResult {
  const A = requirePoint(v.pointA, "start point");
  const M = requirePoint(v.pointB, "point on arc");
  const B = requirePoint(v.pointC, "end point");
  const D = 2 * (A.east * (M.north - B.north) + M.east * (B.north - A.north) + B.east * (A.north - M.north));
  if (Math.abs(D) < 1e-9) throw new Error("The three points are collinear — pick points that form a real arc.");
  const a2 = A.east ** 2 + A.north ** 2, m2 = M.east ** 2 + M.north ** 2, b2 = B.east ** 2 + B.north ** 2;
  const cE = (a2 * (M.north - B.north) + m2 * (B.north - A.north) + b2 * (A.north - M.north)) / D;
  const cN = (a2 * (B.east - M.east) + m2 * (A.east - B.east) + b2 * (M.east - A.east)) / D;
  const center: Point = { east: cE, north: cN };
  const radius = inverse(center, asPoint(A))[1];
  const startBearing = inverse(center, asPoint(A))[0];
  const endBearing = inverse(center, asPoint(B))[0];
  const midBearing = inverse(center, asPoint(M))[0];
  // Pick whichever sweep direction (from A to B) actually passes through M.
  const cwToEnd = normalizeDeg(endBearing - startBearing); // clockwise sweep, start->end
  const cwToMid = normalizeDeg(midBearing - startBearing);
  const viaClockwise = cwToMid <= cwToEnd; // M falls within the clockwise sweep from A to B
  const sweepDeg = viaClockwise ? cwToEnd : 360 - cwToEnd;
  const arc: NewArc = {
    cE: center.east,
    cN: center.north,
    radius,
    startBearing,
    endBearing,
    largeArc: sweepDeg > 180 ? 1 : 0,
    sweep: viaClockwise ? 1 : 0,
    name: v.name,
  };
  return { arcs: [arc] };
}

export function arcByChordAndBearing(v: Record<string, any>): ToolResult {
  const a = requirePoint(v.pointA, "start point");
  const bearing = parseBearing(v.chordBearing);
  const chord = requireNumber(v.chordLength, "Chord length");
  const radius = requireNumber(v.radius, "Radius");
  if (radius <= 0) throw new Error("Radius must be greater than zero.");
  const halfChord = chord / 2;
  if (halfChord > radius) throw new Error("Radius is too small to span the chord length.");
  const b = forward(asPoint(a), bearing, chord, v.name || "New");
  const h = Math.sqrt(radius * radius - halfChord * halfChord);
  const mid = forward(asPoint(a), bearing, halfChord);
  const side = v.side === "left" ? -90 : 90;
  const center = h > 1e-9 ? forward(mid, bearing + side, h) : mid;
  const startBearing = inverse(center, asPoint(a))[0];
  const endBearing = inverse(center, b)[0];
  const arc = arcFromCentreAndBearings(center, radius, startBearing, endBearing, v.arcType === "major");
  return {
    points: [{ name: b.name!, east: b.east, north: b.north }],
    arcs: [{ ...arc, name: v.name }],
  };
}

/** Tangent-in curve (road/traverse style): from a PC (point of curve) with a
 *  known incoming tangent bearing, radius and deflection angle, compute the
 *  arc and its PT (point of tangency). */
export function arcByTangent(v: Record<string, any>): ToolResult {
  const pc = requirePoint(v.pointA, "PC (start) point");
  const tangentBearing = parseBearing(v.tangentBearing);
  const radius = requireNumber(v.radius, "Radius");
  const deflection = requireNumber(v.deflection, "Deflection angle");
  if (radius <= 0) throw new Error("Radius must be greater than zero.");
  if (deflection <= 0 || deflection >= 360) throw new Error("Deflection must be between 0° and 360°.");
  const turnRight = v.turn !== "left";
  const centerBearing = normalizeDeg(tangentBearing + (turnRight ? 90 : -90));
  const center = forward(asPoint(pc), centerBearing, radius);
  const startBearing = normalizeDeg(centerBearing + 180);
  const endBearing = normalizeDeg(startBearing + (turnRight ? deflection : -deflection));
  const pt = forward(center, endBearing, radius, v.name || "New");
  const arc: NewArc = {
    cE: center.east,
    cN: center.north,
    radius,
    startBearing,
    endBearing,
    largeArc: deflection > 180 ? 1 : 0,
    sweep: turnRight ? 1 : 0,
    name: v.arcName,
  };
  return {
    points: [{ name: pt.name!, east: pt.east, north: pt.north }],
    arcs: [arc],
  };
}

/** Rounded corner between two lines: finds their intersection, then inscribes
 *  a circle of the given radius tangent to both, trimming each line back to
 *  its tangent point. Assumes the two lines are not parallel. */
export function fillet(v: Record<string, any>): ToolResult {
  const lineA = requireLine(v.lineA, "first line");
  const lineB = requireLine(v.lineB, "second line");
  const radius = requireNumber(v.radius, "Fillet radius");
  if (radius <= 0) throw new Error("Radius must be greater than zero.");

  const brgA = inverse({ east: lineA.aE, north: lineA.aN }, { east: lineA.bE, north: lineA.bN })[0];
  const brgB = inverse({ east: lineB.aE, north: lineB.aN }, { east: lineB.bE, north: lineB.bN })[0];
  let corner: Point;
  try {
    corner = intersectBearingBearing({ east: lineA.aE, north: lineA.aN }, brgA, { east: lineB.aE, north: lineB.aN }, brgB);
  } catch {
    throw new Error("These two lines are parallel — they don't form a corner to fillet.");
  }

  // Which endpoint of each line is the corner, and which is "away" (the far end)?
  const farEnd = (l: WLine) => {
    const da = inverse(corner, { east: l.aE, north: l.aN })[1];
    const db = inverse(corner, { east: l.bE, north: l.bN })[1];
    return da >= db ? { east: l.aE, north: l.aN } : { east: l.bE, north: l.bN };
  };
  const farA = farEnd(lineA);
  const farB = farEnd(lineB);
  const dirA = inverse(corner, farA)[0];
  const dirB = inverse(corner, farB)[0];

  const diff = normalizeDeg(dirB - dirA);
  const theta = diff > 180 ? 360 - diff : diff; // interior angle of the wedge, 0..180
  if (theta < 1e-6 || theta > 179.999) throw new Error("These lines don't form a real corner (they're straight or coincident).");
  const thetaRad = (theta * Math.PI) / 180;

  const tangentDist = radius / Math.tan(thetaRad / 2);
  const tangentA = forward(corner, dirA, tangentDist);
  const tangentB = forward(corner, dirB, tangentDist);

  const signedDelta = diff > 180 ? diff - 360 : diff; // -180..180, dirA -> dirB the short way
  const bisector = normalizeDeg(dirA + signedDelta / 2);
  const centerDist = radius / Math.sin(thetaRad / 2);
  const center = forward(corner, bisector, centerDist);

  const startBearing = inverse(center, tangentA)[0];
  const endBearing = inverse(center, tangentB)[0];
  const arc = arcFromCentreAndBearings(center, radius, startBearing, endBearing, false);

  return {
    points: [
      { name: v.nameA || "T1", east: tangentA.east, north: tangentA.north },
      { name: v.nameB || "T2", east: tangentB.east, north: tangentB.north },
    ],
    lines: [
      { aE: tangentA.east, aN: tangentA.north, bE: farA.east, bN: farA.north },
      { aE: tangentB.east, aN: tangentB.north, bE: farB.east, bN: farB.north },
    ],
    arcs: [{ ...arc, name: v.name }],
    replaceLineIds: [lineA.id, lineB.id],
  };
}
