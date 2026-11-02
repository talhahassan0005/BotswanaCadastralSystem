"use client";

import { useEffect, useRef, useState } from "react";
import { apiJson } from "@/lib/api";
import { useStore } from "@/lib/store";
import type { StockpileResult } from "@/lib/types";
import { Button, Card, Field, Input, Select, Stat } from "@/components/ui";

const SAMPLE = `Point,Easting,Northing,RL
P1,1000.00,1000.00,102.10
P2,1005.00,1000.00,103.50
P3,1010.00,1000.00,104.80
P4,1015.00,1000.00,103.20
P5,1020.00,1000.00,102.00
P6,1000.00,1005.00,103.40
P7,1005.00,1005.00,106.20
P8,1010.00,1005.00,109.50
P9,1015.00,1005.00,106.80
P10,1020.00,1005.00,102.90
P11,1000.00,1010.00,102.80
P12,1005.00,1010.00,106.50
P13,1010.00,1010.00,112.30
P14,1015.00,1010.00,107.10
P15,1020.00,1010.00,103.10
P16,1000.00,1015.00,102.20
P17,1005.00,1015.00,104.90
P18,1010.00,1015.00,106.70
P19,1015.00,1015.00,105.00
P20,1020.00,1015.00,102.50
P21,1000.00,1020.00,101.80
P22,1005.00,1020.00,102.40
P23,1010.00,1020.00,103.10
P24,1015.00,1020.00,102.60
P25,1020.00,1020.00,101.90`;

function fmt(n: number, dp = 2) {
  return n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Elevation → hue from blue (low) through green to red (high). */
function elevColor(z: number, minZ: number, maxZ: number): string {
  const t = maxZ === minZ ? 0.5 : (z - minZ) / (maxZ - minZ);
  // 240° (blue) → 120° (green) → 0° (red)
  const h = Math.round(240 - t * 240);
  return `hsl(${h},80%,45%)`;
}

/** Simple 2-D plan canvas: points coloured by elevation + contour lines. */
function PlanCanvas({ result }: { result: StockpileResult }) {
  const W = 460, H = 360, PAD = 32;
  const { stats, points, contours, datum, topPoint } = result;
  const sx = stats.bounds.minX, sy = stats.bounds.minY;
  const sw = stats.bounds.maxX - sx || 1, sh = stats.bounds.maxY - sy || 1;
  const scaleX = (W - PAD * 2) / sw;
  const scaleY = (H - PAD * 2) / sh;
  const scale = Math.min(scaleX, scaleY);
  const offX = PAD + ((W - PAD * 2) - sw * scale) / 2;
  const offY = PAD + ((H - PAD * 2) - sh * scale) / 2;
  const tx = (x: number) => offX + (x - sx) * scale;
  const ty = (y: number) => H - (offY + (y - sy) * scale);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded border border-slate-200 bg-white" style={{ maxHeight: 360 }}>
      {/* Contour lines */}
      {contours.map((c) =>
        c.segments.map((seg, si) => (
          <line
            key={`c${c.level}-${si}`}
            x1={tx(seg[0][0])} y1={ty(seg[0][1])}
            x2={tx(seg[1][0])} y2={ty(seg[1][1])}
            stroke="#94a3b8" strokeWidth={0.8} strokeOpacity={0.7}
          />
        ))
      )}
      {/* Points coloured by elevation */}
      {points.map((p, i) => {
        const cx = tx(p.x), cy = ty(p.y);
        const col = elevColor(p.z, stats.minZ, stats.maxZ);
        const isBase = p.z <= datum + 0.01;
        const isTop = p.x === topPoint.x && p.y === topPoint.y;
        return (
          <g key={i}>
            <circle cx={cx} cy={cy} r={isTop ? 6 : isBase ? 4 : 3.5}
              fill={col} stroke={isTop ? "#dc2626" : isBase ? "#1e40af" : col}
              strokeWidth={isTop || isBase ? 1.5 : 0} />
            {p.name && (
              <text x={cx + 5} y={cy - 4} fontSize={7} fill="#334155">{p.name}</text>
            )}
          </g>
        );
      })}
      {/* Legend */}
      {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
        const z = stats.minZ + t * (stats.maxZ - stats.minZ);
        const col = elevColor(z, stats.minZ, stats.maxZ);
        return (
          <g key={i}>
            <rect x={W - 22} y={PAD + i * 16} width={12} height={12} fill={col} rx={2} />
            <text x={W - 6} y={PAD + i * 16 + 9} fontSize={7} fill="#475569" textAnchor="end">
              {fmt(z, 1)}
            </text>
          </g>
        );
      })}
      <text x={W - 10} y={PAD - 4} fontSize={7} fill="#475569" textAnchor="end">RL (m)</text>
    </svg>
  );
}

/** Isometric 3-D wireframe of the TIN. */
function IsoCanvas({ result }: { result: StockpileResult }) {
  const W = 460, H = 340;
  const { points, triangles, stats, datum } = result;

  // Isometric projection: x→right-down, y→left-down, z→up
  const COS30 = Math.cos(Math.PI / 6);
  const SIN30 = Math.sin(Math.PI / 6);
  const cx = (stats.bounds.minX + stats.bounds.maxX) / 2;
  const cy = (stats.bounds.minY + stats.bounds.maxY) / 2;
  const span = Math.max(
    stats.bounds.maxX - stats.bounds.minX,
    stats.bounds.maxY - stats.bounds.minY,
    stats.maxZ - datum
  ) || 1;
  const sc = Math.min(W, H) * 0.32 / span;

  function iso(x: number, y: number, z: number): [number, number] {
    const dx = x - cx, dy = y - cy, dz = z - datum;
    const sx = (dx - dy) * COS30 * sc;
    const sy = -(dz * sc) + (dx + dy) * SIN30 * sc;
    return [W / 2 + sx, H * 0.65 + sy];
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded border border-slate-200 bg-slate-50" style={{ maxHeight: 340 }}>
      {triangles.map((t, i) => {
        const a = points[t.a], b = points[t.b], c = points[t.c];
        if (!a || !b || !c) return null;
        const [ax, ay] = iso(a.x, a.y, a.z);
        const [bx, by] = iso(b.x, b.y, b.z);
        const [cx2, cy2] = iso(c.x, c.y, c.z);
        const avgZ = (a.z + b.z + c.z) / 3;
        const fill = elevColor(avgZ, stats.minZ, stats.maxZ);
        return (
          <polygon
            key={i}
            points={`${ax},${ay} ${bx},${by} ${cx2},${cy2}`}
            fill={fill} fillOpacity={0.7}
            stroke="#334155" strokeWidth={0.4} strokeOpacity={0.5}
          />
        );
      })}
      <text x={W / 2} y={H - 6} fontSize={9} fill="#64748b" textAnchor="middle">
        Isometric 3D view (TIN surface)
      </text>
    </svg>
  );
}

export function Stockpile() {
  const { stockpileResult, setStockpileResult, stockpileInput, setStockpileInput } = useStore();
  const init = (stockpileInput ?? {}) as {
    text?: string; interval?: string; datumMode?: string; manualDatum?: string;
  };
  const [text, setText] = useState(init.text ?? "");
  const [interval, setInterval] = useState(init.interval ?? "0.5");
  const [datumMode, setDatumMode] = useState(init.datumMode ?? "auto");
  const [manualDatum, setManualDatum] = useState(init.manualDatum ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"plan" | "3d">("plan");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setStockpileInput({ text, interval, datumMode, manualDatum });
  }, [text, interval, datumMode, manualDatum, setStockpileInput]);

  async function process(src?: string) {
    const payload = (src ?? text).trim();
    setError(null);
    if (!payload) { setError("Load or paste XYZ points first."); return; }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        text: payload,
        interval: Number(interval) || 0,
      };
      if (datumMode === "manual" && manualDatum.trim()) {
        body.datum = Number(manualDatum);
      }
      const result = await apiJson<StockpileResult>("/stockpile", body);
      setStockpileResult(result);
    } catch (e: any) {
      setError(e.message);
      setStockpileResult(null);
    } finally {
      setBusy(false);
    }
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target?.result as string;
      setText(content);
      process(content);
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  const r = stockpileResult;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold text-slate-800">Stockpile Volume</h2>
        <span className="rounded-full bg-slate-100 px-3 py-0.5 text-xs text-slate-500">
          TIN surface · DSM / DTM · Cut &amp; fill
        </span>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        {/* ── Left: input ─────────────────────────────────────────── */}
        <div className="space-y-4">
          <Card title="Load Points">
            <div className="space-y-3">
              <p className="text-sm text-slate-500">
                CSV or tab-delimited with columns: <strong>Name, Easting, Northing, RL</strong> (one point per line).
              </p>
              <div className="flex gap-2">
                <Button onClick={() => fileRef.current?.click()} disabled={busy}>
                  Load CSV file
                </Button>
                <Button variant="ghost" onClick={() => { setText(SAMPLE); }} disabled={busy}>
                  Load sample
                </Button>
                <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden" onChange={handleFile} />
              </div>
              <textarea
                className="w-full rounded-md border border-slate-200 bg-white p-2 font-mono text-xs text-slate-700 focus:border-brand focus:outline-none"
                rows={8}
                placeholder="Paste XYZ points here…"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </div>
          </Card>

          <Card title="Computation Settings">
            <div className="space-y-3">
              <Field label="Contour interval (m)">
                <Input
                  value={interval}
                  onChange={setInterval}
                  placeholder="0 = auto"
                />
              </Field>
              <Field label="Base datum">
                <Select
                  value={datumMode}
                  onChange={setDatumMode}
                  options={[
                    { value: "auto", label: "Auto (lowest point)" },
                    { value: "manual", label: "Manual" },
                  ]}
                />
              </Field>
              {datumMode === "manual" && (
                <Field label="Base RL (m)">
                  <Input
                    value={manualDatum}
                    onChange={setManualDatum}
                    placeholder="e.g. 101.00"
                  />
                </Field>
              )}
              <Button onClick={() => process()} disabled={busy || !text.trim()} className="w-full">
                {busy ? "Processing…" : "Calculate Stockpile Volume"}
              </Button>
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
          </Card>
        </div>

        {/* ── Right: results ──────────────────────────────────────── */}
        <div className="space-y-4">
          {r ? (
            <>
              {/* Key metrics */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label="Bulk Volume" value={`${fmt(r.volume_m3)} m³`} />
                <Stat label="Base Area" value={`${fmt(r.baseArea_m2)} m²`} />
                <Stat label="Max Height" value={`${fmt(r.height_m)} m`} />
              </div>

              {/* DSM / DTM */}
              <div className="grid gap-3 sm:grid-cols-2">
                <Card title="DSM (Surface Model)">
                  <dl className="space-y-1 text-sm">
                    <div className="flex justify-between"><dt className="text-slate-500">Min RL</dt><dd className="font-medium">{fmt(r.stats.minZ, 3)} m</dd></div>
                    <div className="flex justify-between"><dt className="text-slate-500">Max RL</dt><dd className="font-medium">{fmt(r.stats.maxZ, 3)} m</dd></div>
                    <div className="flex justify-between"><dt className="text-slate-500">Mean RL</dt><dd className="font-medium">{fmt(r.stats.meanZ, 3)} m</dd></div>
                    <div className="flex justify-between"><dt className="text-slate-500">Relief</dt><dd className="font-medium">{fmt(r.stats.relief, 3)} m</dd></div>
                    <div className="flex justify-between"><dt className="text-slate-500">Points</dt><dd className="font-medium">{r.stats.count}</dd></div>
                    <div className="flex justify-between"><dt className="text-slate-500">Triangles</dt><dd className="font-medium">{r.stats.triangles}</dd></div>
                  </dl>
                </Card>
                <Card title="DTM (Ground Model)">
                  <dl className="space-y-1 text-sm">
                    <div className="flex justify-between"><dt className="text-slate-500">Base datum</dt><dd className="font-medium">{fmt(r.datum, 3)} m</dd></div>
                    <div className="flex justify-between"><dt className="text-slate-500">Base points</dt><dd className="font-medium">{r.basePoints.length}</dd></div>
                    <div className="flex justify-between"><dt className="text-slate-500">Footprint</dt><dd className="font-medium">{fmt(r.baseArea_m2)} m²</dd></div>
                    <div className="flex justify-between"><dt className="text-slate-500">Contour int.</dt><dd className="font-medium">{fmt(r.interval, 2)} m</dd></div>
                    <div className="flex justify-between"><dt className="text-slate-500">Contour levels</dt><dd className="font-medium">{r.contours.length}</dd></div>
                    {r.topPoint.name && (
                      <div className="flex justify-between"><dt className="text-slate-500">Peak point</dt><dd className="font-medium">{r.topPoint.name} ({fmt(r.topPoint.z, 2)} m)</dd></div>
                    )}
                  </dl>
                </Card>
              </div>

              {/* Viewer tabs */}
              <div>
                <div className="mb-2 flex gap-1">
                  {(["plan", "3d"] as const).map((v) => (
                    <button
                      key={v}
                      onClick={() => setView(v)}
                      className={`rounded px-3 py-1 text-xs font-medium transition ${
                        view === v ? "bg-brand text-white" : "border border-slate-200 text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      {v === "plan" ? "Plan View (DSM)" : "3D Wireframe"}
                    </button>
                  ))}
                </div>
                {view === "plan" ? <PlanCanvas result={r} /> : <IsoCanvas result={r} />}
              </div>

              {/* Contour table */}
              <Card title={`Contour Levels (${r.contours.length})`}>
                <div className="max-h-40 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-500">
                        <th className="pb-1">RL (m)</th>
                        <th className="pb-1">Segments</th>
                        <th className="pb-1">Height above base</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.contours.map((c) => (
                        <tr key={c.level} className="border-t border-slate-100">
                          <td className="py-0.5 font-medium">{fmt(c.level, 2)}</td>
                          <td className="py-0.5">{c.segments.length}</td>
                          <td className="py-0.5">{fmt(c.level - r.datum, 2)} m</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          ) : (
            <Card>
              <div className="py-16 text-center text-slate-400">
                <p className="text-sm">Load a CSV file and click Calculate to see</p>
                <p className="mt-1 text-sm">volume, contours, DSM and DTM results.</p>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
