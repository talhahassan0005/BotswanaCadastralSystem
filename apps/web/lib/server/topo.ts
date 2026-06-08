/**
 * Topographic survey processing (Module: Topo Survey).
 *
 * Takes scattered levelled points (Easting, Northing, Reduced Level) and builds
 * a TIN surface, then derives the deliverables a surveyor expects:
 *   - surface statistics (RL range, mean, plan area of the surveyed extent)
 *   - contour lines at a chosen interval
 *   - the triangulated mesh + spot heights for plotting
 *
 * All maths is pure TS so it runs on Vercel with no engine/Python dependency.
 */

import {
  contourLevels,
  contourLines,
  triangulate,
  triPlanArea,
  type ContourLevel,
  type Tri,
  type XYZ,
} from "./delaunay";
import { round } from "./angles";

export interface TopoStats {
  count: number;
  triangles: number;
  minZ: number;
  maxZ: number;
  meanZ: number;
  relief: number; // maxZ - minZ
  planArea: number; // m^2 covered by the TIN (convex hull of points)
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface TopoSurface {
  points: XYZ[];
  triangles: Tri[];
  contours: ContourLevel[];
  interval: number;
  stats: TopoStats;
}

/**
 * Parse free-text point input. Accepts one point per line, comma/space/tab
 * separated, in either of the two common survey orders:
 *   "name, E, N, Z"   (a leading non-numeric token is treated as the point name)
 *   "E, N, Z"
 * Blank lines and lines starting with '#' are ignored.
 */
export function parseTopoPoints(text: string): XYZ[] {
  const out: XYZ[] = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/[,\t ]+/).filter(Boolean);
    if (parts.length < 3) continue;

    let name: string | null = null;
    let nums = parts;
    // Leading token that isn't a number -> it's the point name/ID.
    if (!isNumeric(parts[0]) && parts.length >= 4) {
      name = parts[0];
      nums = parts.slice(1);
    }
    const x = Number(nums[0]);
    const y = Number(nums[1]);
    const z = Number(nums[2]);
    if (![x, y, z].every((v) => Number.isFinite(v))) continue;
    out.push({ name, x, y, z });
  }
  return out;
}

function isNumeric(s: string): boolean {
  return s !== "" && Number.isFinite(Number(s));
}

/** Build the full topographic surface (TIN + contours + stats) from points. */
export function buildSurface(points: XYZ[], interval: number): TopoSurface {
  if (points.length < 3) {
    throw new Error("need at least 3 levelled points to build a surface");
  }
  const tris = triangulate(points);
  if (tris.length === 0) {
    throw new Error("points are (near) collinear or degenerate — cannot triangulate a surface");
  }

  let minZ = Infinity,
    maxZ = -Infinity,
    sumZ = 0;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of points) {
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
    sumZ += p.z;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  let planArea = 0;
  for (const t of tris) planArea += triPlanArea(points[t.a], points[t.b], points[t.c]);

  const safeInterval = interval > 0 ? interval : suggestInterval(maxZ - minZ);
  const levels = contourLevels(minZ, maxZ, safeInterval);
  const contours = contourLines(points, tris, levels);

  return {
    points,
    triangles: tris,
    contours,
    interval: safeInterval,
    stats: {
      count: points.length,
      triangles: tris.length,
      minZ: round(minZ, 3),
      maxZ: round(maxZ, 3),
      meanZ: round(sumZ / points.length, 3),
      relief: round(maxZ - minZ, 3),
      planArea: round(planArea, 2),
      bounds: {
        minX: round(minX, 3),
        minY: round(minY, 3),
        maxX: round(maxX, 3),
        maxY: round(maxY, 3),
      },
    },
  };
}

/** A sensible default contour interval (~10 contours across the relief). */
export function suggestInterval(relief: number): number {
  if (!isFinite(relief) || relief <= 0) return 1;
  const rough = relief / 10;
  // Snap to a 1/2/5 x 10^n "nice" number.
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow;
  const nice = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  return Number((nice * pow).toFixed(6));
}
