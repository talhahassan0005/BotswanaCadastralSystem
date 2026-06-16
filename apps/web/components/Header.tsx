"use client";

import { useEffect, useState } from "react";
import { apiHealth } from "@/lib/api";
import { useStore, type Discipline } from "@/lib/store";

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
];

// Per-discipline tab sets (Stage-3 branch). Generous overlap — common tools are in all.
const DISCIPLINE_TABS: Record<Discipline, string[]> = {
  Cadastral: ["import", "cogo", "traverse", "parcels", "diagrams", "workingplan", "generalplan", "sectional", "records", "editor", "gis", "collab", "export", "validate"],
  Engineering: ["import", "cogo", "traverse", "topo", "volume", "editor", "diagrams", "workingplan", "gis", "collab", "export", "validate"],
  Mining: ["import", "cogo", "topo", "volume", "editor", "gis", "collab", "export", "validate"],
  GIS: ["import", "gis", "editor", "topo", "collab", "export"],
};

function Dot({ ok }: { ok: boolean }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-brand" : "bg-slate-500"}`} />;
}

export function Header({ activeTab, onTab }: { activeTab: string; onTab: (id: string) => void }) {
  const { config } = useStore();
  const allowed = DISCIPLINE_TABS[config.discipline] ?? TABS.map((t) => t.id);
  const visibleTabs = TABS.filter((t) => allowed.includes(t.id));
  const active = TABS.find((t) => t.id === activeTab);
  const [health, setHealth] = useState<{ engine: boolean; ai: boolean; db: boolean } | null>(null);

  useEffect(() => {
    apiHealth().then((h) => setHealth(h)).catch(() => setHealth(null));
  }, [activeTab]);

  return (
    <div className="bg-navy-900 text-white">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex items-center gap-1.5 text-base font-semibold sm:gap-2 sm:text-xl">
          <span className="grid h-6 w-6 place-items-center rounded bg-brand text-[10px] font-bold text-white sm:h-7 sm:w-7">BC</span>
          <span>Botswana</span>
          <span className="text-brand">Cadastral</span>
          <span>System</span>
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
      </nav>
    </div>
  );
}
