/**
 * Earthwork volume computations (Module: Volume).
 *
 * Four independent, surveyor-standard methods:
 *   1. surface  — TIN prism integration of an existing surface against a datum
 *                 level or a design surface (cut & fill, stockpiles).
 *   2. section  — average-end-area + prismoidal (Simpson) from cross-sections.
 *   3. grid     — borrow-pit method from a regular grid of cut/fill depths.
 *   4. contour  — contour-area method (volume between successive contour rings).
 *
 * Sign convention (consistent across methods): a positive height difference
 *   d = z_existing - z_reference  means the ground is ABOVE the reference, i.e.
 *   material to be removed = CUT. A negative d means a hollow to be raised = FILL.
 * Reported `cut` and `fill` are both positive volumes (m³); net = cut - fill
 * (positive net = surplus / excess excavated material).
 */

import {
  interpolateZ,
  triangulate,
  triPlanArea,
  type Tri,
  type XYZ,
} from "./delaunay";
import { round } from "./angles";

export interface VolumeBreakdown {
  label: string;
  value: number;
}

export interface VolumeResult {
  method: "surface" | "section" | "grid" | "contour";
  cut: number;
  fill: number;
  net: number;
  /** Prismoidal (Simpson) refinement where the geometry allows it. */
  prismoidalCut?: number | null;
  prismoidalFill?: number | null;
  breakdown: VolumeBreakdown[];
  notes: string[];
  /** Per-triangle differences for the cut/fill plot (surface method only). */
  faces?: { a: number; b: number; c: number; d: number }[];
  points?: XYZ[];
  datum?: number;
}

// ===========================================================================
// 1. SURFACE / TIN  (exact prism integration of a piecewise-linear surface)
// ===========================================================================

interface DPoly {
  x: number;
  y: number;
  d: number;
}

/** Sutherland–Hodgman clip of a triangle to the half-plane sign*d >= 0. */
function clipBySign(poly: DPoly[], sign: number): DPoly[] {
  const out: DPoly[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % n];
    const curIn = sign * cur.d >= 0;
    const nxtIn = sign * nxt.d >= 0;
    if (curIn) out.push(cur);
    if (curIn !== nxtIn) {
      const f = cur.d / (cur.d - nxt.d); // parameter where d = 0
      out.push({
        x: cur.x + f * (nxt.x - cur.x),
        y: cur.y + f * (nxt.y - cur.y),
        d: 0,
      });
    }
  }
  return out;
}

/**
 * Integral of the (linear) height-difference d over a convex polygon, by fan
 * triangulation: ∫d dA = Σ |Aᵢ| · (d₀+d₁+d₂)/3. Exact because d is affine and
 * each sub-triangle's mean equals the average of its vertex values.
 */
function integratePoly(poly: DPoly[]): number {
  if (poly.length < 3) return 0;
  let s = 0;
  for (let i = 1; i < poly.length - 1; i++) {
    const a = poly[0],
      b = poly[i],
      c = poly[i + 1];
    const area = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
    s += area * ((a.d + b.d + c.d) / 3);
  }
  return s;
}

/** Cut/fill for one triangle whose vertices carry signed differences d0,d1,d2. */
function trianglePrism(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  d0: number,
  d1: number,
  d2: number
): { cut: number; fill: number } {
  const poly: DPoly[] = [
    { x: p0.x, y: p0.y, d: d0 },
    { x: p1.x, y: p1.y, d: d1 },
    { x: p2.x, y: p2.y, d: d2 },
  ];
  const cut = integratePoly(clipBySign(poly, +1)); // region d >= 0
  const fill = -integratePoly(clipBySign(poly, -1)); // region d <= 0 (integral <= 0)
  return { cut, fill };
}

export interface SurfaceVolumeInput {
  points: XYZ[];
  /** "datum": compare to a horizontal level; "surface": compare to a design TIN. */
  mode: "datum" | "surface";
  datum?: number;
  design?: XYZ[];
}

export function surfaceVolume(input: SurfaceVolumeInput): VolumeResult {
  const { points, mode } = input;
  if (points.length < 3) throw new Error("need at least 3 points for a TIN surface");
  const tris = triangulate(points);
  if (tris.length === 0) throw new Error("points are (near) collinear or degenerate — cannot form a surface");

  // Reference elevation at an existing vertex.
  let refAt: (p: XYZ) => number | null;
  const notes: string[] = [];
  let datumLevel: number | undefined;

  if (mode === "surface") {
    const design = input.design ?? [];
    if (design.length < 3) throw new Error("design surface needs at least 3 points");
    const dTris = triangulate(design);
    refAt = (p) => interpolateZ(design, dTris, p.x, p.y);
    notes.push("Cut/fill computed between the existing TIN and the design TIN.");
  } else {
    datumLevel = input.datum ?? 0;
    refAt = () => datumLevel!;
    notes.push(`Volumes computed against a horizontal datum at RL ${datumLevel}.`);
    notes.push("Stockpile volume = CUT (material above the base level).");
  }

  let cut = 0,
    fill = 0,
    skipped = 0;
  const faces: { a: number; b: number; c: number; d: number }[] = [];

  for (const t of tris) {
    const A = points[t.a],
      B = points[t.b],
      C = points[t.c];
    const ra = refAt(A),
      rb = refAt(B),
      rc = refAt(C);
    if (ra == null || rb == null || rc == null) {
      skipped++;
      continue;
    }
    const d0 = A.z - ra,
      d1 = B.z - rb,
      d2 = C.z - rc;
    const { cut: tc, fill: tf } = trianglePrism(A, B, C, d0, d1, d2);
    cut += tc;
    fill += tf;
    faces.push({ a: t.a, b: t.b, c: t.c, d: round((d0 + d1 + d2) / 3, 3) });
  }

  if (skipped > 0) {
    notes.push(`${skipped} triangle(s) skipped — outside the design surface extent.`);
  }

  return {
    method: "surface",
    cut: round(cut, 2),
    fill: round(fill, 2),
    net: round(cut - fill, 2),
    breakdown: [
      { label: "Cut (above reference)", value: round(cut, 2) },
      { label: "Fill (below reference)", value: round(fill, 2) },
      { label: "Net (cut − fill)", value: round(cut - fill, 2) },
    ],
    notes,
    faces,
    points,
    datum: datumLevel,
  };
}

// ===========================================================================
// 2. CROSS-SECTION  (average end area + prismoidal / Simpson)
// ===========================================================================

export interface Section {
  chainage: number;
  cut: number; // cut area (m²)
  fill: number; // fill area (m²)
}

export function sectionVolume(sections: Section[]): VolumeResult {
  if (sections.some((v) => !Number.isFinite(v.chainage) || !Number.isFinite(v.cut) || !Number.isFinite(v.fill)))
    throw new Error("every section needs a numeric chainage, cut and fill area");
  const s = [...sections].sort((a, b) => a.chainage - b.chainage);
  if (s.length < 2) throw new Error("need at least 2 cross-sections");

  // Average end area between consecutive sections.
  let cut = 0,
    fill = 0;
  const breakdown: VolumeBreakdown[] = [];
  for (let i = 0; i < s.length - 1; i++) {
    const L = s[i + 1].chainage - s[i].chainage;
    if (!(L > 0)) throw new Error("chainages must be strictly increasing");
    const vc = (L / 2) * (s[i].cut + s[i + 1].cut);
    const vf = (L / 2) * (s[i].fill + s[i + 1].fill);
    cut += vc;
    fill += vf;
    breakdown.push({
      label: `Ch ${s[i].chainage}–${s[i + 1].chainage} (cut/fill)`,
      value: round(vc - vf, 2),
    });
  }

  // Prismoidal via Simpson's 1/3 rule — needs equal spacing & an odd count.
  let prismoidalCut: number | null = null;
  let prismoidalFill: number | null = null;
  const notes: string[] = ["Average-end-area method (V = L/2·(A₁+A₂))."];
  const spacing = s[1].chainage - s[0].chainage;
  const equal = s.every((v, i) => i === 0 || Math.abs(v.chainage - s[i - 1].chainage - spacing) < 1e-6);
  if (equal && s.length >= 3 && s.length % 2 === 1) {
    prismoidalCut = simpson(s.map((v) => v.cut), spacing);
    prismoidalFill = simpson(s.map((v) => v.fill), spacing);
    notes.push("Prismoidal (Simpson's rule) applied — equal spacing, odd # of sections.");
  } else {
    notes.push("Prismoidal needs equal spacing and an odd number of sections.");
  }

  return {
    method: "section",
    cut: round(cut, 2),
    fill: round(fill, 2),
    net: round(cut - fill, 2),
    prismoidalCut: prismoidalCut == null ? null : round(prismoidalCut, 2),
    prismoidalFill: prismoidalFill == null ? null : round(prismoidalFill, 2),
    breakdown,
    notes,
  };
}

/** Simpson's 1/3 rule over equally spaced ordinates (odd count, n-1 even). */
function simpson(y: number[], h: number): number {
  const n = y.length - 1; // intervals
  let s = y[0] + y[n];
  for (let i = 1; i < n; i++) s += y[i] * (i % 2 === 1 ? 4 : 2);
  return (h / 3) * s;
}

// ===========================================================================
// 3. GRID / BORROW-PIT  (regular grid of cut/fill depths)
// ===========================================================================

export interface GridVolumeInput {
  grid: number[][]; // depths: +ve = cut (ground above design), -ve = fill
  dx: number; // cell size in Easting (m)
  dy: number; // cell size in Northing (m)
}

export function gridVolume(input: GridVolumeInput): VolumeResult {
  const { grid, dx, dy } = input;
  const rows = grid.length;
  if (rows < 2) throw new Error("grid needs at least 2 rows");
  const cols = grid[0].length;
  if (cols < 2) throw new Error("grid needs at least 2 columns");
  if (!grid.every((r) => r.length === cols)) throw new Error("all grid rows must have equal length");
  if (!grid.every((r) => r.every((v) => Number.isFinite(v)))) throw new Error("grid contains a non-numeric value");
  if (!(dx > 0) || !(dy > 0)) throw new Error("cell sizes must be positive");

  const cellArea = dx * dy;
  let cut = 0,
    fill = 0;
  // Per-cell average of the 4 corner depths × cell area (standard borrow-pit).
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const avg = (grid[r][c] + grid[r][c + 1] + grid[r + 1][c] + grid[r + 1][c + 1]) / 4;
      const v = avg * cellArea;
      if (v >= 0) cut += v;
      else fill += -v;
    }
  }

  return {
    method: "grid",
    cut: round(cut, 2),
    fill: round(fill, 2),
    net: round(cut - fill, 2),
    breakdown: [
      { label: "Cells", value: (rows - 1) * (cols - 1) },
      { label: "Cell area (m²)", value: round(cellArea, 2) },
      { label: "Net (cut − fill)", value: round(cut - fill, 2) },
    ],
    notes: [
      "Borrow-pit method: each cell volume = mean of its 4 corner depths × cell area.",
      "Depth sign: +ve = cut (ground above design), −ve = fill.",
    ],
  };
}

// ===========================================================================
// 4. CONTOUR-AREA  (volume between successive contour rings)
// ===========================================================================

export interface ContourRow {
  level: number;
  area: number; // plan area enclosed by this contour (m²)
}

export interface ContourVolumeInput {
  rows: ContourRow[];
  /** Optional height of the summit above the highest contour (cone cap). */
  topHeight?: number;
}

export function contourVolume(input: ContourVolumeInput): VolumeResult {
  if (input.rows.some((r) => !Number.isFinite(r.level) || !Number.isFinite(r.area)))
    throw new Error("every contour needs a numeric level and area");
  const rows = [...input.rows].sort((a, b) => a.level - b.level);
  if (rows.length < 2) throw new Error("need at least 2 contours");

  let trap = 0;
  const breakdown: VolumeBreakdown[] = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const h = rows[i + 1].level - rows[i].level;
    if (!(h > 0)) throw new Error("contour levels must be strictly increasing");
    const v = (h / 2) * (rows[i].area + rows[i + 1].area);
    trap += v;
    breakdown.push({ label: `RL ${rows[i].level}–${rows[i + 1].level}`, value: round(v, 2) });
  }

  const notes: string[] = ["Trapezoidal rule between contour areas (V = Δh/2·(A₁+A₂))."];

  // Optional conical cap above the top contour.
  if (input.topHeight && input.topHeight > 0) {
    const cap = (input.topHeight * rows[rows.length - 1].area) / 3;
    trap += cap;
    breakdown.push({ label: "Top cap (cone)", value: round(cap, 2) });
    notes.push(`Conical cap added above RL ${rows[rows.length - 1].level}.`);
  }

  // Prismoidal (Simpson) when contour intervals are equal and count is odd.
  let prismoidal: number | null = null;
  const interval = rows[1].level - rows[0].level;
  const equal = rows.every((v, i) => i === 0 || Math.abs(v.level - rows[i - 1].level - interval) < 1e-6);
  if (equal && rows.length >= 3 && rows.length % 2 === 1) {
    prismoidal = simpson(rows.map((v) => v.area), interval);
    notes.push("Prismoidal (Simpson's rule) also computed — equal interval, odd # of contours.");
  }

  return {
    method: "contour",
    cut: round(trap, 2),
    fill: 0,
    net: round(trap, 2),
    prismoidalCut: prismoidal == null ? null : round(prismoidal, 2),
    prismoidalFill: null,
    breakdown,
    notes,
  };
}

/** Parse a whitespace/comma grid of numbers into a 2-D array (for grid method). */
export function parseGrid(text: string): number[][] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(/[,\t ]+/).filter(Boolean).map(Number));
}
