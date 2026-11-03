"use client";

import { useEffect, useState } from "react";
import { apiHealth } from "@/lib/api";
import { useStore, cogoTabLabel, type Discipline } from "@/lib/store";

export const TABS = [
  { id: "import", label: "Data Import", module: "Data Import" },
  { id: "cogo", label: "COGO Engine", module: "COGO Engine" },
  { id: "traverse", label: "Traverse", module: "Traverse Adjustment" },
  { id: "topo", label: "Topo Survey", module: "Topographic Survey" },
  { id: "volume", label: "Volume", module: "Volume Computation" },
  { id: "editor", label: "Editor", module: "Manual Drafting / Editing" },
  { id: "parcels", label: "Parcels", module: "Parcel Construction" },
  { id: "diagrams", label: "Diagrams", module: "Diagram Generation" },
  { id: "workingplan", label: "Working Plan", module: "Working Plan" },
  { id: "generalplan", label: "General Plan", module: "General Plan" },
  { id: "sectional", label: "Sectional Title", module: "Sectional Title" },
  { id: "records", label: "Survey Record", module: "Cadastral Survey Record" },
  { id: "gis", label: "GIS Map", module: "GIS Integration" },
  { id: "collab", label: "Surveyors", module: "Surveyor Check-in & Collaboration" },
  { id: "export", label: "Export", module: "Export" },
  { id: "validate", label: "AI Validate", module: "AI Validation" },
  { id: "reports", label: "Reports", module: "Reports" },
];

// Per-discipline tab sets (Stage-3 branch). Generous overlap — common tools are in all.
// Data Import & Export live under the File menu (not the tab bar). The Editor is a
// drafting tool, so it is offered under Engineering/Mining/GIS, not Cadastral.
// Cadastral (client req 2026-08-12): "cogo" tab is relabelled "Cadastral" and kept
// first; Traverse and Parcels are dropped from the nav (Parcels stays reachable via
// in-page "Go to Parcels" links from Diagrams/Working Plan/General Plan).
const DISCIPLINE_TABS: Record<Discipline, string[]> = {
  Cadastral: ["cogo", "diagrams", "workingplan", "generalplan", "sectional", "records", "gis", "collab", "validate", "reports"],
  Engineering: ["cogo", "traverse", "topo", "volume", "editor", "diagrams", "workingplan", "gis", "collab", "validate", "reports"],
  Mining: ["cogo", "topo", "volume", "editor", "gis", "collab", "validate", "reports"],
  GIS: ["gis", "editor", "topo", "collab"],
};

function Dot({ ok }: { ok: boolean }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-brand" : "bg-slate-500"}`} />;
}

export function Header({
  activeTab,
  onTab,
  children,
}: {
  activeTab: string;
  onTab: (id: string) => void;
  children?: React.ReactNode;
}) {
  const { config } = useStore();
  const allowed = DISCIPLINE_TABS[config.discipline] ?? TABS.map((t) => t.id);
  // Cadastral discipline relabels the "cogo" tab to "Cadastral" (client req);
  // other disciplines keep the original "COGO Engine" label.
  const cogoLabel = cogoTabLabel(config.discipline);
  const tabs = TABS.map((t) => (t.id === "cogo" ? { ...t, label: cogoLabel, module: cogoLabel } : t));
  const visibleTabs = tabs.filter((t) => allowed.includes(t.id));
  const active = tabs.find((t) => t.id === activeTab);
  const [health, setHealth] = useState<{ engine: boolean; ai: boolean; db: boolean } | null>(null);

  useEffect(() => {
    apiHealth().then((h) => setHealth(h)).catch(() => setHealth(null));
  }, [activeTab]);

  return (
    <div className="bg-navy-900 text-white">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 sm:px-6 sm:py-4">
        {/* GeoAxis logo (client req 2026-10-21) on a white plate — its navy
            lettering would disappear on the dark header otherwise. */}
        <div className="flex items-center rounded-md bg-white px-2 py-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/geoaxis-wordmark.png" alt="GeoAxis" className="h-7 w-auto sm:h-9" />
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-300 sm:gap-4 sm:text-sm">
          {health && (
            <div className="hidden items-center gap-3 sm:flex">
              <span className="flex items-center gap-1"><Dot ok={health.engine} /> Engine</span>
              <span className="flex items-center gap-1"><Dot ok={health.ai} /> AI</span>
              <span className="flex items-center gap-1"><Dot ok={health.db} /> DB</span>
            </div>
          )}
          <span className="truncate">Module: {active?.module ?? ""}</span>
        </div>
      </div>

      {children}

      <nav className="flex gap-1 overflow-x-auto bg-navy-800 px-2 sm:px-4">
        {visibleTabs.map((t) => (
          <button
            key={t.id}
            onClick={() => onTab(t.id)}
            className={`whitespace-nowrap rounded-md px-3 py-2 text-xs font-medium transition sm:px-4 sm:py-2.5 sm:text-sm ${
              activeTab === t.id
                ? "bg-brand text-white"
                : "text-slate-300 hover:bg-navy-700 hover:text-white"
            }`}
          >
            {t.label}
          </button>
        ))}
        {/* Help line (client req 2026-10-21) — opens a WhatsApp chat. */}
        <a
          href="https://wa.me/26773241671"
          target="_blank"
          rel="noopener noreferrer"
          title="Help Line on WhatsApp"
          className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-semibold text-slate-200 transition hover:bg-navy-700 hover:text-white sm:px-4 sm:py-2 sm:text-base"
        >
          <span>Help Line</span>
          <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 sm:h-6 sm:w-6" fill="#25D366">
            <path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.21 3.08c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.69.63.71.23 1.36.2 1.87.12.57-.09 1.76-.72 2.01-1.41.25-.69.25-1.29.17-1.41-.07-.12-.27-.2-.57-.35zM12.05 21.5h-.01a9.4 9.4 0 0 1-4.8-1.32l-.34-.2-3.57.94.95-3.48-.22-.36a9.43 9.43 0 0 1-1.44-5.02c0-5.2 4.24-9.44 9.45-9.44 2.52 0 4.89.99 6.67 2.77a9.38 9.38 0 0 1 2.76 6.68c0 5.2-4.24 9.43-9.45 9.43zm8.04-17.47A11.3 11.3 0 0 0 12.05.7C5.78.7.68 5.8.68 12.06c0 2 .52 3.96 1.52 5.68L.58 23.3l5.7-1.5a11.33 11.33 0 0 0 5.76 1.47h.01c6.27 0 11.37-5.1 11.37-11.37 0-3.04-1.18-5.9-3.33-8.04z" />
          </svg>
          <span>+267 73241671</span>
        </a>
      </nav>
    </div>
  );
}
