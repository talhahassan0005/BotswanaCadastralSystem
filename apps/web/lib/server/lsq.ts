/**
 * Least-squares traverse adjustment (parametric / observation-equation method).
 * Ported from services/engine/app/cogo/lsq.py — numpy replaced with small,
 * self-contained matrix helpers (the systems here are tiny).
 *
 * Unknowns are the coordinates of the free stations. Each leg contributes a
 * distance and a direction observation, giving a closed/link traverse the
 * redundancy that least squares distributes optimally.
 */

import type { Point } from "./geometry";

export interface LsqResidual {
  leg: number;
  from: string | null;
  to: string | null;
  v_distance: number;
  v_direction_sec: number;
  magnitude: number;
}

export interface LsqResult {
  points: Point[];
  residuals: LsqResidual[];
  sigma0: number;
  iterations: number;
}

interface LsqLeg {
  bearing: number; // decimal degrees
  distance: number; // metres
  from_name?: string | null;
  to_name?: string | null;
}

function wrap(rad: number): number {
  while (rad > Math.PI) rad -= 2 * Math.PI;
  while (rad < -Math.PI) rad += 2 * Math.PI;
  return rad;
}

/** Solve a (square) linear system N·x = rhs via Gaussian elimination w/ partial
 *  pivoting. Near-singular pivots leave that unknown at 0 (graceful fallback). */
function solveLinear(N: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  // Augmented matrix copy.
  const a = N.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col++) {
    // Partial pivot.
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (Math.abs(a[pivot][col]) < 1e-15) continue; // singular column -> skip
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const div = a[col][col];
    for (let j = col; j <= n; j++) a[col][j] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r][col];
      if (factor === 0) continue;
      for (let j = col; j <= n; j++) a[r][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row[n]);
}

export function leastSquaresAdjust(
  start: Point,
  legs: LsqLeg[],
  provisional: Point[],
  closed: boolean,
  endKnown: Point | null,
  sigmaDist = 0.01,
  sigmaDirSec = 5.0
): LsqResult {
  const k = legs.length;
  const coords: [number, number][] = provisional.map((p) => [p.east, p.north]);

  const fixed = new Set<number>([0]);
  if (closed) {
    coords[k] = [start.east, start.north];
    fixed.add(k);
  } else if (endKnown !== null) {
    coords[k] = [endKnown.east, endKnown.north];
    fixed.add(k);
  }

  const free: number[] = [];
  for (let i = 0; i <= k; i++) if (!fixed.has(i)) free.push(i);
  const col = new Map<number, number>();
  free.forEach((st, j) => col.set(st, j));
  const u = 2 * free.length;

  if (u === 0) {
    const pts = coords.map((c, i) => ({ east: c[0], north: c[1], name: provisional[i].name }));
    return { points: pts, residuals: [], sigma0: 0, iterations: 0 };
  }

  const sigDir = (sigmaDirSec / 3600) * (Math.PI / 180);
  const wDist = 1 / (sigmaDist * sigmaDist);
  const wDir = 1 / (sigDir * sigDir);

  const m = 2 * k;
  let iterations = 0;
  let lastV = new Array(m).fill(0);
  const W = new Array(m).fill(0);

  for (let iter = 0; iter < 5; iter++) {
    iterations += 1;
    const A: number[][] = Array.from({ length: m }, () => new Array(u).fill(0));
    const l = new Array(m).fill(0);

    for (let i = 0; i < k; i++) {
      const a = i;
      const b = i + 1;
      const [ea, na] = coords[a];
      const [eb, nb] = coords[b];
      const de = eb - ea;
      const dn = nb - na;
      const d = Math.hypot(de, dn);
      if (d < 1e-9) continue;
      const az = Math.atan2(de, dn);

      // distance observation row
      const r = 2 * i;
      if (col.has(b)) {
        A[r][col.get(b)! * 2] = de / d;
        A[r][col.get(b)! * 2 + 1] = dn / d;
      }
      if (col.has(a)) {
        A[r][col.get(a)! * 2] = -de / d;
        A[r][col.get(a)! * 2 + 1] = -dn / d;
      }
      l[r] = legs[i].distance - d;
      W[r] = wDist;

      // direction observation row
      const rb = 2 * i + 1;
      if (col.has(b)) {
        A[rb][col.get(b)! * 2] = dn / (d * d);
        A[rb][col.get(b)! * 2 + 1] = -de / (d * d);
      }
      if (col.has(a)) {
        A[rb][col.get(a)! * 2] = -dn / (d * d);
        A[rb][col.get(a)! * 2 + 1] = de / (d * d);
      }
      l[rb] = wrap((legs[i].bearing * Math.PI) / 180 - az);
      W[rb] = wDir;
    }

    // N = AᵀWA, rhs = AᵀWl
    const Nmat: number[][] = Array.from({ length: u }, () => new Array(u).fill(0));
    const rhs = new Array(u).fill(0);
    for (let p = 0; p < u; p++) {
      for (let q = 0; q < u; q++) {
        let sum = 0;
        for (let rIdx = 0; rIdx < m; rIdx++) sum += A[rIdx][p] * W[rIdx] * A[rIdx][q];
        Nmat[p][q] = sum;
      }
      let rsum = 0;
      for (let rIdx = 0; rIdx < m; rIdx++) rsum += A[rIdx][p] * W[rIdx] * l[rIdx];
      rhs[p] = rsum;
    }

    const dx = solveLinear(Nmat, rhs);

    // apply corrections
    for (const st of free) {
      const j = col.get(st)!;
      coords[st] = [coords[st][0] + dx[j * 2], coords[st][1] + dx[j * 2 + 1]];
    }

    // last_v = A·dx - l
    lastV = new Array(m).fill(0);
    for (let rIdx = 0; rIdx < m; rIdx++) {
      let s = 0;
      for (let p = 0; p < u; p++) s += A[rIdx][p] * dx[p];
      lastV[rIdx] = s - l[rIdx];
    }

    if (Math.max(...dx.map(Math.abs)) < 1e-6) break;
  }

  const dof = Math.max(m - u, 1);
  let vtwv = 0;
  for (let i = 0; i < m; i++) vtwv += lastV[i] * (W[i] * lastV[i]);
  const sigma0 = Math.sqrt(vtwv / dof);

  const points = coords.map((c, i) => ({ east: c[0], north: c[1], name: provisional[i].name }));
  const residuals: LsqResidual[] = legs.map((leg, i) => ({
    leg: i + 1,
    from: leg.from_name ?? null,
    to: leg.to_name ?? null,
    v_distance: lastV[2 * i],
    v_direction_sec: ((lastV[2 * i + 1] * 180) / Math.PI) * 3600,
    magnitude: Math.abs(lastV[2 * i]),
  }));

  return { points, residuals, sigma0, iterations };
}
