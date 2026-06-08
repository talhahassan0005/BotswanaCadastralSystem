/**
 * Survey QA narrative generation. Mirrors apps/api/src/groqClient.ts but calls
 * Groq's OpenAI-compatible REST endpoint directly via fetch, so the web app
 * needs no extra dependency. Falls back gracefully when GROQ_API_KEY is unset.
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export function groqAvailable(): boolean {
  return Boolean(process.env.GROQ_API_KEY);
}

interface NarrativeInput {
  project: Record<string, unknown>;
  closure: Record<string, unknown>;
  checks: { rule: string; severity: string; message: string }[];
}

export async function generateSurveyNarrative(
  input: NarrativeInput
): Promise<{ narrative: string; source: "groq" | "fallback" }> {
  const key = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

  if (!key) {
    const errors = input.checks.filter((c) => c.severity === "error");
    const fallback =
      `Survey QA summary (offline mode — set GROQ_API_KEY for AI narratives).\n` +
      `Closure: ${(input.closure.relative_precision_text as string) ?? "n/a"}.\n` +
      (errors.length
        ? `Action needed: ${errors.map((e) => e.message).join("; ")}.`
        : `No blocking errors detected. Ready for review.`);
    return { narrative: fallback, source: "fallback" };
  }

  const system =
    "You are a Botswana cadastral survey QA assistant. Write concise, professional " +
    "survey report notes for submission to the Department of Surveys and Mapping (DSM). " +
    "Reference the Land Survey Act where relevant. Be factual; do not invent figures.";

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content:
            "Produce: (1) a 3-4 sentence survey summary, and (2) a clear 'Action needed' " +
            "line if any errors/warnings exist. Data:\n" +
            JSON.stringify(input, null, 2),
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Groq request failed (${res.status})`);
  }

  const data = await res.json();
  return { narrative: data.choices?.[0]?.message?.content ?? "", source: "groq" };
}
