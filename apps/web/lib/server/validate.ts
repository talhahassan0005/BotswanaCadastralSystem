/**
 * Rule-based survey validation. Produces the check cards shown on the AI
 * Validate screen. Ported verbatim from apps/api/src/utils/validate.ts.
 */

export interface Check {
  rule: string;
  severity: "pass" | "warning" | "error";
  message: string;
}

export interface ValidationSummary {
  checks: Check[];
  passed: number;
  warnings: number;
  errors: number;
  overallScore: number; // %
  dsmCompliant: boolean;
}

interface ValidateInput {
  closure?: {
    relative_precision?: number | null;
    relative_precision_text?: string;
    linear_misclosure?: number;
  };
  traverseType?: string; // closed | link | open
  dsmLimit?: number;
  beaconNames?: string[];
  importRows?: { status: string; issues: string[]; beaconId: string | null }[];
}

export function runValidation(input: ValidateInput): ValidationSummary {
  const checks: Check[] = [];
  const dsmLimit = input.dsmLimit ?? 3000;

  // 1. Traverse closure / relative precision vs DSM limit.
  if (input.closure) {
    const rp = input.closure.relative_precision;
    const linear = input.closure.linear_misclosure ?? 0;
    if (input.traverseType === "open") {
      checks.push({
        rule: "Traverse closure",
        severity: "pass",
        message: "Open traverse — closure tolerance check not applicable.",
      });
    } else if (rp == null) {
      checks.push({
        rule: "Traverse closure",
        severity: linear < 1e-6 ? "pass" : "error",
        message:
          linear < 1e-6
            ? "Exact closure — no linear misclosure detected."
            : `Misclosure ${linear.toFixed(3)} m with undefined precision; review observations.`,
      });
    } else if (rp >= dsmLimit) {
      const marginal = rp < dsmLimit * 1.5;
      checks.push({
        rule: "Traverse closure",
        severity: marginal ? "warning" : "pass",
        message: marginal
          ? `Precision ${input.closure.relative_precision_text} is within the DSM limit (1:${dsmLimit}) but marginal — re-check observations.`
          : `Precision ${input.closure.relative_precision_text} — within DSM limit of 1:${dsmLimit}.`,
      });
    } else {
      checks.push({
        rule: "Traverse closure",
        severity: "error",
        message: `Precision ${input.closure.relative_precision_text} exceeds DSM allowable closure (1:${dsmLimit}).`,
      });
    }
  }

  // 2. Duplicate beacon check.
  if (input.beaconNames?.length) {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const n of input.beaconNames) {
      if (seen.has(n)) dupes.add(n);
      seen.add(n);
    }
    checks.push(
      dupes.size
        ? {
            rule: "Duplicate beacon check",
            severity: "error",
            message: `Duplicate beacon IDs found: ${[...dupes].join(", ")}.`,
          }
        : {
            rule: "Duplicate beacon check",
            severity: "pass",
            message: `No duplicate beacon IDs across ${seen.size} beacons.`,
          }
    );
  }

  // 3. Import data integrity (missing coords, zero distances).
  if (input.importRows?.length) {
    const bad = input.importRows.filter((r) => r.status === "error");
    checks.push(
      bad.length
        ? {
            rule: "Observation integrity",
            severity: "error",
            message: `${bad.length} row(s) need fixing: ${bad.map((b) => b.beaconId ?? "?").join(", ")}.`,
          }
        : {
            rule: "Observation integrity",
            severity: "pass",
            message: "All imported observations have valid coordinates/distances.",
          }
    );
    // 3b. Rows flagged for review (non-fatal) → warning.
    const review = input.importRows.filter((r) => r.status === "check");
    if (review.length) {
      checks.push({
        rule: "Observation review",
        severity: "warning",
        message: `${review.length} row(s) flagged for review: ${review.map((r) => r.beaconId ?? "?").join(", ")}.`,
      });
    }
  }

  const passed = checks.filter((c) => c.severity === "pass").length;
  const warnings = checks.filter((c) => c.severity === "warning").length;
  const errors = checks.filter((c) => c.severity === "error").length;
  const total = checks.length || 1;
  const overallScore = Math.round((passed / total) * 100);

  return { checks, passed, warnings, errors, overallScore, dsmCompliant: errors === 0 };
}
