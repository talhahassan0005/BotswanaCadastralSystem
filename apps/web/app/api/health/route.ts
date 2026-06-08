import { NextResponse } from "next/server";
import { groqAvailable } from "@/lib/server/narrative";

// Compute now runs in-process (Next route handlers), so the engine is always
// available. There is no database in the serverless deployment.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    db: false,
    engine: true,
    ai: groqAvailable(),
  });
}
