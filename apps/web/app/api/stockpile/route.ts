import { NextResponse } from "next/server";
import { round } from "@/lib/server/angles";
import { buildSurface, parseTopoPoints } from "@/lib/server/topo";
import { surfaceVolume } from "@/lib/server/volume";
import type { XYZ } from "@/lib/server/delaunay";

export const dynamic = "force-dynamic";

/**
 * Stockpile volume measurement (Engineering / Mining).
 * Accepts a CSV/array of XYZ points, auto-detects the base datum from the
 * lowest points, builds a TIN surface (DSM), derives a flat DTM at that
 * datum, computes bulk volume above the DTM, and returns TIN + contours.
 */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    let points: XYZ[];
    if (Array.isArray(body.points)) {
      points = body.points.map((p: any) => ({
        name: p.name ?? null,
        x: Number(p.x ?? p.east),
        y: Number(p.y ?? p.north),
        z: Number(p.z ?? p.rl ?? p.elev ?? p.elevation),
      }));
    } else if (typeof body.text === "string") {
      points = parseTopoPoints(body.text);
    } else {
      throw new Error("provide `points` (array) or `text` (CSV)");
    }

    points = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
    if (points.length < 3) throw new Error("need at least 3 XYZ points");

    const interval = Number(body.interval) || 0;

    // Build DSM (TIN over the full stockpile surface).
    const surface = buildSurface(points, interval);

    // Auto-detect base datum: minimum Z across all points (stockpile sits on
    // its lowest survey points). A manual override is accepted too.
    const autoMin = points.reduce((m, p) => (p.z < m ? p.z : m), Infinity);
    const datum = body.datum != null && Number.isFinite(Number(body.datum))
      ? Number(body.datum)
      : autoMin;

    // Bulk volume above datum plane.
    const vol = surfaceVolume({ points, mode: "datum", datum });

    // Identify top point (peak) and base points (at or near datum).
    const sorted = [...points].sort((a, b) => b.z - a.z);
    const topPoint = sorted[0];
    const tolerance = 0.01; // 1 cm band at base
    const basePoints = points
      .filter((p) => p.z <= datum + tolerance)
      .map((p) => ({ name: p.name, x: round(p.x, 3), y: round(p.y, 3), z: round(p.z, 3) }));

    const contours = surface.contours.map((c) => ({
      level: c.level,
      segments: c.segments.map((s) => [
        [round(s[0][0], 3), round(s[0][1], 3)],
        [round(s[1][0], 3), round(s[1][1], 3)],
      ]),
    }));

    return NextResponse.json({
      points: surface.points.map((p) => ({
        name: p.name ?? null,
        x: round(p.x, 3),
        y: round(p.y, 3),
        z: round(p.z, 3),
      })),
      triangles: surface.triangles,
      contours,
      interval: surface.interval,
      stats: surface.stats,
      datum: round(datum, 3),
      volume_m3: round(vol.cut, 3),
      baseArea_m2: round(surface.stats.planArea, 2),
      height_m: round(surface.stats.maxZ - datum, 3),
      topPoint: { name: topPoint.name, x: round(topPoint.x, 3), y: round(topPoint.y, 3), z: round(topPoint.z, 3) },
      basePoints,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
