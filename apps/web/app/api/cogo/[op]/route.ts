import { NextResponse } from "next/server";
import { formatDms, parseBearing, round } from "@/lib/server/angles";
import {
  areaHectares,
  circularCurve,
  forward,
  intersectBearingBearing,
  intersectBearingDistance,
  intersectDistanceDistance,
  inverse,
  perimeter,
  polygonArea,
  type Point,
} from "@/lib/server/geometry";
import { computeTraverse, type Leg } from "@/lib/server/traverse";

export const dynamic = "force-dynamic";

function point(p: { east: number; north: number; name?: string | null }): Point {
  return { east: p.east, north: p.north, name: p.name ?? null };
}

/** All COGO endpoints, dispatched by the [op] path segment. Mirrors the Python
 *  engine's main.py routes + their rounding so output is byte-compatible. */
export async function POST(req: Request, { params }: { params: { op: string } }) {
  const op = params.op;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    switch (op) {
      case "traverse":
        return NextResponse.json(handleTraverse(body));
      case "coordinates":
        return NextResponse.json(handleCoordinates(body));
      case "inverse":
        return NextResponse.json(handleInverse(body));
      case "forward":
        return NextResponse.json(handleForward(body));
      case "area":
        return NextResponse.json(handleArea(body));
      case "intersection":
        return NextResponse.json(handleIntersection(body));
      case "curve":
        return NextResponse.json(circularCurve(body.radius, body.deflection_deg));
      default:
        return NextResponse.json({ error: `unknown COGO operation: ${op}` }, { status: 404 });
    }
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

function handleTraverse(req: any) {
  const legs: Leg[] = (req.legs ?? []).map((l: any) => ({
    bearing: parseBearing(l.bearing),
    distance: l.distance,
    from_name: l.from_name ?? null,
    to_name: l.to_name ?? null,
  }));
  const result = computeTraverse(
    point(req.start),
    legs,
    req.type ?? "closed",
    req.adjustment ?? "bowditch",
    req.end_known ? point(req.end_known) : null
  );

  const c = result.closure;
  return {
    type: result.type,
    adjustment: result.adjustment,
    closure: {
      misclose_east: round(c.misclose_east, 4),
      misclose_north: round(c.misclose_north, 4),
      linear_misclosure: round(c.linear_misclosure, 4),
      total_distance: round(c.total_distance, 3),
      relative_precision: c.relative_precision,
      relative_precision_text: c.relative_precision_text,
    },
    area_m2: round(result.area_m2, 3),
    area_ha: round(result.area_ha, 4),
    points: result.points.map((p) => ({
      name: p.name ?? null,
      east: round(p.east, 3),
      north: round(p.north, 3),
    })),
    legs: result.legs.map((lg) => ({
      index: lg.index,
      from: lg.from_name,
      to: lg.to_name,
      bearing: round(lg.bearing, 6),
      bearing_dms: formatDms(lg.bearing),
      distance: round(lg.distance, 3),
      d_east_adj: round(lg.d_east_adj, 3),
      d_north_adj: round(lg.d_north_adj, 3),
    })),
    sigma0: round(result.sigma0, 5),
    residuals: result.residuals.map((r) => {
      const out: Record<string, unknown> = { leg: r.leg, from: r.from, to: r.to };
      for (const key of ["correction_east", "correction_north", "v_distance", "v_direction_sec", "magnitude"] as const) {
        if (r[key] !== undefined) out[key] = round(r[key] as number, 5);
      }
      return out;
    }),
  };
}

/** Build a figure directly from known point coordinates (no bearing/distance
 *  observations): inverse-compute each side + polygon area. Closure is exact
 *  because the coordinates are given. */
function handleCoordinates(req: any) {
  const pts: Point[] = (req.points ?? []).map(point);
  if (pts.length < 3) throw new Error("need at least 3 point coordinates to form a figure");
  const closed = (req.type ?? "closed") !== "open";
  const n = pts.length;
  const legCount = closed ? n : n - 1;
  const legs = [];
  for (let i = 0; i < legCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const [bearing, distance] = inverse(a, b);
    legs.push({
      index: i + 1,
      from: a.name ?? `P${i + 1}`,
      to: b.name ?? `P${((i + 1) % n) + 1}`,
      bearing: round(bearing, 6),
      bearing_dms: formatDms(bearing),
      distance: round(distance, 3),
      d_east_adj: round(b.east - a.east, 3),
      d_north_adj: round(b.north - a.north, 3),
    });
  }
  const area = closed ? Math.abs(polygonArea(pts)) : 0;
  // Flag a degenerate ring (collinear or duplicated points → zero enclosed area)
  // so the UI doesn't present it as a perfect "exact" figure.
  const degenerate = closed && pts.length >= 3 && area < 1e-6;
  return {
    type: closed ? "closed" : "open",
    adjustment: "none",
    closure: {
      misclose_east: 0,
      misclose_north: 0,
      linear_misclosure: 0,
      total_distance: round(perimeter(pts, closed), 3),
      relative_precision: null,
      relative_precision_text: degenerate
        ? "degenerate figure — zero enclosed area (check point order / duplicate or collinear points)"
        : "exact (from given coordinates)",
    },
    area_m2: round(area, 3),
    area_ha: round(area / 10_000, 4),
    points: pts.map((p) => ({ name: p.name ?? null, east: round(p.east, 3), north: round(p.north, 3) })),
    legs,
    sigma0: 0,
    residuals: [],
  };
}

function handleInverse(req: any) {
  const [bearing, distance] = inverse(point(req.from_point), point(req.to_point));
  return {
    bearing: round(bearing, 6),
    bearing_dms: formatDms(bearing),
    distance: round(distance, 4),
  };
}

function handleForward(req: any) {
  // Polar: new point from a start point, bearing and distance.
  const p = forward(point(req.from_point), parseBearing(req.bearing), Number(req.distance));
  return { east: round(p.east, 4), north: round(p.north, 4) };
}

function handleArea(req: any) {
  const pts: Point[] = (req.points ?? []).map(point);
  if (pts.length < 3) throw new Error("need at least 3 points");
  return {
    area_m2: round(Math.abs(polygonArea(pts)), 3),
    area_ha: round(areaHectares(pts), 4),
    perimeter: round(perimeter(pts), 3),
  };
}

function handleIntersection(req: any) {
  let p: Point;
  if (req.method === "bb") {
    p = intersectBearingBearing(point(req.a), parseBearing(req.bearing_a), point(req.b), parseBearing(req.bearing_b));
  } else if (req.method === "dd") {
    p = intersectDistanceDistance(point(req.a), req.radius_a, point(req.b), req.radius_b);
  } else if (req.method === "bd") {
    p = intersectBearingDistance(point(req.a), parseBearing(req.bearing_a), point(req.b), req.radius_b);
  } else {
    throw new Error(`unknown intersection method: ${req.method}`);
  }
  return { east: round(p.east, 4), north: round(p.north, 4) };
}
