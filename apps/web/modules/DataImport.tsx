"use client";

import { useRef, useState } from "react";
import { apiJson, apiUpload } from "@/lib/api";
import { useStore } from "@/lib/store";
import type { ImportResult } from "@/lib/types";
import { Badge, Button } from "@/components/ui";

// Real client data — Lot 14182 Charleshill (DG-Model.pdf, System Lo 21°).
// Reproduces the published 35.9794 ha to ~1 m²; closes 1:334,976.
const SAMPLE_CSV = `Beacon ID,Easting,Northing,Bearing,Distance
A,93205.88,2464520.65,272.36.20,408.24
B,92798.07,2464539.22,0.00.00,831.43
C,92798.07,2465370.65,90.00.00,383.80
D,93181.87,2465370.65,122.13.20,137.81
E,93298.45,2465297.17,212.13.20,128.22
F,93230.08,2465188.69,182.04.30,668.48`;

export function DataImport() {
  const { importResult, setImportResult, setActiveTab, config } = useStore();
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      const result = await apiUpload<ImportResult>("/import/file", file);
      setImportResult(result);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function loadSample() {
    setError(null);
    setBusy(true);
    try {
      const result = await apiJson<ImportResult>("/import/text", { text: SAMPLE_CSV });
      setImportResult(result);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) handleFile(f);
        }}
        className={`rounded-2xl border-2 border-dashed p-6 text-center transition sm:p-12 ${
          dragging ? "border-brand bg-brand-light/40" : "border-brand/40 bg-brand-light/10"
        }`}
      >
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-xl border-2 border-brand/40 text-2xl text-brand">
        </div>
        <p className="text-lg font-medium text-brand-dark">Drop your survey file here</p>
        <p className="mt-1 text-sm text-emerald-600">Supports: CSV / TXT observations, or a DXF / Shapefile parent diagram</p>
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          <Button onClick={() => fileRef.current?.click()} loading={busy}>Browse file</Button>
          <Button variant="ghost" onClick={loadSample} loading={busy}>
            Load sample
          </Button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt,.dxf,.shp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
      </div>

      {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {importResult && (
        <div>
          {importResult.notice && (
            <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <strong>Heads up:</strong> {importResult.notice}
            </div>
          )}
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Preview — {importResult.filename} ({importResult.rows.length} rows detected · columns: {importResult.detectedColumns.join(", ")})
            </p>
            <button
              onClick={() => { setImportResult(null); setError(null); if (fileRef.current) fileRef.current.value = ""; }}
              className="whitespace-nowrap text-xs font-medium text-red-500 underline hover:text-red-700"
            >
              ✕ Remove / unload file
            </button>
          </div>
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3">#</th>
                  <th className="px-4 py-3">Beacon ID</th>
                  <th className="px-4 py-3">Easting (m)</th>
                  <th className="px-4 py-3">Northing (m)</th>
                  <th className="px-4 py-3">Bearing</th>
                  <th className="px-4 py-3">Distance</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Issues</th>
                </tr>
              </thead>
              <tbody>
                {importResult.rows.map((r) => (
                  <tr
                    key={r.index}
                    className={`border-b border-slate-100 ${
                      r.status === "error"
                        ? "bg-red-50/50"
                        : r.status === "check"
                        ? "bg-amber-50/50"
                        : ""
                    }`}
                    title={r.issues.join(", ")}
                  >
                    <td className="px-4 py-3 text-slate-400">{r.index}</td>
                    <td className="px-4 py-3 font-medium">{r.beaconId ?? "—"}</td>
                    <td className="px-4 py-3">{r.east?.toLocaleString() ?? "—"}</td>
                    <td className="px-4 py-3">{r.north?.toLocaleString() ?? "—"}</td>
                    <td className="px-4 py-3">{r.bearing ?? "—"}</td>
                    <td className="px-4 py-3">{r.distance != null ? `${r.distance} m` : "—"}</td>
                    <td className="px-4 py-3">
                      <Badge kind={r.status}>
                        {r.status === "valid" ? "Valid" : r.status === "check" ? "Check" : "Error"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">{r.issues.length ? r.issues.join(", ") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Chip>{importResult.validCount} valid rows</Chip>
            <Chip>{importResult.warningCount} warning</Chip>
            <Chip>{importResult.errorCount} error</Chip>
            <Chip>CRS: {config.coordinateSystem}</Chip>
            <div className="ml-auto">
              <Button onClick={() => setActiveTab("cogo")}>Proceed to COGO →</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 shadow-sm">
      {children}
    </span>
  );
}
