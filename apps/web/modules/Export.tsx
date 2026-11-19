"use client";

import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { useStore, type ProjectState } from "@/lib/store";
import { Button, Card } from "@/components/ui";
import { writeDxf, type ImportedDrawing } from "@/lib/dxf";
import { buildShapefileSet } from "@/lib/shpWriter";
import { createZip } from "@/lib/zip";
import { crsToWkt } from "@/lib/crsWkt";
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

function downloadBlob(name: string, blob: Blob) {
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
  const { cogoResult, parcelDoc, importResult, config, snapshot, hydrate, setCurrentProject, setActiveTab } = useStore();
  const projectFileRef = useRef<HTMLInputElement>(null);
  const [projectTransferStatus, setProjectTransferStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

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
    // Quote any beacon id that contains a comma, quote or newline so it can't
    // shift the CSV columns (RFC-4180 style escaping).
    const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const header = "Beacon,East,North";
    const body = coords.map((c) => `${cell(String(c.id))},${c.e.toFixed(3)},${c.n.toFixed(3)}`).join("\n");
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

  function exportGeoAxisProject() {
    const bundle = {
      format: "geoaxis-project",
      version: 1,
      exportedAt: new Date().toISOString(),
      projectName: config.name || "Untitled Survey",
      state: snapshot(),
    };
    downloadText(`${baseName}.geoaxis`, JSON.stringify(bundle), "application/vnd.geoaxis.project+json");
    setProjectTransferStatus({ kind: "ok", text: "GeoAxis project exported. Send the downloaded .geoaxis file to your collaborator." });
  }

  function validProjectState(value: unknown): value is ProjectState {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const state = value as Record<string, unknown>;
    if (!state.config || typeof state.config !== "object" || Array.isArray(state.config)) return false;
    const cfg = state.config as Record<string, unknown>;
    return typeof cfg.name === "string" && typeof cfg.coordinateSystem === "string" &&
      ["Cadastral", "Engineering", "Mining", "GIS"].includes(String(cfg.discipline));
  }

  async function importGeoAxisProject(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setProjectTransferStatus(null);
    if (file.size > 50 * 1024 * 1024) {
      setProjectTransferStatus({ kind: "error", text: "This project file is larger than the 50 MB import limit." });
      return;
    }
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The file is not a GeoAxis project.");
      const bundle = parsed as Record<string, unknown>;
      if (bundle.format !== "geoaxis-project" || bundle.version !== 1) {
        throw new Error("Unsupported GeoAxis project format or version.");
      }
      if (!validProjectState(bundle.state)) throw new Error("The project data is incomplete or invalid.");
      const incomingName = String(bundle.projectName || bundle.state.config?.name || "Imported project");
      if (!window.confirm(`Open “${incomingName}”?\n\nThis will replace the project currently open in this browser. Export your current project first if you need a backup.`)) return;
      // An exchanged file is a new local copy. Never retain a cloud project
      // identity from the sender, otherwise Save could overwrite their copy.
      setCurrentProject(null);
      hydrate(bundle.state);
      window.alert(`“${incomingName}” was imported successfully. You can now edit and save it as your own project.`);
      setProjectTransferStatus({ kind: "ok", text: `“${incomingName}” imported successfully. You can now edit and save it as your own project.` });
    } catch (error) {
      setProjectTransferStatus({ kind: "error", text: error instanceof Error ? error.message : "Could not import this GeoAxis project." });
    }
  }

  function exportShapefile() {
    if (coords.length < 3) return;
    const ring = [...coords];
    const first = ring[0], last = ring[ring.length - 1];
    if (ring.length > 3 && first.e === last.e && first.n === last.n) ring.pop();
    if (ring.length < 3) return;
    let twiceArea = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      twiceArea += a.e * b.n - b.e * a.n;
    }
    const { shp, shx, dbf } = buildShapefileSet([{
      number: config.name || "Survey boundary",
      points: ring.map((c) => ({ east: c.e, north: c.n })),
      areaM2: Math.abs(twiceArea) / 2,
    }]);
    const prj = new TextEncoder().encode(crsToWkt(config.coordinateSystem));
    const zip = createZip([
      { name: `${baseName}.shp`, data: shp },
      { name: `${baseName}.shx`, data: shx },
      { name: `${baseName}.dbf`, data: dbf },
      { name: `${baseName}.prj`, data: prj },
    ]);
    downloadBlob(`${baseName}_shapefile.zip`, zip);
  }

  return (
    <div className="space-y-4">
      <Card title="Export survey data">
        <p className="mb-3 text-sm text-slate-500">
          Export the project coordinates and figure in standard interchange formats. {coords.length} coordinate(s)
          available{cogoResult ? " from the COGO figure" : parcelDoc ? " from parcels" : importResult ? " from import" : ""}.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
          <div className="rounded-lg border border-slate-200 p-4">
            <div className="font-semibold text-slate-700">Figure (Shapefile)</div>
            <p className="mt-1 text-xs text-slate-500">Closed survey boundary with attributes and project CRS.</p>
            <div className="mt-3"><Button onClick={exportShapefile} disabled={coords.length < 3}>⬇ Download SHP</Button></div>
          </div>
        </div>
      </Card>

      <Card title="Share GeoAxis project">
        <p className="mb-3 text-sm text-slate-500">
          Transfer the complete editable project to another GeoAxis user. Send the exported <strong>.geoaxis</strong> file by email, WhatsApp, cloud drive, or any other file-sharing service.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-slate-200 p-4">
            <div className="font-semibold text-slate-700">Export GeoAxis Project</div>
            <p className="mt-1 text-xs text-slate-500">Includes project settings, survey data, COGO work, parcels, plans, diagrams, records and GIS drawings.</p>
            <div className="mt-3"><Button onClick={exportGeoAxisProject}>⬇ Export Project</Button></div>
          </div>
          <div className="rounded-lg border border-slate-200 p-4">
            <div className="font-semibold text-slate-700">Import GeoAxis Project</div>
            <p className="mt-1 text-xs text-slate-500">Open a .geoaxis project received from another user and continue editing it.</p>
            <input ref={projectFileRef} type="file" accept=".geoaxis,application/vnd.geoaxis.project+json" onChange={importGeoAxisProject} className="hidden" />
            <div className="mt-3"><Button variant="ghost" onClick={() => projectFileRef.current?.click()}>⬆ Import Project</Button></div>
          </div>
        </div>
        {projectTransferStatus && (
          <p className={`mt-3 rounded-md px-3 py-2 text-sm ${projectTransferStatus.kind === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
            {projectTransferStatus.text}
          </p>
        )}
      </Card>

      <Card title="PDF & other formats">
        <ul className="space-y-2 text-sm text-slate-700">
          <li className="flex items-start gap-2"><span className="text-brand">→</span> <span><strong>PDF</strong> — open <button className="underline" onClick={() => setActiveTab("diagrams")}>Diagrams</button>, <button className="underline" onClick={() => setActiveTab("workingplan")}>Working Plan</button>, or <button className="underline" onClick={() => setActiveTab("records")}>Survey Record</button> and use <em>Print / Save PDF</em>.</span></li>
          <li className="flex items-start gap-2"><span className="text-brand">→</span> <span><strong>SVG</strong> — each diagram has a Download SVG button (vector, scalable).</span></li>
          <li className="flex items-start gap-2"><span className="text-brand">→</span> <span><strong>Shapefile</strong> — downloads the required SHP, SHX, DBF and PRJ files together as a ZIP.</span></li>
        </ul>
      </Card>
    </div>
  );
}
