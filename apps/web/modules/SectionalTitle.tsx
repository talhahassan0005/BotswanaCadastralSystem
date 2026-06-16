"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { Button, Card, Field, Input, Stat } from "@/components/ui";

interface Section {
  id: string;
  number: string;
  description: string;
  floorArea: number; // m²
}
interface SectionalDoc {
  building: string;
  sections: Section[];
}

const PALETTE = ["#0d9488", "#2563eb", "#db2777", "#d97706", "#7c3aed", "#16a34a", "#dc2626", "#0891b2"];

function uid() {
  return `s_${Date.now().toString(36)}_${Math.floor(performance.now() % 1e6).toString(36)}`;
}

/** Sectional Title (Module D — was "future"; now built): define building sections
 *  (units), auto-compute participation quotas, and produce a sectional plan +
 *  schedule (printable). Persisted with the project via store.sectionalDoc. */
export function SectionalTitle() {
  const { sectionalDoc, setSectionalDoc, config } = useStore();
  const svgRef = useRef<SVGSVGElement>(null);

  const [doc, setDoc] = useState<SectionalDoc>(() => {
    const d = sectionalDoc as SectionalDoc | null;
    return d && Array.isArray(d.sections) ? d : { building: "", sections: [] };
  });
  useEffect(() => { setSectionalDoc(doc); }, [doc, setSectionalDoc]);

  const total = useMemo(() => doc.sections.reduce((a, s) => a + (s.floorArea || 0), 0), [doc.sections]);
  const pq = (area: number) => (total > 0 ? area / total : 0);

  function addSection() {
    setDoc((d) => ({
      ...d,
      sections: [...d.sections, { id: uid(), number: String(d.sections.length + 1), description: "", floorArea: 0 }],
    }));
  }
  function update(id: string, patch: Partial<Section>) {
    setDoc((d) => ({ ...d, sections: d.sections.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  }
  function remove(id: string) {
    setDoc((d) => ({ ...d, sections: d.sections.filter((s) => s.id !== id) }));
  }

  function serialize(): string | null {
    if (!svgRef.current) return null;
    const clone = svgRef.current.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return new XMLSerializer().serializeToString(clone);
  }
  function download() {
    const svg = serialize();
    if (!svg) return;
    const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svg}`], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sectional-plan-${(doc.building || "building").replace(/\s+/g, "_")}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }
  function print() {
    const svg = serialize();
    if (!svg) return;
    const w = window.open("", "_blank", "width=1100,height=850");
    if (!w) return;
    w.document.write(
      `<html><head><title>Sectional Plan — ${doc.building}</title>` +
        `<style>@page{size:landscape}body{margin:0}svg{width:100%;height:auto}</style></head>` +
        `<body onload="window.print()">${svg}</body></html>`
    );
    w.document.close();
  }

  const W = 1000, H = 640;
  // schematic: stacked bars proportional to floor area
  let cursorY = 120;
  const barX = 690, barW = 280, barMaxH = H - 200;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat value={doc.sections.length} label="Sections" tone="brand" />
        <Stat value={total.toFixed(2)} label="Total floor area (m²)" />
        <Stat value={doc.sections.length ? "1.0000" : "—"} label="Σ participation quota" />
        <Stat value={config.coordinateSystem.replace(" Botswana", "")} label="System" />
      </div>

      <Card title="Sections (units)">
        <div className="mb-2"><Button variant="ghost" onClick={addSection}>+ Add section</Button>
          <Field label="Building / scheme name"><Input value={doc.building} onChange={(v) => setDoc((d) => ({ ...d, building: v }))} placeholder="e.g. ACACIA COURT, PLOT 1234" /></Field>
        </div>
        {doc.sections.length === 0 ? (
          <p className="text-sm text-slate-500">No sections yet — add the units of the building. Participation quota is computed from floor area.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr><th className="py-1 pr-2">Section</th><th className="py-1 pr-2">Description</th><th className="py-1 pr-2">Floor area (m²)</th><th className="py-1 pr-2">Participation quota</th><th></th></tr>
            </thead>
            <tbody>
              {doc.sections.map((s) => (
                <tr key={s.id} className="border-t border-slate-100">
                  <td className="py-1 pr-2 w-20"><Input value={s.number} onChange={(v) => update(s.id, { number: v })} /></td>
                  <td className="py-1 pr-2"><Input value={s.description} onChange={(v) => update(s.id, { description: v })} placeholder="e.g. Unit 1 / ground floor" /></td>
                  <td className="py-1 pr-2 w-32"><Input type="number" value={s.floorArea} onChange={(v) => update(s.id, { floorArea: Number(v) || 0 })} /></td>
                  <td className="py-1 pr-2 text-slate-600">{pq(s.floorArea).toFixed(4)} ({(pq(s.floorArea) * 100).toFixed(2)}%)</td>
                  <td className="py-1"><button className="text-xs text-red-500 hover:text-red-700" onClick={() => remove(s.id)}>delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-xs text-slate-400">Participation quota = section floor area ÷ total floor area (sums to 1.0000), per the Sectional Titles convention.</p>
      </Card>

      <Card title="Sectional Plan">
        <div className="mb-2 flex flex-wrap gap-2">
          <Button onClick={download} disabled={!doc.sections.length}>⬇ Download SVG</Button>
          <Button variant="ghost" onClick={print} disabled={!doc.sections.length}>Print / Save PDF</Button>
        </div>
        <div className="overflow-x-auto">
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[760px] bg-white" style={{ border: "1px solid #cbd5e1" }}>
            <rect x={6} y={6} width={W - 12} height={H - 12} fill="none" stroke="#0f172a" strokeWidth={1.5} />
            <text x={W / 2} y={34} textAnchor="middle" fontSize={19} fontWeight={700} fill="#0f172a">SECTIONAL PLAN</text>
            <text x={W / 2} y={54} textAnchor="middle" fontSize={12} fill="#334155">{doc.building || "(building / scheme name)"}</text>
            <line x1={660} y1={70} x2={660} y2={H - 14} stroke="#cbd5e1" />

            {/* schedule (left) */}
            <text x={30} y={92} fontSize={12} fontWeight={700}>SCHEDULE OF SECTIONS</text>
            <text x={30} y={112} fontSize={10} fontWeight={600} fill="#475569">No.</text>
            <text x={90} y={112} fontSize={10} fontWeight={600} fill="#475569">Description</text>
            <text x={380} y={112} fontSize={10} fontWeight={600} fill="#475569">Floor (m²)</text>
            <text x={500} y={112} fontSize={10} fontWeight={600} fill="#475569">Quota</text>
            {doc.sections.slice(0, 30).map((s, i) => {
              const y = 130 + i * 15;
              const col = PALETTE[i % PALETTE.length];
              return (
                <g key={s.id}>
                  <rect x={30} y={y - 8} width={7} height={7} fill={col} />
                  <text x={42} y={y} fontSize={9.5}>{s.number}</text>
                  <text x={90} y={y} fontSize={9.5}>{(s.description || "—").slice(0, 40)}</text>
                  <text x={380} y={y} fontSize={9.5}>{s.floorArea.toFixed(2)}</text>
                  <text x={500} y={y} fontSize={9.5}>{pq(s.floorArea).toFixed(4)}</text>
                </g>
              );
            })}
            <line x1={30} y1={130 + Math.min(doc.sections.length, 30) * 15} x2={590} y2={130 + Math.min(doc.sections.length, 30) * 15} stroke="#cbd5e1" />
            <text x={42} y={130 + Math.min(doc.sections.length, 30) * 15 + 16} fontSize={10} fontWeight={700}>TOTAL: {total.toFixed(2)} m² · Σ quota 1.0000</text>

            {/* schematic (right): proportional stacked bars */}
            <text x={barX} y={92} fontSize={12} fontWeight={700}>SECTIONS (by floor area)</text>
            {doc.sections.slice(0, 12).map((s, i) => {
              const frac = total > 0 ? s.floorArea / total : 0;
              const h = Math.max(frac * barMaxH, 6);
              const y = cursorY;
              cursorY += h + 4;
              const col = PALETTE[i % PALETTE.length];
              return (
                <g key={s.id}>
                  <rect x={barX} y={y} width={barW} height={h} fill={col} fillOpacity={0.25} stroke={col} strokeWidth={1} />
                  <text x={barX + 6} y={y + Math.min(h - 4, 14)} fontSize={9.5} fill="#0f172a">{s.number}: {s.floorArea.toFixed(1)} m² ({(frac * 100).toFixed(1)}%)</text>
                </g>
              );
            })}

            <text x={30} y={H - 18} fontSize={9} fill="#64748b">Surveyor: {config.surveyor || "—"} · System {config.coordinateSystem}</text>
          </svg>
        </div>
      </Card>
    </div>
  );
}
