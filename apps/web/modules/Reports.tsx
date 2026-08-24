"use client";

import { useMemo } from "react";
import { useStore } from "@/lib/store";
import { Button, Card, Stat } from "@/components/ui";
import type { ParcelDoc } from "@/lib/types";

function downloadText(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Reports hub (client req 2026-08-26): one dedicated tab to download the
 *  AI Validate data-consistency results and the project's coordinate list,
 *  instead of the consistency report having no download at all and the
 *  coordinate list only being reachable from the File-menu Export screen. */
export function Reports() {
  const { cogoResult, parcelDoc, importResult, validation, config, setActiveTab } = useStore();

  const coords = useMemo(() => {
    if (cogoResult?.points?.length) return cogoResult.points.map((p) => ({ id: p.name ?? "", e: p.east, n: p.north }));
    const pd = parcelDoc as ParcelDoc | null;
    if (pd?.beacons?.length) return pd.beacons.map((b) => ({ id: b.id, e: b.east, n: b.north }));
    if (importResult?.rows?.length)
      return importResult.rows
        .filter((r) => r.east != null && r.north != null)
        .map((r) => ({ id: r.beaconId ?? "", e: r.east as number, n: r.north as number }));
    return [];
  }, [cogoResult, parcelDoc, importResult]);

  const baseName = (config.name || "survey").replace(/\s+/g, "_");

  function downloadCoordinateList() {
    const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const header = "Beacon,East,North";
    const body = coords.map((c) => `${cell(String(c.id))},${c.e.toFixed(3)},${c.n.toFixed(3)}`).join("\n");
    downloadText(`${baseName}_coordinates.csv`, `${header}\n${body}\n`, "text/csv");
  }

  function downloadConsistencyReport() {
    if (!validation) return;
    const lines = [
      `DATA CONSISTENCY REPORT — ${config.name || "Untitled Survey"}`,
      `Surveyor: ${config.surveyor || "—"}`,
      `Coordinate system: ${config.coordinateSystem}`,
      "",
      `Overall score: ${validation.overallScore}%`,
      `Checks passed: ${validation.passed}`,
      `Warnings: ${validation.warnings}`,
      `Errors: ${validation.errors}`,
      `DSM compliant: ${validation.dsmCompliant ? "Yes" : "No"}`,
      "",
      "CHECKS",
      ...validation.checks.map((c) => `  [${c.severity.toUpperCase()}] ${c.rule} — ${c.message}`),
      "",
      "NARRATIVE",
      validation.narrative,
    ];
    downloadText(`${baseName}_data_consistency.txt`, lines.join("\n"), "text/plain");
  }

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-slate-700">Reports</h2>

      <Card title="Data consistency">
        {!validation ? (
          <p className="py-8 text-center text-sm text-slate-400">
            No validation has been run yet. Go to{" "}
            <button className="text-brand underline" onClick={() => setActiveTab("validate")}>
              AI Validate
            </button>{" "}
            first, then come back here to download the report.
          </p>
        ) : (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Stat value={`${validation.overallScore}%`} label="Overall score" tone="brand" />
              <Stat value={validation.passed} label="Checks passed" tone="brand" />
              <Stat value={validation.warnings} label="Warnings" tone="warning" />
              <Stat value={validation.errors} label="Errors" tone={validation.errors ? "error" : "default"} />
              <Stat
                value={validation.dsmCompliant ? "DSM" : "—"}
                label={validation.dsmCompliant ? "Compliant" : "Not compliant"}
                tone="brand"
              />
            </div>
            <Button onClick={downloadConsistencyReport}>⬇ Download Data Consistency Report</Button>
          </>
        )}
      </Card>

      <Card title="Coordinate list">
        <p className="mb-3 text-sm text-slate-500">
          {coords.length} coordinate(s) available
          {cogoResult ? " from the COGO figure" : parcelDoc ? " from parcels" : importResult ? " from import" : ""}.
        </p>
        <Button onClick={downloadCoordinateList} disabled={!coords.length}>
          ⬇ Download Coordinate List (CSV)
        </Button>
      </Card>
    </div>
  );
}
