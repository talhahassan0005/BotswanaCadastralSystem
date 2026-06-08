import { NextResponse } from "next/server";
import { round } from "@/lib/server/angles";
import { buildSurface, parseTopoPoints } from "@/lib/server/topo";
import type { XYZ } from "@/lib/server/delaunay";

export const dynamic = "force-dynamic";

/** Build a topographic surface (TIN + contours + stats) from levelled points. */
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
        z: Number(p.z ?? p.level),
      }));
    } else if (typeof body.text === "string") {
      points = parseTopoPoints(body.text);
    } else {
      throw new Error("provide `points` (array) or `text` (CSV)");
    }
    points = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
    if (points.length < 3) throw new Error("need at least 3 levelled points with numeric E, N, RL");

    const interval = Number(body.interval) || 0;
    const surface = buildSurface(points, interval);

    // Round contour coordinates to keep the payload compact.
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
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
