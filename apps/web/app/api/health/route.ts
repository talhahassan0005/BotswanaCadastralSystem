import { NextResponse } from "next/server";
import { groqAvailable } from "@/lib/server/narrative";

// Compute runs in-process (Next route handlers), so the engine is always
// available. `db` reflects whether the Supabase backend is configured.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    db: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)),
    engine: true,
    ai: groqAvailable(),
  });
}
