import { NextResponse } from "next/server";
import { parseSurveyCsv } from "@/lib/server/csv";

export const dynamic = "force-dynamic";

/** Upload a CSV/TXT file -> parsed + validated preview rows. */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "no file uploaded" }, { status: 400 });
    }
    const text = await file.text();
    return NextResponse.json({ filename: file.name, ...parseSurveyCsv(text) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
