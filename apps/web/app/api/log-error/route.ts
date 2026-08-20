import { NextResponse } from "next/server";

// Client-side crash reporting (client req 2026-08-20): the app had no error
// boundary, so a client-side exception just showed Next.js's generic
// "Application error" screen with the real stack trace lost — visible only
// in a browser console the client never opens. error.tsx/global-error.tsx
// POST the crash details here so they land in Vercel's function logs
// (`vercel logs`, or the Logs tab on the deployment), where we can actually
// read them next time it happens.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    console.error("[client-crash]", JSON.stringify(body));
  } catch {
    // Malformed payload — nothing useful to log, still ack so the client
    // error page doesn't itself throw.
  }
  return NextResponse.json({ ok: true });
}
