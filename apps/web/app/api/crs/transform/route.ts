import { NextResponse } from "next/server";
import { round } from "@/lib/server/angles";
import { isGeographic, transformPoint } from "@/lib/server/crs";

export const dynamic = "force-dynamic";

/** Transform a batch of coordinate pairs between coordinate systems. */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const { src, dst, points } = body ?? {};
    const geographic = isGeographic(dst);
    const out = (points ?? []).map((p: any) => {
      const [a, b] = transformPoint(p.a, p.b, src, dst);
      return {
        name: p.name ?? null,
        a: round(a, geographic ? 8 : 3),
        b: round(b, geographic ? 8 : 3),
      };
    });
    return NextResponse.json({ src, dst, points: out });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
