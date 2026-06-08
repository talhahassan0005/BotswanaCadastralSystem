import { Router } from "express";
import { generateSurveyNarrative, groqAvailable } from "../groqClient.js";
import { runValidation } from "../utils/validate.js";

export const validateRouter = Router();

/**
 * Run rule-based validation, then (if a Groq key is set) layer an AI narrative
 * + submission note on top. Powers the AI Validate screen.
 */
validateRouter.post("/", async (req, res) => {
  const { closure, traverseType, dsmLimit, beaconNames, importRows, project } = req.body ?? {};

  const summary = runValidation({ closure, traverseType, dsmLimit, beaconNames, importRows });

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
  } catch (err: any) {
    narrative = `AI narrative unavailable: ${err.message}`;
  }

  res.json({ ...summary, narrative, aiSource, aiEngine: groqAvailable() });
});
