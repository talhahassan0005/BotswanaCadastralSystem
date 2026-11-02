import { NextResponse } from "next/server";
import { round } from "@/lib/server/angles";
import { buildSurface, parseTopoPoints } from "@/lib/server/topo";
import { surfaceVolume } from "@/lib/server/volume";
import type { XYZ } from "@/lib/server/delaunay";

export const dynamic = "force-dynamic";

/**
 * Stockpile volume measurement + surface comparison (Engineering / Mining).
 *
 * Single-surface mode: auto-detects base datum, builds DSM TIN, returns
 * volume above datum + contours.
 *
 * Comparison mode (when `previous` text/points also provided): builds two
 * TINs and computes cut/fill between them — positive = material added (fill),
 * negative = material removed (cut). Returns per-triangle signed differences
 * for a colour-coded change map.
 */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    function readPoints(src: any): XYZ[] {
      if (Array.isArray(src)) {
        return src.map((p: any) => ({
          name: p.name ?? null,
          x: Number(p.x ?? p.east),
          y: Number(p.y ?? p.north),
          z: Number(p.z ?? p.rl ?? p.elev ?? p.elevation),
        })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
      }
      if (typeof src === "string") return parseTopoPoints(src);
      return [];
    }

    const points = readPoints(body.points ?? body.text);
    if (points.length < 3) throw new Error("need at least 3 XYZ points for current survey");

    const interval = Number(body.interval) || 0;
    const surface = buildSurface(points, interval);

    // ── Single-surface mode ──────────────────────────────────────────────────
    const autoMin = points.reduce((m, p) => (p.z < m ? p.z : m), Infinity);
    const datum = body.datum != null && Number.isFinite(Number(body.datum))
      ? Number(body.datum)
      : autoMin;

    const vol = surfaceVolume({ points, mode: "datum", datum });

    const sorted = [...points].sort((a, b) => b.z - a.z);
    const topPoint = sorted[0];
    const tolerance = 0.01;
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

    const base = {
      points: surface.points.map((p) => ({ name: p.name ?? null, x: round(p.x, 3), y: round(p.y, 3), z: round(p.z, 3) })),
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
    };

    // ── Comparison mode ──────────────────────────────────────────────────────
    const prevSrc = body.previous ?? body.previousText;
    if (!prevSrc) return NextResponse.json(base);

    const prevPoints = readPoints(prevSrc);
    if (prevPoints.length < 3) throw new Error("need at least 3 XYZ points for previous survey");

    // Compare current surface against previous surface (design = previous TIN).
    const comp = surfaceVolume({ points, mode: "surface", design: prevPoints });
    const prevSurface = buildSurface(prevPoints, interval);

    // Per-triangle signed difference for the change map.
    // faces[] from surfaceVolume carries {a,b,c,d} where d = signed avg diff.
    const faces = (comp.faces ?? []).map((f) => ({
      a: f.a, b: f.b, c: f.c,
      d: round(f.d, 3),
    }));

    return NextResponse.json({
      ...base,
      comparison: {
        // volume.ts sign: "cut" = existing ABOVE design (current > previous) = stockpile grew = fill/added
        //                "fill" = existing BELOW design (current < previous) = stockpile shrank = cut/removed
        fill_m3: round(comp.cut, 3),    // material ADDED since previous survey (current > previous)
        cut_m3: round(comp.fill, 3),    // material REMOVED since previous survey (current < previous)
        net_m3: round(comp.net, 3),     // net change = added - removed (positive = net gain)
        notes: comp.notes,
        previous: {
          points: prevSurface.points.map((p) => ({ name: p.name ?? null, x: round(p.x, 3), y: round(p.y, 3), z: round(p.z, 3) })),
          triangles: prevSurface.triangles,
          stats: prevSurface.stats,
          volume_m3: round(surfaceVolume({ points: prevPoints, mode: "datum", datum }).cut, 3),
        },
        faces,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
