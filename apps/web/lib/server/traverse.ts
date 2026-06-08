/**
 * Traverse computation and adjustment (Bowditch / Transit / Least Squares).
 * Ported from services/engine/app/cogo/traverse.py.
 *
 * A traverse is an ordered list of legs, each {bearing, distance}, starting from
 * a fixed station. Supports closed-loop, closed-link, and open traverses.
 */

import { normalizeDeg } from "./angles";
import { areaHectares, polygonArea, type Point } from "./geometry";
import { leastSquaresAdjust } from "./lsq";

export interface Leg {
  bearing: number; // decimal degrees, clockwise from grid north
  distance: number; // metres
  from_name?: string | null;
  to_name?: string | null;
}

export interface AdjustedLeg {
  index: number;
  from_name: string | null;
  to_name: string | null;
  bearing: number;
  distance: number;
  d_east_raw: number;
  d_north_raw: number;
  d_east_adj: number;
  d_north_adj: number;
}

export interface Closure {
  misclose_east: number;
  misclose_north: number;
  linear_misclosure: number;
  total_distance: number;
  relative_precision: number | null;
  relative_precision_text: string;
}

export interface TraverseResidual {
  leg: number;
  from: string | null;
  to: string | null;
  magnitude: number;
  correction_east?: number;
  correction_north?: number;
  v_distance?: number;
  v_direction_sec?: number;
}

export interface TraverseResult {
  type: string;
  adjustment: string;
  points: Point[];
  legs: AdjustedLeg[];
  closure: Closure;
  area_m2: number;
  area_ha: number;
  residuals: TraverseResidual[];
  sigma0: number;
}

const D2R = Math.PI / 180;

function dEast(leg: Leg): number {
  return leg.distance * Math.sin(normalizeDeg(leg.bearing) * D2R);
}
function dNorth(leg: Leg): number {
  return leg.distance * Math.cos(normalizeDeg(leg.bearing) * D2R);
}

function rawCoords(start: Point, legs: Leg[]): Point[] {
  const pts: Point[] = [start];
  let cur = start;
  for (const leg of legs) {
    cur = { east: cur.east + dEast(leg), north: cur.north + dNorth(leg), name: leg.to_name ?? null };
    pts.push(cur);
  }
  return pts;
}

function relativePrecision(linear: number, total: number): [number | null, string] {
  if (linear < 1e-9 || total <= 0) return [null, "1:∞ (exact)"];
  const denom = total / linear;
  return [denom, `1:${Math.round(denom).toLocaleString("en-US")}`];
}

export function computeTraverse(
  start: Point,
  legs: Leg[],
  traverseType = "closed",
  adjustment = "bowditch",
  endKnown: Point | null = null
): TraverseResult {
  const raw = rawCoords(start, legs);
  const totalDistance = legs.reduce((s, l) => s + l.distance, 0);

  let miscloseE = 0;
  let miscloseN = 0;
  if (traverseType === "open") {
    miscloseE = 0;
    miscloseN = 0;
  } else if (traverseType === "link") {
    if (endKnown === null) throw new Error("link traverse requires end_known");
    miscloseE = raw[raw.length - 1].east - endKnown.east;
    miscloseN = raw[raw.length - 1].north - endKnown.north;
  } else {
    miscloseE = raw[raw.length - 1].east - start.east;
    miscloseN = raw[raw.length - 1].north - start.north;
  }

  const linear = Math.hypot(miscloseE, miscloseN);
  const [denom, denomText] = relativePrecision(linear, totalDistance);

  const n = legs.length;
  let residuals: TraverseResidual[] = [];
  let sigma0 = 0;
  let adjPoints: Point[];

  const useLsq = adjustment === "lsq" && (traverseType === "closed" || traverseType === "link");

  if (useLsq) {
    const lsq = leastSquaresAdjust(start, legs, raw, traverseType === "closed", endKnown);
    adjPoints = lsq.points;
    residuals = lsq.residuals.map((r) => ({
      leg: r.leg,
      from: r.from,
      to: r.to,
      v_distance: r.v_distance,
      v_direction_sec: r.v_direction_sec,
      magnitude: r.magnitude,
    }));
    sigma0 = lsq.sigma0;
  } else {
    const corrE = new Array(n).fill(0);
    const corrN = new Array(n).fill(0);
    if (traverseType !== "open" && (adjustment === "bowditch" || adjustment === "transit") && linear > 0) {
      if (adjustment === "bowditch") {
        legs.forEach((leg, i) => {
          const w = totalDistance ? leg.distance / totalDistance : 0;
          corrE[i] = -miscloseE * w;
          corrN[i] = -miscloseN * w;
        });
      } else {
        const sumAbsDe = legs.reduce((s, l) => s + Math.abs(dEast(l)), 0) || 1;
        const sumAbsDn = legs.reduce((s, l) => s + Math.abs(dNorth(l)), 0) || 1;
        legs.forEach((leg, i) => {
          corrE[i] = -miscloseE * (Math.abs(dEast(leg)) / sumAbsDe);
          corrN[i] = -miscloseN * (Math.abs(dNorth(leg)) / sumAbsDn);
        });
      }
    }
    adjPoints = [start];
    let cur = start;
    legs.forEach((leg, i) => {
      cur = {
        east: cur.east + dEast(leg) + corrE[i],
        north: cur.north + dNorth(leg) + corrN[i],
        name: leg.to_name ?? null,
      };
      adjPoints.push(cur);
      residuals.push({
        leg: i + 1,
        from: leg.from_name ?? null,
        to: leg.to_name ?? null,
        correction_east: corrE[i],
        correction_north: corrN[i],
        magnitude: Math.hypot(corrE[i], corrN[i]),
      });
    });
  }

  const adjLegs: AdjustedLeg[] = legs.map((leg, i) => {
    const a = adjPoints[i];
    const b = adjPoints[i + 1];
    return {
      index: i + 1,
      from_name: leg.from_name ?? null,
      to_name: leg.to_name ?? null,
      bearing: normalizeDeg(leg.bearing),
      distance: leg.distance,
      d_east_raw: dEast(leg),
      d_north_raw: dNorth(leg),
      d_east_adj: b.east - a.east,
      d_north_adj: b.north - a.north,
    };
  });

  const closedLoop = traverseType === "closed";
  const vertices = closedLoop ? adjPoints.slice(0, -1) : adjPoints;

  const closure: Closure = {
    misclose_east: miscloseE,
    misclose_north: miscloseN,
    linear_misclosure: linear,
    total_distance: totalDistance,
    relative_precision: denom,
    relative_precision_text: denomText,
  };

  const areaM2 = closedLoop ? Math.abs(polygonArea(vertices)) : 0;
  const areaHa = closedLoop ? areaHectares(vertices) : 0;

  return {
    type: traverseType,
    adjustment,
    points: vertices,
    legs: adjLegs,
    closure,
    area_m2: areaM2,
    area_ha: areaHa,
    residuals,
    sigma0,
  };
}
