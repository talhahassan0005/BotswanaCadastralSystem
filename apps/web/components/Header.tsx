"use client";

import { useEffect, useState } from "react";
import { apiHealth } from "@/lib/api";

export const TABS = [
  { id: "import", label: "Data Import", module: "Data Import" },
  { id: "cogo", label: "COGO Engine", module: "COGO Engine" },
  { id: "traverse", label: "Traverse", module: "Traverse Adjustment" },
  { id: "parcels", label: "Parcels", module: "Parcel Construction" },
  { id: "diagrams", label: "Diagrams", module: "Diagram Generation" },
  { id: "gis", label: "GIS Map", module: "GIS Integration" },
  { id: "export", label: "Export", module: "Export" },
  { id: "validate", label: "AI Validate", module: "AI Validation" },
];

function Dot({ ok }: { ok: boolean }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-brand" : "bg-slate-500"}`} />;
}

export function Header({ activeTab, onTab }: { activeTab: string; onTab: (id: string) => void }) {
  const active = TABS.find((t) => t.id === activeTab);
  const [health, setHealth] = useState<{ engine: boolean; ai: boolean; db: boolean } | null>(null);

  useEffect(() => {
    apiHealth().then((h) => setHealth(h)).catch(() => setHealth(null));
  }, [activeTab]);

  return (
    <div className="bg-navy-900 text-white">
      <div className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2 text-xl font-semibold">
          <span className="grid h-7 w-7 place-items-center rounded bg-brand/20 text-brand">▦</span>
          <span>Botswana</span>
          <span className="text-brand">Cadastral</span>
          <span>System</span>
        </div>
        <div className="flex items-center gap-4 text-sm text-slate-300">
          {health && (
            <div className="hidden items-center gap-3 sm:flex">
              <span className="flex items-center gap-1"><Dot ok={health.engine} /> Engine</span>
              <span className="flex items-center gap-1"><Dot ok={health.ai} /> AI</span>
              <span className="flex items-center gap-1"><Dot ok={health.db} /> DB</span>
            </div>
          )}
          <span>Module: {active?.module ?? ""}</span>
        </div>
      </div>

      <nav className="flex gap-1 overflow-x-auto bg-navy-800 px-4">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => onTab(t.id)}
            className={`whitespace-nowrap rounded-md px-4 py-2.5 text-sm font-medium transition ${
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
