"use client";

import { Card } from "@/components/ui";

const INFO: Record<string, { title: string; phase: string; points: string[] }> = {
  traverse: {
    title: "Traverse Adjustment Reports",
    phase: "Phase 1b",
    points: [
      "Closure, adjustment & residuals reports (data already computed in COGO Engine)",
      "Angular + linear closure breakdown",
      "Least-squares adjustment (engine: numpy/scipy)",
    ],
  },
  parcels: {
    title: "Parcel Construction",
    phase: "Phase 3",
    points: [
      "Beacon manager, parcel list, boundary editing on a map canvas",
      "Subdivide / consolidate / number parcels",
      "Topology validation (overlaps, gaps) and 'Generate SG Diagram'",
    ],
  },
  diagrams: {
    title: "Diagram Generation",
    phase: "Phase 4",
    points: [
      "SG Diagram (single parcel) — matches DG-Model.pdf layout",
      "General Plan (multi-sheet) — matches SHEET1/SHEET2 CH.pdf",
      "Working Plan — matches WP CH.pdf, with coordinate/beacon tables",
    ],
  },
  gis: {
    title: "GIS Integration",
    phase: "Phase 5",
    points: [
      "OpenLayers/Leaflet map with satellite, parcels, roads, beacons layers",
      "Cursor position read-out in the active CRS",
      "Zoom-to parcel / beacon, search by Erf / beacon ID",
    ],
  },
  export: {
    title: "Export",
    phase: "Phase 4",
    points: [
      "PDF + DXF (engine: ezdxf) first",
      "SHP (geopandas/pyshp) and CSV next",
      "DWG last — requires ODA converter / paid SDK (see ARCHITECTURE.md risks)",
    ],
  },
};

export function Placeholder({ tab }: { tab: string }) {
  const info = INFO[tab];
  if (!info) return null;
  return (
    <Card>
      <div className="py-8">
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-brand-dark">
          Planned · {info.phase}
        </div>
        <h2 className="text-2xl font-bold text-slate-800">{info.title}</h2>
        <p className="mt-2 text-sm text-slate-500">
          This module is designed and scheduled. Planned capabilities:
        </p>
        <ul className="mt-4 space-y-2">
          {info.points.map((p, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-slate-700">
              <span className="mt-0.5 text-brand">-</span>
              {p}
            </li>
          ))}
        </ul>
        <p className="mt-6 text-xs text-slate-400">
          The COGO engine, Data Import and AI Validate flows are live now. See ARCHITECTURE.md for
          the full phased roadmap.
        </p>
      </div>
    </Card>
  );
}
