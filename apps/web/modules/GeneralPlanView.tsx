"use client";

import { useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { Button, Card, Field, Input } from "@/components/ui";
import { beaconMap, parcelMetrics, ringPoints } from "@/lib/server/parcel";
import type { Beacon, ParcelDoc } from "@/lib/types";

const PALETTE = ["#0d9488", "#2563eb", "#db2777", "#d97706", "#7c3aed", "#16a34a", "#dc2626", "#0891b2"];
const COORDS_PER_SHEET = 48;
const W = 1000;
const H = 707; // A4 landscape ratio

/** Multi-sheet General Plan (Module D / M3): the whole layout of all parcels on
 *  sheet 1, with the beacon coordinate schedule paginated onto continuation sheets. */
export function GeneralPlanView() {
  const { parcelDoc, config, setActiveTab } = useStore();
  const refs = useRef<(SVGSVGElement | null)[]>([]);
  const [sheet, setSheet] = useState(0);

  const pd = parcelDoc as ParcelDoc | null;
  const beacons = useMemo<Beacon[]>(() => pd?.beacons ?? [], [pd]);
  const parcels = useMemo(() => pd?.parcels ?? [], [pd]);
  const by = useMemo(() => beaconMap(beacons), [beacons]);

  const usedBeacons = useMemo(() => {
    const ids = new Set(parcels.flatMap((p) => p.beaconIds));
    const list = beacons.filter((b) => ids.has(b.id));
    return list.length ? list : beacons;
  }, [beacons, parcels]);

  const [meta, setMeta] = useState({
    name: config.name && config.name !== "Untitled Survey" ? config.name.toUpperCase() : "TOWNSHIP LAYOUT",
    location: "",
    surveyor: config.surveyor ? config.surveyor.toUpperCase() : "",
    gpNo: "",
    scale: 2000,
  });
  const set = (k: keyof typeof meta) => (v: string) => setMeta((m) => ({ ...m, [k]: k === "scale" ? Number(v) || 0 : v }));

  // Pagination: sheet 0 = layout; following sheets = coordinate chunks.
  const coordChunks = useMemo(() => {
    const chunks: Beacon[][] = [];
    for (let i = 0; i < usedBeacons.length; i += COORDS_PER_SHEET) chunks.push(usedBeacons.slice(i, i + COORDS_PER_SHEET));
    return chunks;
  }, [usedBeacons]);
  const sheetCount = 1 + Math.max(coordChunks.length, 0);

  if (parcels.length === 0) {
    return (
      <Card>
        <div className="py-12 text-center text-slate-500">
          <p className="text-lg">No parcels yet</p>
          <p className="mt-1 text-sm">A General Plan shows the whole layout of parcels. Build parcels first.</p>
          <div className="mt-4"><Button onClick={() => setActiveTab("parcels")}>Go to Parcels</Button></div>
        </div>
      </Card>
    );
  }

  // ---- figure transform for the layout sheet ----
  const xs = usedBeacons.map((b) => b.east);
  const ys = usedBeacons.map((b) => b.north);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX || 1, spanY = maxY - minY || 1;
  const FX0 = 30, FY0 = 90, FX1 = 660, FY1 = H - 30;
  const pad = 30;
  const s = Math.min((FX1 - FX0 - 2 * pad) / spanX, (FY1 - FY0 - 2 * pad) / spanY);
  const ox = FX0 + ((FX1 - FX0) - s * spanX) / 2;
  const oyOff = ((FY1 - FY0) - s * spanY) / 2;
  const sx = (e: number) => ox + (e - minX) * s;
  const sy = (n: number) => FY1 - oyOff - (n - minY) * s;

  const schedule = parcels.map((p, i) => ({ p, i, m: parcelMetrics(p.beaconIds, by) }));
  const totalHa = schedule.reduce((a, x) => a + x.m.area_ha, 0);

  function serialize(svg: SVGSVGElement | null): string | null {
    if (!svg) return null;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return new XMLSerializer().serializeToString(clone);
  }
  function download() {
    const svg = serialize(refs.current[sheet]);
    if (!svg) return;
    const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svg}`], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `general-plan-${(meta.name || "layout").replace(/\s+/g, "_")}-sheet${sheet + 1}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }
  function printAll() {
    const all: string[] = [];
    for (let i = 0; i < sheetCount; i++) {
      const svg = serialize(refs.current[i]);
      if (svg) all.push(`<div style="page-break-after:always">${svg}</div>`);
    }
    const w = window.open("", "_blank", "width=1200,height=850");
    if (!w) return;
    w.document.write(
      `<html><head><title>General Plan — ${meta.name}</title>` +
        `<style>@page{size:landscape}body{margin:0}svg{width:100%;height:auto}</style></head>` +
        `<body onload="window.print()">${all.join("")}</body></html>`
    );
    w.document.close();
  }

  const titleBlock = (no: number, label: string) => (
    <>
      <rect x={6} y={6} width={W - 12} height={H - 12} fill="none" stroke="#0f172a" strokeWidth={1.5} />
      <text x={W / 2} y={34} textAnchor="middle" fontSize={19} fontWeight={700} fill="#0f172a">GENERAL PLAN OF {meta.name}</text>
      <text x={W / 2} y={54} textAnchor="middle" fontSize={11} fill="#334155">{label}{meta.location ? ` — ${meta.location}` : ""}</text>
      <text x={W - 20} y={28} textAnchor="end" fontSize={10} fill="#475569">G.P. No. {meta.gpNo || "—"}</text>
      <text x={W - 20} y={H - 16} textAnchor="end" fontSize={9} fill="#64748b">Sheet {no} of {sheetCount}</text>
    </>
  );

  // sheet renderers
  const layoutSheet = (
    <svg ref={(el) => { refs.current[0] = el; }} viewBox={`0 0 ${W} ${H}`} className="w-full bg-white" style={{ border: "1px solid #cbd5e1" }}>
      {titleBlock(1, `Layout of ${parcels.length} parcel(s)`)}
      {/* north arrow */}
      <g transform={`translate(${FX1 - 20},${FY0 + 16})`}>
        <line x1={0} y1={12} x2={0} y2={-10} stroke="#0f172a" strokeWidth={1.5} />
        <polygon points="0,-14 -5,-5 5,-5" fill="#0f172a" />
        <text x={0} y={26} textAnchor="middle" fontSize={10} fill="#0f172a">N</text>
      </g>
      {/* parcels */}
      {schedule.map(({ p, i }) => {
        const pts = ringPoints(p.beaconIds, by);
        if (pts.length < 3) return null;
        const d = pts.map((pp) => `${sx(pp.east)},${sy(pp.north)}`).join(" ");
        const cx = pts.reduce((a, pp) => a + sx(pp.east), 0) / pts.length;
        const cy = pts.reduce((a, pp) => a + sy(pp.north), 0) / pts.length;
        const col = PALETTE[i % PALETTE.length];
        return (
          <g key={p.id}>
            <polygon points={d} fill={col} fillOpacity={0.13} stroke={col} strokeWidth={1.4} />
            <text x={cx} y={cy} textAnchor="middle" fontSize={10} fontWeight={700} fill={col}>{p.number}</text>
          </g>
        );
      })}
      {usedBeacons.map((b) => (
        <g key={b.id}>
          <circle cx={sx(b.east)} cy={sy(b.north)} r={2.6} fill="#0f172a" />
          <text x={sx(b.east) + 4} y={sy(b.north) - 3} fontSize={8} fill="#334155">{b.id}</text>
        </g>
      ))}
      <text x={(FX0 + FX1) / 2} y={H - 14} textAnchor="middle" fontSize={11} fontWeight={700}>SCALE 1:{meta.scale.toLocaleString()}</text>
      {/* parcel schedule (right) */}
      <text x={690} y={92} fontSize={12} fontWeight={700} fill="#0f172a">PARCEL SCHEDULE</text>
      <text x={690} y={110} fontSize={10} fontWeight={600} fill="#475569">No.</text>
      <text x={830} y={110} fontSize={10} fontWeight={600} fill="#475569">Area (m²)</text>
      <text x={930} y={110} fontSize={10} fontWeight={600} fill="#475569">ha</text>
      {schedule.slice(0, 30).map(({ p, i, m }, k) => {
        const y = 126 + k * 15;
        const col = PALETTE[i % PALETTE.length];
        return (
          <g key={p.id}>
            <rect x={690} y={y - 8} width={7} height={7} fill={col} />
            <text x={702} y={y} fontSize={9.5} fill="#0f172a">{p.number || "(none)"}</text>
            <text x={830} y={y} fontSize={9.5} fill="#0f172a">{m.area_m2}</text>
            <text x={930} y={y} fontSize={9.5} fill="#0f172a">{m.area_ha}</text>
          </g>
        );
      })}
      <line x1={690} y1={126 + Math.min(schedule.length, 30) * 15} x2={970} y2={126 + Math.min(schedule.length, 30) * 15} stroke="#cbd5e1" />
      <text x={702} y={126 + Math.min(schedule.length, 30) * 15 + 16} fontSize={10} fontWeight={700}>TOTAL: {totalHa.toFixed(4)} ha</text>
      {schedule.length > 30 && <text x={690} y={126 + 30 * 15 + 34} fontSize={9} fill="#94a3b8">+{schedule.length - 30} more parcel(s) — see digital schedule</text>}
      {/* surveyor / approval block */}
      <line x1={690} y1={H - 130} x2={970} y2={H - 130} stroke="#0f172a" strokeWidth={0.6} />
      <text x={690} y={H - 112} fontSize={10} fill="#334155">Surveyor: {meta.surveyor || "—"}</text>
      <text x={690} y={H - 96} fontSize={10} fill="#334155">Coordinate system: {config.coordinateSystem}</text>
      <rect x={690} y={H - 86} width={280} height={56} fill="none" stroke="#0f172a" strokeWidth={0.6} />
      <text x={830} y={H - 66} textAnchor="middle" fontSize={9.5}>Approved</text>
      <line x1={700} y1={H - 46} x2={960} y2={H - 46} stroke="#0f172a" strokeWidth={0.4} />
      <text x={830} y={H - 36} textAnchor="middle" fontSize={9}>Director of Surveys and Mapping</text>
    </svg>
  );

  const coordSheet = (chunk: Beacon[], idx: number) => {
    const colW = 300;
    const cols = Math.min(3, Math.ceil(chunk.length / 16) || 1);
    const perCol = Math.ceil(chunk.length / cols);
    return (
      <svg key={idx} ref={(el) => { refs.current[idx + 1] = el; }} viewBox={`0 0 ${W} ${H}`} className="w-full bg-white" style={{ border: "1px solid #cbd5e1" }}>
        {titleBlock(idx + 2, "Beacon coordinate schedule")}
        {Array.from({ length: cols }).map((_, c) => {
          const x0 = 30 + c * colW;
          const part = chunk.slice(c * perCol, (c + 1) * perCol);
          return (
            <g key={c}>
              <text x={x0} y={88} fontSize={10} fontWeight={600} fill="#475569">Beacon</text>
              <text x={x0 + 90} y={88} fontSize={10} fontWeight={600} fill="#475569">East (Y)</text>
              <text x={x0 + 190} y={88} fontSize={10} fontWeight={600} fill="#475569">North (X)</text>
              {part.map((b, r) => {
                const y = 104 + r * 13.5;
                return (
                  <g key={b.id}>
                    <text x={x0} y={y} fontSize={9} fill="#0f172a">{b.id}</text>
                    <text x={x0 + 90} y={y} fontSize={9} fill="#0f172a">{b.east.toFixed(2)}</text>
                    <text x={x0 + 190} y={y} fontSize={9} fill="#0f172a">{b.north.toFixed(2)}</text>
                  </g>
                );
              })}
            </g>
          );
        })}
        <text x={30} y={H - 16} fontSize={9} fill="#64748b">System {config.coordinateSystem}</text>
      </svg>
    );
  };

  return (
    <div className="space-y-4">
      <Card title="General Plan details">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Layout / township name"><Input value={meta.name} onChange={set("name")} /></Field>
          <Field label="Location"><Input value={meta.location} onChange={set("location")} placeholder="e.g. Mogoditshane" /></Field>
          <Field label="Surveyor"><Input value={meta.surveyor} onChange={set("surveyor")} /></Field>
          <Field label="G.P. No."><Input value={meta.gpNo} onChange={set("gpNo")} /></Field>
          <Field label="Scale 1:"><Input type="number" value={meta.scale} onChange={set("scale")} /></Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button onClick={download}>⬇ Download sheet SVG</Button>
          <Button variant="ghost" onClick={printAll}>Print all sheets / PDF</Button>
          <span className="ml-2 inline-flex items-center gap-2 text-sm">
            <Button variant="ghost" onClick={() => setSheet((x) => Math.max(0, x - 1))} disabled={sheet === 0}>← Prev</Button>
            <span className="text-slate-600">Sheet {sheet + 1} of {sheetCount}</span>
            <Button variant="ghost" onClick={() => setSheet((x) => Math.min(sheetCount - 1, x + 1))} disabled={sheet >= sheetCount - 1}>Next →</Button>
          </span>
        </div>
      </Card>

      <Card title={`General Plan — Sheet ${sheet + 1}`}>
        {/* Render all sheets (so refs exist for print-all); show only the active one. */}
        <div className="mx-auto max-w-5xl">
          <div style={{ display: sheet === 0 ? "block" : "none" }}>{layoutSheet}</div>
          {coordChunks.map((chunk, idx) => (
            <div key={idx} style={{ display: sheet === idx + 1 ? "block" : "none" }}>{coordSheet(chunk, idx)}</div>
          ))}
        </div>
      </Card>
    </div>
  );
}
