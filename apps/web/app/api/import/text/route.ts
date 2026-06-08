import { NextResponse } from "next/server";
import { parseSurveyCsv } from "@/lib/server/csv";

export const dynamic = "force-dynamic";

/** Parse raw text pasted into the UI (no file upload). */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { text } = body ?? {};
    if (typeof text !== "string") {
      return NextResponse.json({ error: "text required" }, { status: 400 });
    }
    return NextResponse.json({ filename: "pasted.csv", ...parseSurveyCsv(text) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
