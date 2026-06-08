import { NextResponse } from "next/server";
import {
  contourVolume,
  gridVolume,
  parseGrid,
  sectionVolume,
  surfaceVolume,
  type Section,
} from "@/lib/server/volume";
import { parseTopoPoints } from "@/lib/server/topo";
import type { XYZ } from "@/lib/server/delaunay";

export const dynamic = "force-dynamic";

function readPoints(src: any): XYZ[] {
  if (Array.isArray(src)) {
    return src
      .map((p: any) => ({
        name: p.name ?? null,
        x: Number(p.x ?? p.east),
        y: Number(p.y ?? p.north),
        z: Number(p.z ?? p.level),
      }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
  }
  if (typeof src === "string") return parseTopoPoints(src);
  return [];
}

/** Dispatch a volume computation by method. */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const method = body.method;
    switch (method) {
      case "surface": {
        const points = readPoints(body.points ?? body.text);
        const design = body.design || body.designText ? readPoints(body.design ?? body.designText) : undefined;
        return NextResponse.json(
          surfaceVolume({
            points,
            mode: body.mode === "surface" ? "surface" : "datum",
            datum: Number(body.datum) || 0,
            design,
          })
        );
      }
      case "section": {
        const sections: Section[] = (body.sections ?? []).map((s: any) => ({
          chainage: Number(s.chainage),
          cut: Number(s.cut) || 0,
          fill: Number(s.fill) || 0,
        }));
        return NextResponse.json(sectionVolume(sections));
      }
      case "grid": {
        const grid = Array.isArray(body.grid) ? body.grid : parseGrid(String(body.text ?? ""));
        return NextResponse.json(
          gridVolume({ grid, dx: Number(body.dx) || 0, dy: Number(body.dy) || 0 })
        );
      }
      case "contour": {
        const rows = (body.rows ?? []).map((r: any) => ({
          level: Number(r.level),
          area: Number(r.area) || 0,
        }));
        return NextResponse.json(contourVolume({ rows, topHeight: Number(body.topHeight) || 0 }));
      }
      default:
        return NextResponse.json({ error: `unknown volume method: ${method}` }, { status: 404 });
    }
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
