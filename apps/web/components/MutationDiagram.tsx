"use client";

import { useRef, type ReactNode } from "react";
import { Button } from "@/components/ui";
import type { Beacon, Parcel } from "@/lib/types";
import { beaconMap, parcelMetrics, ringPoints } from "@/lib/server/parcel";

const PALETTE = ["#0d9488", "#2563eb", "#db2777", "#d97706", "#7c3aed", "#16a34a", "#dc2626", "#0891b2"];

export interface MutationMeta {
  title: string;
  surveyor: string;
  date: string;
  coordinateSystem: string;
}

/**
 * Diagram of Mutation (Module D output): the parent figure with all mutated
 * parcels overlaid + a parcel-area schedule and a beacon-coordinate schedule.
 * Self-contained: renders the printable SVG plus Download / Print actions.
 */
export function MutationDiagram({
  beacons,
  parcels,
  meta,
}: {
  beacons: Beacon[];
  parcels: Parcel[];
  meta: MutationMeta;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const by = beaconMap(beacons);

  const usedIds = new Set(parcels.flatMap((p) => p.beaconIds));
  const fig = beacons.filter((b) => usedIds.has(b.id));

  if (parcels.length === 0 || fig.length < 3) {
    return <p className="text-sm text-slate-500">Create at least one parcel (3+ beacons) to produce a mutation diagram.</p>;
  }

  const W = 1000, H = 680;
  const FX0 = 20, FY0 = 70, FX1 = 600, FY1 = H - 20; // figure box
  const xs = fig.map((b) => b.east);
  const ys = fig.map((b) => b.north);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX || 1, spanY = maxY - minY || 1;
  const pad = 40;
  const s = Math.min((FX1 - FX0 - 2 * pad) / spanX, (FY1 - FY0 - 2 * pad) / spanY);
  const ox = FX0 + ((FX1 - FX0) - s * spanX) / 2;
  const oyOff = ((FY1 - FY0) - s * spanY) / 2;
  const sx = (e: number) => ox + (e - minX) * s;
  const sy = (n: number) => FY1 - oyOff - (n - minY) * s;

  const schedule = parcels.map((p, i) => ({ p, i, m: parcelMetrics(p.beaconIds, by) }));

  // ---- right panel built in plain JS (no render-time mutation) ----
  const RX = 620;
  const panel: ReactNode[] = [];
  let ry = 78;
  const line = (node: (y: number) => ReactNode, gap = 15) => { panel.push(node(ry)); ry += gap; };

  line((y) => <text key="ps" x={RX} y={y} fontSize={12} fontWeight={700} fill="#0f172a">PARCEL SCHEDULE</text>, 16);
  line((y) => (
    <g key="psh">
      <text x={RX} y={y} fontSize={10} fontWeight={600} fill="#475569">No.</text>
      <text x={RX + 120} y={y} fontSize={10} fontWeight={600} fill="#475569">Area (m²)</text>
      <text x={RX + 250} y={y} fontSize={10} fontWeight={600} fill="#475569">Area (ha)</text>
    </g>
  ), 15);
  for (const { p, i, m } of schedule) {
    const col = PALETTE[i % PALETTE.length];
    line((y) => (
      <g key={`pr_${p.id}`}>
        <rect x={RX} y={y - 9} width={8} height={8} fill={col} />
        <text x={RX + 14} y={y} fontSize={10} fill="#0f172a">{p.number || "(unnumbered)"}</text>
        <text x={RX + 120} y={y} fontSize={10} fill="#0f172a">{m.area_m2}</text>
        <text x={RX + 250} y={y} fontSize={10} fill="#0f172a">{m.area_ha}</text>
      </g>
    ), 15);
  }

  ry += 12;
  line((y) => <text key="bs" x={RX} y={y} fontSize={12} fontWeight={700} fill="#0f172a">BEACON COORDINATES</text>, 16);
  line((y) => (
    <g key="bsh">
      <text x={RX} y={y} fontSize={10} fontWeight={600} fill="#475569">Beacon</text>
      <text x={RX + 90} y={y} fontSize={10} fontWeight={600} fill="#475569">East (Y)</text>
      <text x={RX + 220} y={y} fontSize={10} fontWeight={600} fill="#475569">North (X)</text>
    </g>
  ), 14);
  for (const b of fig.slice(0, 22)) {
    line((y) => (
      <g key={`bc_${b.id}`}>
        <text x={RX} y={y} fontSize={10} fill="#0f172a">{b.id}</text>
        <text x={RX + 90} y={y} fontSize={10} fill="#0f172a">{b.east.toFixed(2)}</text>
        <text x={RX + 220} y={y} fontSize={10} fill="#0f172a">{b.north.toFixed(2)}</text>
      </g>
    ), 14);
  }
  if (fig.length > 22) line((y) => <text key="more" x={RX} y={y} fontSize={9} fill="#94a3b8">+{fig.length - 22} more beacon(s)…</text>, 14);

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
    a.download = `mutation-diagram-${meta.title.replace(/\s+/g, "_") || "parcels"}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }
  function print() {
    const svg = serialize();
    if (!svg) return;
    const w = window.open("", "_blank", "width=1200,height=850");
    if (!w) return;
    w.document.write(
      `<html><head><title>Mutation diagram — ${meta.title}</title>` +
        `<style>@page{size:landscape}body{margin:0}svg{width:100%;height:auto}</style></head>` +
        `<body onload="window.print()">${svg}</body></html>`
    );
    w.document.close();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button onClick={download}>⬇ Download SVG</Button>
        <Button variant="ghost" onClick={print}>Print / Save PDF</Button>
      </div>
      <div className="overflow-x-auto">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[760px] bg-white" style={{ border: "1px solid #cbd5e1" }}>
          <rect x={6} y={6} width={W - 12} height={H - 12} fill="none" stroke="#0f172a" strokeWidth={1.5} />
          <text x={W / 2} y={34} textAnchor="middle" fontSize={20} fontWeight={700} fill="#0f172a">DIAGRAM OF MUTATION</text>
          <text x={W / 2} y={54} textAnchor="middle" fontSize={12} fill="#334155">{meta.title}</text>
          <line x1={610} y1={64} x2={610} y2={H - 14} stroke="#cbd5e1" strokeWidth={1} />

          {schedule.map(({ p, i, m }) => {
            const pts = ringPoints(p.beaconIds, by);
            if (pts.length < 3) return null;
            const d = pts.map((pp) => `${sx(pp.east)},${sy(pp.north)}`).join(" ");
            const cx = pts.reduce((a, pp) => a + sx(pp.east), 0) / pts.length;
            const cy = pts.reduce((a, pp) => a + sy(pp.north), 0) / pts.length;
            const col = PALETTE[i % PALETTE.length];
            return (
              <g key={p.id}>
                <polygon points={d} fill={col} fillOpacity={0.14} stroke={col} strokeWidth={1.6} />
                <text x={cx} y={cy} textAnchor="middle" fontSize={11} fontWeight={700} fill={col}>{p.number}</text>
                <text x={cx} y={cy + 13} textAnchor="middle" fontSize={9} fill="#475569">{m.area_ha} ha</text>
              </g>
            );
          })}
          {fig.map((b) => (
            <g key={b.id}>
              <circle cx={sx(b.east)} cy={sy(b.north)} r={3} fill="#0f172a" />
              <text x={sx(b.east) + 5} y={sy(b.north) - 4} fontSize={9} fill="#0f172a">{b.id}</text>
            </g>
          ))}
          <g transform={`translate(${FX1 - 24},${FY0 + 18})`}>
            <line x1={0} y1={12} x2={0} y2={-10} stroke="#0f172a" strokeWidth={1.5} />
            <polygon points="0,-14 -5,-5 5,-5" fill="#0f172a" />
            <text x={0} y={26} textAnchor="middle" fontSize={10} fill="#0f172a">N</text>
          </g>

          {panel}

          <text x={RX} y={H - 46} fontSize={9} fill="#475569">Coordinate system: {meta.coordinateSystem}</text>
          <text x={RX} y={H - 32} fontSize={9} fill="#475569">Surveyor: {meta.surveyor || "—"}</text>
          <text x={RX} y={H - 18} fontSize={9} fill="#475569">Date: {meta.date || "—"}</text>
        </svg>
      </div>
    </div>
  );
}
