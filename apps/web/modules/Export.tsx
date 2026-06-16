"use client";

import { useMemo } from "react";
import { useStore } from "@/lib/store";
import { Button, Card } from "@/components/ui";
import { writeDxf, type ImportedDrawing } from "@/lib/dxf";
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

/** Export hub (M3) — coordinate list (CSV), figure (DXF), project (JSON);
 *  PDF via the Diagrams / Working Plan / Survey Record print buttons. */
export function Export() {
  const { cogoResult, parcelDoc, importResult, config, snapshot, setActiveTab } = useStore();

  // Unified coordinate list from whichever source is populated.
  const coords = useMemo(() => {
    if (cogoResult?.points?.length) return cogoResult.points.map((p) => ({ id: p.name ?? "", e: p.east, n: p.north }));
    const pd = parcelDoc as ParcelDoc | null;
    if (pd?.beacons?.length) return pd.beacons.map((b) => ({ id: b.id, e: b.east, n: b.north }));
    if (importResult?.rows?.length)
      return importResult.rows.filter((r) => r.east != null && r.north != null).map((r) => ({ id: r.beaconId ?? "", e: r.east as number, n: r.north as number }));
    return [];
  }, [cogoResult, parcelDoc, importResult]);

  const baseName = (config.name || "survey").replace(/\s+/g, "_");

  function exportCsv() {
    const header = "Beacon,East,North";
    const body = coords.map((c) => `${c.id},${c.e.toFixed(3)},${c.n.toFixed(3)}`).join("\n");
    downloadText(`${baseName}_coordinates.csv`, `${header}\n${body}\n`, "text/csv");
  }

  function exportDxf() {
    const ring = cogoResult?.points ?? [];
    const drawing: ImportedDrawing = {
      points: coords.map((c) => ({ x: c.e, y: c.n, label: c.id, layer: "BEACONS" })),
      polylines: ring.length >= 3 ? [{ pts: ring.map((p) => ({ x: p.east, y: p.north })), closed: true, layer: "BOUNDARY" }] : [],
      texts: [],
    };
    downloadText(`${baseName}_figure.dxf`, writeDxf(drawing), "application/dxf");
  }

  function exportJson() {
    downloadText(`${baseName}_project.json`, JSON.stringify(snapshot(), null, 2), "application/json");
  }

  return (
    <div className="space-y-4">
      <Card title="Export survey data">
        <p className="mb-3 text-sm text-slate-500">
          Export the project coordinates and figure in standard interchange formats. {coords.length} coordinate(s)
          available{cogoResult ? " from the COGO figure" : parcelDoc ? " from parcels" : importResult ? " from import" : ""}.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-slate-200 p-4">
            <div className="font-semibold text-slate-700">Coordinate list (CSV)</div>
            <p className="mt-1 text-xs text-slate-500">Beacon, East, North — re-importable.</p>
            <div className="mt-3"><Button onClick={exportCsv} disabled={!coords.length}>⬇ Download CSV</Button></div>
          </div>
          <div className="rounded-lg border border-slate-200 p-4">
            <div className="font-semibold text-slate-700">Figure (DXF)</div>
            <p className="mt-1 text-xs text-slate-500">Beacons + closed boundary — opens in AutoCAD / survey software.</p>
            <div className="mt-3"><Button onClick={exportDxf} disabled={!coords.length}>⬇ Download DXF</Button></div>
          </div>
          <div className="rounded-lg border border-slate-200 p-4">
            <div className="font-semibold text-slate-700">Project (JSON)</div>
            <p className="mt-1 text-xs text-slate-500">Full project bundle — back up or transfer.</p>
            <div className="mt-3"><Button onClick={exportJson}>⬇ Download JSON</Button></div>
          </div>
        </div>
      </Card>

      <Card title="PDF & other formats">
        <ul className="space-y-2 text-sm text-slate-700">
          <li className="flex items-start gap-2"><span className="text-brand">→</span> <span><strong>PDF</strong> — open <button className="underline" onClick={() => setActiveTab("diagrams")}>Diagrams</button>, <button className="underline" onClick={() => setActiveTab("workingplan")}>Working Plan</button>, or <button className="underline" onClick={() => setActiveTab("records")}>Survey Record</button> and use <em>Print / Save PDF</em>.</span></li>
          <li className="flex items-start gap-2"><span className="text-brand">→</span> <span><strong>SVG</strong> — each diagram has a Download SVG button (vector, scalable).</span></li>
          <li className="flex items-start gap-2"><span className="text-brand">→</span> <span><strong>Shapefile (SHP) write</strong> — import is supported in the Editor; SHP <em>export</em> is planned for the GIS branch (needs a server-side writer).</span></li>
        </ul>
      </Card>
    </div>
  );
}
