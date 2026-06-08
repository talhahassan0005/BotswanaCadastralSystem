/**
 * Delaunay triangulation + TIN surface helpers (Module: Topographic / Volume).
 * Pure TypeScript — runs in a Vercel serverless function, no native deps.
 *
 * Builds a triangulated irregular network (TIN) from scattered (x, y, z) survey
 * points via the Bowyer–Watson incremental algorithm, then exposes the geometry
 * used by contouring (marching triangles) and TIN volumes (prism integration).
 *
 * Coordinate convention follows the rest of the app: x = Easting, y = Northing,
 * z = reduced level (elevation), all in metres.
 */

export interface XYZ {
  x: number;
  y: number;
  z: number;
  name?: string | null;
}

/** A triangle as three indices into the source point array. */
export interface Tri {
  a: number;
  b: number;
  c: number;
}

interface XY {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// In-circle predicate
// ---------------------------------------------------------------------------
/**
 * True if point p lies strictly inside the circumcircle of triangle (a,b,c).
 * Orientation-independent: the determinant sign is corrected by the triangle's
 * signed area so vertices may be supplied either CW or CCW.
 */
function inCircumcircle(p: XY, a: XY, b: XY, c: XY): boolean {
  const ax = a.x - p.x,
    ay = a.y - p.y;
  const bx = b.x - p.x,
    by = b.y - p.y;
  const cx = c.x - p.x,
    cy = c.y - p.y;
  const aSq = ax * ax + ay * ay;
  const bSq = bx * bx + by * by;
  const cSq = cx * cx + cy * cy;
  const det =
    ax * (by * cSq - bSq * cy) - ay * (bx * cSq - bSq * cx) + aSq * (bx * cy - by * cx);
  const orient = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return orient > 0 ? det > 0 : det < 0;
}

/**
 * Deterministic sub-nanometre offset in [0, 1e-9). Applied to the normalised
 * working coordinates to break exact cocircular ties (e.g. radial survey fans),
 * which a strict in-circle predicate would otherwise resolve inconsistently —
 * leaving holes or overlapping triangles in the mesh. Deterministic so results
 * are reproducible (no Math.random / Date).
 */
function jitter(seed: number): number {
  const v = ((seed * 9301 + 49297) % 233280 + 233280) % 233280;
  return (v / 233280) * 1e-9;
}

/** Boundary edges of the insertion cavity = edges that appear exactly once. */
function boundaryEdges(edges: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < edges.length; i++) {
    let shared = false;
    for (let j = 0; j < edges.length; j++) {
      if (i === j) continue;
      const [a, b] = edges[i];
      const [c, d] = edges[j];
      if ((a === c && b === d) || (a === d && b === c)) {
        shared = true;
        break;
      }
    }
    if (!shared) out.push(edges[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bowyer–Watson triangulation
// ---------------------------------------------------------------------------
/**
 * Delaunay-triangulate the planar projection of `points`. Returns triangles as
 * index triples into the original `points` array. Duplicate (x, y) locations are
 * ignored (first occurrence wins) so coincident shots don't break the mesh.
 */
export function triangulate(points: XYZ[]): Tri[] {
  const n = points.length;
  if (n < 3) return [];

  // De-duplicate by planar location; keep an index map back to originals.
  const uniq: XY[] = [];
  const back: number[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const key = `${points[i].x.toFixed(4)}:${points[i].y.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.set(key, uniq.length);
    back.push(i);
    uniq.push({ x: points[i].x, y: points[i].y });
  }
  const m = uniq.length;
  if (m < 3) return [];

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of uniq) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const dx = maxX - minX || 1;
  const dy = maxY - minY || 1;
  const dmax = Math.max(dx, dy);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  // Working vertices in a NORMALISED, jittered space — topology only. All area /
  // interpolation maths uses the original points[] via `back`, so this never
  // changes computed areas, volumes or contours. Normalising to a unit-scale box
  // keeps the in-circle determinant well-conditioned for large survey grids
  // (E~10⁵, N~10⁶); the deterministic jitter breaks exact cocircular ties.
  const verts: XY[] = uniq.map((p, i) => ({
    x: (p.x - midX) / dmax + jitter(2 * i),
    y: (p.y - midY) / dmax + jitter(2 * i + 1),
  }));
  const s0 = m,
    s1 = m + 1,
    s2 = m + 2;
  // Super-triangle in normalised space — points live in ≈[-0.5, 0.5]².
  verts.push({ x: -32, y: -32 });
  verts.push({ x: 0, y: 32 });
  verts.push({ x: 32, y: -32 });

  let tris: Tri[] = [{ a: s0, b: s1, c: s2 }];

  for (let i = 0; i < m; i++) {
    const p = verts[i];
    const edges: [number, number][] = [];
    const keep: Tri[] = [];
    for (const t of tris) {
      if (inCircumcircle(p, verts[t.a], verts[t.b], verts[t.c])) {
        edges.push([t.a, t.b], [t.b, t.c], [t.c, t.a]);
      } else {
        keep.push(t);
      }
    }
    tris = keep;
    for (const [u, v] of boundaryEdges(edges)) {
      tris.push({ a: u, b: v, c: i });
    }
  }

  // Drop triangles touching the super-triangle, and re-map to original indices.
  const out: Tri[] = [];
  for (const t of tris) {
    if (t.a >= m || t.b >= m || t.c >= m) continue;
    out.push({ a: back[t.a], b: back[t.b], c: back[t.c] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Triangle geometry
// ---------------------------------------------------------------------------
/** Plan (horizontal) area of a triangle, always positive. */
export function triPlanArea(a: XYZ, b: XYZ, c: XYZ): number {
  return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
}

/** Barycentric weights of (px,py) w.r.t. triangle (a,b,c); null if degenerate. */
function bary(a: XYZ, b: XYZ, c: XYZ, px: number, py: number): [number, number, number] | null {
  const denom = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  if (Math.abs(denom) < 1e-12) return null;
  const wa = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) / denom;
  const wb = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) / denom;
  const wc = 1 - wa - wb;
  return [wa, wb, wc];
}

/**
 * Interpolate the TIN surface elevation at (px, py). Returns null if the point
 * falls outside every triangle (i.e. outside the convex hull of the data).
 */
export function interpolateZ(points: XYZ[], tris: Tri[], px: number, py: number): number | null {
  for (const t of tris) {
    const a = points[t.a],
      b = points[t.b],
      c = points[t.c];
    const w = bary(a, b, c, px, py);
    if (!w) continue;
    const eps = -1e-9;
    if (w[0] >= eps && w[1] >= eps && w[2] >= eps) {
      return w[0] * a.z + w[1] * b.z + w[2] * c.z;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Contouring (marching triangles)
// ---------------------------------------------------------------------------
export interface ContourLevel {
  level: number;
  segments: [[number, number], [number, number]][];
}

/**
 * Extract contour line segments from the TIN at the given levels. Each triangle
 * contributes at most one segment per level (linear interpolation on the two
 * crossed edges). Levels are nudged by a hair to avoid degenerate vertex hits.
 */
export function contourLines(points: XYZ[], tris: Tri[], levels: number[]): ContourLevel[] {
  const out: ContourLevel[] = [];
  for (const raw of levels) {
    // Offset so a contour never sits exactly on a vertex elevation.
    const level = raw + 1e-6;
    const segments: [[number, number], [number, number]][] = [];
    for (const t of tris) {
      const vs = [points[t.a], points[t.b], points[t.c]];
      const crossings: [number, number][] = [];
      for (let e = 0; e < 3; e++) {
        const p1 = vs[e];
        const p2 = vs[(e + 1) % 3];
        const d1 = p1.z - level;
        const d2 = p2.z - level;
        if (d1 * d2 < 0) {
          const f = d1 / (d1 - d2);
          crossings.push([p1.x + f * (p2.x - p1.x), p1.y + f * (p2.y - p1.y)]);
        }
      }
      if (crossings.length === 2) segments.push([crossings[0], crossings[1]]);
    }
    if (segments.length) out.push({ level: raw, segments });
  }
  return out;
}

/** Contour levels at `interval` spacing spanning [minZ, maxZ], snapped to the interval. */
export function contourLevels(minZ: number, maxZ: number, interval: number): number[] {
  if (interval <= 0 || !isFinite(interval)) return [];
  const start = Math.ceil(minZ / interval) * interval;
  const levels: number[] = [];
  for (let z = start; z <= maxZ + 1e-9; z += interval) {
    levels.push(Number(z.toFixed(6)));
    if (levels.length > 10000) break; // guard against absurd intervals
  }
  return levels;
}
