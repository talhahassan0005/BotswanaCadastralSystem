import Groq from "groq-sdk";
import { config } from "./config.js";

const groq = config.groqApiKey ? new Groq({ apiKey: config.groqApiKey }) : null;

export function groqAvailable(): boolean {
  return groq !== null;
}

/**
 * Generate a plain-language survey QA narrative + submission note from the
 * computed closure/validation results. Used by the AI Validate screen.
 * Falls back gracefully if no API key is configured.
 */
export async function generateSurveyNarrative(input: {
  project: Record<string, unknown>;
  closure: Record<string, unknown>;
  checks: { rule: string; severity: string; message: string }[];
}): Promise<{ narrative: string; source: "groq" | "fallback" }> {
  const system =
    "You are a Botswana cadastral survey QA assistant. Write concise, professional " +
    "survey report notes for submission to the Department of Surveys and Mapping (DSM). " +
    "Reference the Land Survey Act where relevant. Be factual; do not invent figures.";

  const user = JSON.stringify(input, null, 2);

  if (!groq) {
    const errors = input.checks.filter((c) => c.severity === "error");
    const fallback =
      `Survey QA summary (offline mode — set GROQ_API_KEY for AI narratives).\n` +
      `Closure: ${input.closure.relative_precision_text ?? "n/a"}.\n` +
      (errors.length
        ? `Action needed: ${errors.map((e) => e.message).join("; ")}.`
        : `No blocking errors detected. Ready for review.`);
    return { narrative: fallback, source: "fallback" };
  }

  const completion = await groq.chat.completions.create({
    model: config.groqModel,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content:
          "Produce: (1) a 3-4 sentence survey summary, and (2) a clear 'Action needed' " +
          "line if any errors/warnings exist. Data:\n" + user,
      },
    ],
  });

  return {
    narrative: completion.choices[0]?.message?.content ?? "",
    source: "groq",
  };
}
