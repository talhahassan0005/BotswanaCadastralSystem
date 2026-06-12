"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { apiJson } from "@/lib/api";
import { useStore } from "@/lib/store";
import type { TopoResult } from "@/lib/types";
import { Button, Card, Field, Input, Stat } from "@/components/ui";

// A 25-point levelling grid (30 m spacing) over a low hill — relief ~8.5 m.
const SAMPLE = `Point,Easting,Northing,RL
P1,50000,72000,101.2
P2,50030,72000,102.0
P3,50060,72000,102.6
P4,50090,72000,102.1
P5,50120,72000,101.0
P6,50000,72030,102.1
P7,50030,72030,104.3
P8,50060,72030,106.0
P9,50090,72030,104.6
P10,50120,72030,102.3
P11,50000,72060,102.8
P12,50030,72060,106.2
P13,50060,72060,109.5
P14,50090,72060,106.8
P15,50120,72060,102.9
P16,50000,72090,102.0
P17,50030,72090,104.8
P18,50060,72090,106.5
P19,50090,72090,105.0
P20,50120,72090,102.4
P21,50000,72120,101.1
P22,50030,72120,102.3
P23,50060,72120,103.0
P24,50090,72120,102.5
P25,50120,72120,101.2`;

export function Topographic() {
  const { topoResult, setTopoResult, setActiveTab, topoInput, setTopoInput } = useStore();
  const init = (topoInput ?? {}) as { text?: string; interval?: string; gridOn?: boolean; gridStep?: string };
  const [text, setText] = useState(init.text ?? "");
  const [interval, setIntervalInput] = useState(init.interval ?? "0");
  const [gridOn, setGridOn] = useState(init.gridOn ?? true);
  const [gridStep, setGridStep] = useState(init.gridStep ?? ""); // blank = auto
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Persist inputs into the project bundle (synchronous ref write).
  useEffect(() => {
    setTopoInput({ text, interval, gridOn, gridStep });
  }, [text, interval, gridOn, gridStep, setTopoInput]);

  async function process(src?: string) {
    const payload = (src ?? text).trim();
    setError(null);
    if (!payload) {
      setError("Paste or load topographic points first (Name, E, N, RL).");
      return;
    }
    setBusy(true);
    try {
      const result = await apiJson<TopoResult>("/topo", {
        text: payload,
        interval: Number(interval) || 0,
      });
      setTopoResult(result);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function loadSample() {
    setText(SAMPLE);
    process(SAMPLE);
  }

  function onFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? "");
      setText(content);
      process(content);
    };
    reader.readAsText(file);
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
      {/* Controls */}
      <div className="space-y-4">
        <Card title="Levelled Points">
          <p className="mb-2 text-xs text-slate-500">
            One point per line: <code>Name, Easting, Northing, RL</code> (name optional).
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={9}
            placeholder={"P1, 50000, 72000, 101.2\nP2, 50030, 72000, 102.0\n…"}
            className="w-full rounded-lg border border-slate-200 p-3 font-mono text-xs focus:border-brand focus:outline-none"
          />
          <div className="mt-3">
            <Field label="Contour interval (m) — 0 = auto">
              <Input type="number" value={interval} onChange={setIntervalInput} placeholder="0" />
            </Field>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => process()}>
              {busy ? "Processing…" : "Build surface"}
            </Button>
            <Button variant="ghost" onClick={() => fileRef.current?.click()}>
              File
            </Button>
            <Button variant="ghost" onClick={loadSample}>
              Load sample
            </Button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
            }}
          />
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </Card>

        {topoResult && (
          <Card title="Surface Summary">
            <dl className="space-y-2 text-sm">
              <Row label="Points / triangles" value={`${topoResult.stats.count} / ${topoResult.stats.triangles}`} />
              <Row label="RL range" value={`${topoResult.stats.minZ} – ${topoResult.stats.maxZ} m`} />
              <Row label="Relief" value={`${topoResult.stats.relief} m`} />
              <Row label="Mean RL" value={`${topoResult.stats.meanZ} m`} />
              <Row label="Surveyed area" value={`${(topoResult.stats.planArea / 10000).toFixed(4)} ha`} />
              <Row label="Contour interval" value={`${topoResult.interval} m`} />
            </dl>
            <div className="mt-4 flex flex-col gap-2">
              <Button variant="ghost" onClick={() => setActiveTab("volume")}>
                Compute volume from this surface →
              </Button>
              <Button variant="ghost" onClick={() => setActiveTab("editor")}>
                Edit / draw manually →
              </Button>
            </div>
          </Card>
        )}
      </div>

      {/* Map + results */}
      <div className="space-y-5">
        {!topoResult ? (
          <Card>
            <div className="py-16 text-center text-slate-400">
              <p className="text-lg">No surface yet</p>
              <p className="mt-1 text-sm">
                Load levelled (E, N, RL) points and build the surface to see the TIN, contours and
                spot heights.
              </p>
            </div>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat value={topoResult.stats.count} label="Spot heights" />
              <Stat value={topoResult.stats.relief.toFixed(1)} label="Relief (m)" tone="brand" />
              <Stat value={topoResult.contours.length} label="Contours" />
              <Stat value={(topoResult.stats.planArea / 10000).toFixed(2)} label="Area (ha)" />
            </div>

            <Card title="Surface — TIN, Contours & Spot Heights">
              <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-slate-600">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={gridOn} onChange={(e) => setGridOn(e.target.checked)} /> Coordinate grid
                </label>
                <label className="flex items-center gap-1.5">
                  Interval (m, blank = auto)
                  <input value={gridStep} onChange={(e) => setGridStep(e.target.value)} placeholder="auto"
                    className="w-20 rounded border border-slate-200 px-2 py-0.5" />
                </label>
              </div>
              <TopoMap result={topoResult} gridOn={gridOn} gridStep={Number(gridStep) || 0} />
              <Legend minZ={topoResult.stats.minZ} maxZ={topoResult.stats.maxZ} />
            </Card>

            <Card title="Contour Index">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase text-slate-500">
                    <tr>
                      <th className="py-2 pr-4">RL (m)</th>
                      <th className="py-2 pr-4">Segments</th>
                      <th className="py-2 pr-4">Length (m)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topoResult.contours.map((c) => (
                      <tr key={c.level} className="border-t border-slate-100">
                        <td className="py-2 pr-4 font-medium">{c.level.toFixed(2)}</td>
                        <td className="py-2 pr-4">{c.segments.length}</td>
                        <td className="py-2 pr-4">{contourLength(c.segments).toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SVG surface map
// ---------------------------------------------------------------------------
function TopoMap({ result, gridOn, gridStep }: { result: TopoResult; gridOn: boolean; gridStep: number }) {
  const W = 760;
  const H = 560;
  const pad = 40;
  const { points, triangles, contours, stats } = result;

  const { minX, minY, maxX, maxY } = stats.bounds;
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const drawW = spanX * scale;
  const drawH = spanY * scale;
  const offX = (W - drawW) / 2;
  const offY = (H - drawH) / 2;
  const toX = (e: number) => offX + (e - minX) * scale;
  const toY = (n: number) => offY + (maxY - n) * scale; // north up

  const showLabels = points.length <= 60;
  const majorEvery = 5;

  // Labelled coordinate (E/N) grid.
  const step = gridStep > 0 ? gridStep : niceStep(Math.max(spanX, spanY) / 6);
  const gridEls: JSX.Element[] = [];
  if (gridOn && step > 0 && spanX / step < 200 && spanY / step < 200) {
    for (let e = Math.ceil(minX / step) * step; e <= maxX + 1e-6; e += step) {
      const sx = toX(e);
      gridEls.push(<line key={`gx${e}`} x1={sx} y1={offY} x2={sx} y2={offY + drawH} stroke="#cbd5e1" strokeWidth={0.6} strokeDasharray="2 4" />);
      gridEls.push(<text key={`gxt${e}`} x={sx} y={offY + drawH + 11} textAnchor="middle" fontSize={8} fill="#64748b">E {Math.round(e)}</text>);
    }
    for (let n = Math.ceil(minY / step) * step; n <= maxY + 1e-6; n += step) {
      const sy = toY(n);
      gridEls.push(<line key={`gy${n}`} x1={offX} y1={sy} x2={offX + drawW} y2={sy} stroke="#cbd5e1" strokeWidth={0.6} strokeDasharray="2 4" />);
      gridEls.push(<text key={`gyt${n}`} x={offX - 3} y={sy + 3} textAnchor="end" fontSize={8} fill="#64748b">N {Math.round(n)}</text>);
    }
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: "100%", height: "auto", background: "#f8fafc", borderRadius: 12 }}
    >
      {/* Coordinate grid (underlay) */}
      {gridEls}

      {/* TIN faces shaded by mean elevation */}
      {triangles.map((t, i) => {
        const a = points[t.a],
          b = points[t.b],
          c = points[t.c];
        const meanZ = (a.z + b.z + c.z) / 3;
        return (
          <polygon
            key={`t${i}`}
            points={`${toX(a.x)},${toY(a.y)} ${toX(b.x)},${toY(b.y)} ${toX(c.x)},${toY(c.y)}`}
            fill={elevColor(meanZ, stats.minZ, stats.maxZ)}
            stroke="#ffffff"
            strokeWidth={0.4}
            opacity={0.92}
          />
        );
      })}

      {/* Contour lines */}
      {contours.map((c, li) => {
        // "Major" (index) contours by elevation, not array position — robust to
        // levels dropped because they produced no segments.
        const major =
          result.interval > 0
            ? Math.round(c.level / result.interval) % majorEvery === 0
            : li % majorEvery === 0;
        return (
          <g key={`c${c.level}`}>
            {c.segments.map((s, si) => (
              <line
                key={si}
                x1={toX(s[0][0])}
                y1={toY(s[0][1])}
                x2={toX(s[1][0])}
                y2={toY(s[1][1])}
                stroke={major ? "#7c2d12" : "#a16207"}
                strokeWidth={major ? 1.4 : 0.7}
                opacity={0.85}
              />
            ))}
            {/* label the first segment of each major contour */}
            {major && c.segments[0] && (
              <text
                x={toX(c.segments[0][0][0])}
                y={toY(c.segments[0][0][1])}
                fontSize={9}
                fill="#7c2d12"
                fontWeight="bold"
              >
                {c.level}
              </text>
            )}
          </g>
        );
      })}

      {/* Spot heights */}
      {points.map((p, i) => (
        <g key={`p${i}`}>
          <circle cx={toX(p.x)} cy={toY(p.y)} r={2} fill="#0f172a" />
          {showLabels && (
            <text x={toX(p.x) + 3} y={toY(p.y) - 3} fontSize={8} fill="#334155">
              {p.z.toFixed(1)}
            </text>
          )}
        </g>
      ))}

      {/* North arrow */}
      <g transform={`translate(${W - 28}, 30)`}>
        <line x1={0} y1={16} x2={0} y2={-12} stroke="#0f172a" strokeWidth={1.2} />
        <polygon points="0,-18 -4,-8 4,-8" fill="#0f172a" />
        <text x={0} y={30} textAnchor="middle" fontSize={10} fontWeight="bold" fill="#0f172a">
          N
        </text>
      </g>
    </svg>
  );
}

function Legend({ minZ, maxZ }: { minZ: number; maxZ: number }) {
  const stops = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div className="mt-3 flex items-center gap-3 text-xs text-slate-500">
      <span>{minZ} m</span>
      <div className="flex h-3 flex-1 overflow-hidden rounded-full">
        {stops.map((s, i) => (
          <div key={i} className="flex-1" style={{ background: elevColor(minZ + s * (maxZ - minZ), minZ, maxZ) }} />
        ))}
      </div>
      <span>{maxZ} m</span>
      <span className="ml-3 flex items-center gap-1">
        <span className="inline-block h-0.5 w-4" style={{ background: "#7c2d12" }} /> contour
      </span>
    </div>
  );
}

// Green (low) -> yellow (mid) -> brown (high) hypsometric ramp.
function elevColor(z: number, minZ: number, maxZ: number): string {
  const t = maxZ > minZ ? (z - minZ) / (maxZ - minZ) : 0.5;
  const low = [26, 152, 80]; // #1a9850
  const mid = [255, 255, 191]; // #ffffbf
  const high = [140, 81, 10]; // #8c510a
  const [r, g, b] =
    t < 0.5
      ? lerp(low, mid, t / 0.5)
      : lerp(mid, high, (t - 0.5) / 0.5);
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

function lerp(a: number[], b: number[], t: number): number[] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function niceStep(target: number): number {
  if (!isFinite(target) || target <= 0) return 0;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const n = target / pow;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * pow;
}

function contourLength(segments: [[number, number], [number, number]][]): number {
  let len = 0;
  for (const s of segments) len += Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]);
  return len;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-800">{value}</dd>
    </div>
  );
}
