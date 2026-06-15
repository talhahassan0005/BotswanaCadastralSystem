import { NextResponse } from "next/server";
import { generateSurveyNarrative, groqAvailable } from "@/lib/server/narrative";
import { runValidation } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

/**
 * Run rule-based validation, then (if GROQ_API_KEY is set) layer an AI narrative
 * on top. Powers the AI Validate screen.
 */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const { closure, traverseType, dsmLimit, beaconNames, importRows, parcelChecks, project } = body ?? {};
  const summary = runValidation({ closure, traverseType, dsmLimit, beaconNames, importRows, parcelChecks });

  let narrative = "";
  let aiSource: "groq" | "fallback" = "fallback";
  try {
    const out = await generateSurveyNarrative({
      project: project ?? {},
      closure: closure ?? {},
      checks: summary.checks.filter((c) => c.severity !== "pass"),
    });
    narrative = out.narrative;
    aiSource = out.source;
  } catch (err) {
    narrative = `AI narrative unavailable: ${(err as Error).message}`;
  }

  return NextResponse.json({ ...summary, narrative, aiSource, aiEngine: groqAvailable() });
}
