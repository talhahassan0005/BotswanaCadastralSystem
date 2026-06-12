"use client";

import { useState } from "react";
import { apiJson } from "@/lib/api";
import { useStore } from "@/lib/store";
import type { ValidationResult } from "@/lib/types";
import { Badge, Button, Card, Stat } from "@/components/ui";

export function AiValidate() {
  const { cogoResult, importResult, config, validation, setValidation } = useStore();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setError(null);
    setRunning(true);
    try {
      const beaconNames = importResult?.rows.map((r) => r.beaconId).filter(Boolean) as string[];
      const result = await apiJson<ValidationResult>("/validate", {
        closure: cogoResult?.closure,
        traverseType: cogoResult?.type,
        dsmLimit: config.dsmLimit,
        beaconNames,
        importRows: importResult?.rows.map((r) => ({
          status: r.status,
          issues: r.issues,
          beaconId: r.beaconId,
        })),
        project: { name: config.name, surveyor: config.surveyor, crs: config.coordinateSystem },
      });
      setValidation(result);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-700">Survey QA &amp; DSM compliance</h2>
        <Button onClick={run} disabled={running}>
          {running ? "Validating…" : "Run AI Validation"}
        </Button>
      </div>
      {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {!validation ? (
        <Card>
          <div className="py-12 text-center text-slate-400">
            Run the COGO computation, then validate to produce DSM compliance checks and an
            AI-generated survey report.
          </div>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            <Stat value={`${validation.overallScore}%`} label="Overall score" tone="brand" />
            <Stat value={validation.passed} label="Checks passed" tone="brand" />
            <Stat value={validation.warnings} label="Warnings" tone="warning" />
            <Stat value={validation.errors} label="Errors" tone={validation.errors ? "error" : "default"} />
            <Stat value={validation.dsmCompliant ? "DSM" : "—"} label={validation.dsmCompliant ? "Compliant" : "Not compliant"} tone="brand" />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {validation.checks.map((chk, i) => (
              <Card key={i} title={chk.rule}>
                <p className="mb-3 text-sm text-slate-600">{chk.message}</p>
                <Badge kind={chk.severity}>
                  {chk.severity === "pass" ? "Passed" : chk.severity === "warning" ? "Warning" : "Error — fix required"}
                </Badge>
              </Card>
            ))}
          </div>

          <Card title="Auto-generated survey report">
            <p className="mb-2 text-xs text-slate-400">
              Source: {validation.aiSource === "groq" ? "Groq AI" : "offline fallback"}
              {validation.aiEngine ? " · AI engine active" : " · set GROQ_API_KEY to enable AI"}
            </p>
            <pre className="whitespace-pre-wrap rounded-lg bg-slate-50 p-4 text-sm text-slate-700">
              {validation.narrative}
            </pre>
          </Card>
        </>
      )}
    </div>
  );
}
