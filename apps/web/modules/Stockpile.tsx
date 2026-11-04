"use client";

import { useEffect, useRef, useState } from "react";
import { apiJson } from "@/lib/api";
import { useStore } from "@/lib/store";
import type { StockpileResult, TopoPoint } from "@/lib/types";
import { Button, Card, Field, Input, Select, Stat } from "@/components/ui";

/** Parse Name,E,N,Z (or Name E N Z whitespace) text into XYZ points. */
function parseXYZ(text: string): { name: string | null; x: number; y: number; z: number }[] {
  const pts: { name: string | null; x: number; y: number; z: number }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.includes(",") ? line.split(",").map(s => s.trim()) : line.split(/\s+/);
    if (parts.length < 3) continue;
    // Try last 3 as numbers (x, y, z)
    const nums = parts.slice(-3).map(Number);
    if (nums.some(isNaN)) continue;
    const name = parts.length >= 4 ? parts[0] : null;
    pts.push({ name, x: nums[0], y: nums[1], z: nums[2] });
  }
  return pts;
}

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

/** Change map: triangles coloured red (cut/removed) or green (fill/added). */
function ChangeCanvas({
  result,
}: {
  result: StockpileResult;
}) {
  const comp = result.comparison!;
  const W = 460, H = 360, PAD = 32;
  const pts = result.points;
  const { stats } = result;
  const sx = stats.bounds.minX, sy = stats.bounds.minY;
  const sw = stats.bounds.maxX - sx || 1, sh = stats.bounds.maxY - sy || 1;
  const scale = Math.min((W - PAD * 2) / sw, (H - PAD * 2) / sh);
  const offX = PAD + ((W - PAD * 2) - sw * scale) / 2;
  const offY = PAD + ((H - PAD * 2) - sh * scale) / 2;
  const tx = (x: number) => offX + (x - sx) * scale;
  const ty = (y: number) => H - (offY + (y - sy) * scale);

  const maxD = Math.max(...comp.faces.map((f) => Math.abs(f.d)), 0.001);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded border border-slate-200 bg-white" style={{ maxHeight: 360 }}>
      {comp.faces.map((f, i) => {
        const a = pts[f.a], b = pts[f.b], c = pts[f.c];
        if (!a || !b || !c) return null;
        const t = Math.min(Math.abs(f.d) / maxD, 1);
        // green = fill (added), red = cut (removed)
        const col = f.d >= 0
          ? `hsl(140,${Math.round(40 + t * 55)}%,${Math.round(55 - t * 15)}%)`
          : `hsl(0,${Math.round(40 + t * 55)}%,${Math.round(55 - t * 15)}%)`;
        return (
          <polygon
            key={i}
            points={`${tx(a.x)},${ty(a.y)} ${tx(b.x)},${ty(b.y)} ${tx(c.x)},${ty(c.y)}`}
            fill={col} fillOpacity={0.75}
            stroke="#334155" strokeWidth={0.3} strokeOpacity={0.4}
          />
        );
      })}
      {/* Previous survey points (grey) */}
      {comp.previous.points.map((p: TopoPoint, i: number) => (
        <circle key={`prev-${i}`} cx={tx(p.x)} cy={ty(p.y)} r={2} fill="#94a3b8" fillOpacity={0.6} />
      ))}
      {/* Current survey points */}
      {pts.map((p, i) => (
        <circle key={`cur-${i}`} cx={tx(p.x)} cy={ty(p.y)} r={2.5} fill="#1e40af" fillOpacity={0.8} />
      ))}
      {/* Legend */}
      <rect x={W - 80} y={8} width={72} height={48} fill="white" fillOpacity={0.85} rx={3} />
      <rect x={W - 74} y={14} width={10} height={10} fill="hsl(140,70%,45%)" rx={1} />
      <text x={W - 60} y={23} fontSize={8} fill="#166534">Fill (added)</text>
      <rect x={W - 74} y={28} width={10} height={10} fill="hsl(0,70%,45%)" rx={1} />
      <text x={W - 60} y={37} fontSize={8} fill="#991b1b">Cut (removed)</text>
      <circle cx={W - 69} cy={47} r={3} fill="#1e40af" fillOpacity={0.8} />
      <text x={W - 60} y={50} fontSize={8} fill="#1e40af">Current</text>
    </svg>
  );
}

/** Isometric 3-D wireframe of the TIN — scroll to zoom, drag to pan. */
function IsoCanvas({ result }: { result: StockpileResult }) {
  const W = 700, H = 460;
  const { points, triangles, stats, datum } = result;

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // azimuth = horizontal rotation (radians), elevation = tilt (radians)
  const [azimuth, setAzimuth] = useState(Math.PI / 4);
  const [elevation, setElevation] = useState(Math.PI / 6);
  const [tool, setTool] = useState<"orbit" | "pan">("orbit");
  const dragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);

  const mcx = (stats.bounds.minX + stats.bounds.maxX) / 2;
  const mcy = (stats.bounds.minY + stats.bounds.maxY) / 2;
  const span = Math.max(
    stats.bounds.maxX - stats.bounds.minX,
    stats.bounds.maxY - stats.bounds.minY,
    stats.maxZ - datum
  ) || 1;
  const sc = Math.min(W, H) * 0.32 / span;

  function project(x: number, y: number, z: number): [number, number] {
    const dx = x - mcx, dy = y - mcy, dz = z - datum;
    // rotate around Z by azimuth
    const rx = dx * Math.cos(azimuth) + dy * Math.sin(azimuth);
    const ry = -dx * Math.sin(azimuth) + dy * Math.cos(azimuth);
    // project with elevation tilt
    const sx = rx * sc;
    const sy = (-dz * Math.cos(elevation) + ry * Math.sin(elevation)) * sc;
    return [W / 2 + sx, H * 0.6 + sy];
  }

  function handleWheel(e: React.WheelEvent<SVGSVGElement>) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const rect = svgRef.current!.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    const my = ((e.clientY - rect.top) / rect.height) * H;
    setZoom((z) => {
      const nz = Math.min(Math.max(z * factor, 0.2), 20);
      setPan((p) => ({ x: mx - (mx - p.x) * (nz / z), y: my - (my - p.y) * (nz / z) }));
      return nz;
    });
  }

  function handleMouseDown(e: React.MouseEvent<SVGSVGElement>) {
    dragging.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
  }

  function handleMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!dragging.current) return;
    const dx = e.clientX - lastMouse.current.x;
    const dy = e.clientY - lastMouse.current.y;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    if (tool === "orbit") {
      setAzimuth((a) => a + dx * 0.008);
      setElevation((el) => Math.min(Math.max(el - dy * 0.008, 0.05), Math.PI / 2 - 0.05));
    } else {
      const rect = svgRef.current!.getBoundingClientRect();
      setPan((p) => ({ x: p.x + dx * (W / rect.width), y: p.y + dy * (H / rect.height) }));
    }
  }

  function handleMouseUp() { dragging.current = false; }

  // Sort triangles back-to-front for correct painter's algorithm
  const sorted = [...triangles].sort((ta, tb) => {
    const za = ((points[ta.a]?.z ?? 0) + (points[ta.b]?.z ?? 0) + (points[ta.c]?.z ?? 0)) / 3;
    const zb = ((points[tb.a]?.z ?? 0) + (points[tb.b]?.z ?? 0) + (points[tb.c]?.z ?? 0)) / 3;
    return za - zb;
  });

  const isModified = zoom !== 1 || pan.x !== 0 || pan.y !== 0 || azimuth !== Math.PI / 4 || elevation !== Math.PI / 6;
  const cursor = tool === "orbit" ? (dragging.current ? "grabbing" : "crosshair") : (dragging.current ? "grabbing" : "grab");

  return (
    <div className="relative">
      {/* Toolbar */}
      <div className="mb-1 flex items-center gap-2">
        <button
          onClick={() => setTool("orbit")}
          className={`rounded border px-3 py-1 text-xs font-medium ${tool === "orbit" ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
        >
          Orbit
        </button>
        <button
          onClick={() => setTool("pan")}
          className={`rounded border px-3 py-1 text-xs font-medium ${tool === "pan" ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
        >
          Pan
        </button>
        {isModified && (
          <button
            onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); setAzimuth(Math.PI / 4); setElevation(Math.PI / 6); }}
            className="ml-auto rounded border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-500 hover:bg-slate-50"
          >
            Reset view
          </button>
        )}
        <span className="ml-auto text-xs text-slate-400">Scroll = zoom · Orbit = rotate · Pan = move</span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full rounded border border-slate-200 bg-slate-50"
        style={{ height: 460, cursor }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
          {sorted.map((t, i) => {
            const a = points[t.a], b = points[t.b], c = points[t.c];
            if (!a || !b || !c) return null;
            const [ax, ay] = project(a.x, a.y, a.z);
            const [bx, by] = project(b.x, b.y, b.z);
            const [cx2, cy2] = project(c.x, c.y, c.z);
            const avgZ = (a.z + b.z + c.z) / 3;
            const fill = elevColor(avgZ, stats.minZ, stats.maxZ);
            return (
              <polygon
                key={i}
                points={`${ax},${ay} ${bx},${by} ${cx2},${cy2}`}
                fill={fill} fillOpacity={0.75}
                stroke="#334155" strokeWidth={0.5} strokeOpacity={0.4}
              />
            );
          })}
        </g>
        <text x={W / 2} y={H - 6} fontSize={10} fill="#94a3b8" textAnchor="middle">
          Isometric 3D view (TIN surface)
        </text>
      </svg>
    </div>
  );
}

export function Stockpile() {
  const { stockpileResult, setStockpileResult, stockpileInput, setStockpileInput, importResult } = useStore();
  const init = (stockpileInput ?? {}) as {
    interval?: string; datumMode?: string; manualDatum?: string;
  };
  const [interval, setInterval] = useState(init.interval ?? "0.5");
  const [datumMode, setDatumMode] = useState(init.datumMode ?? "auto");
  const [manualDatum, setManualDatum] = useState(init.manualDatum ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"plan" | "3d" | "change">("plan");

  // Direct file upload (alternative to Data Import)
  const fileRef = useRef<HTMLInputElement>(null);
  const [directPoints, setDirectPoints] = useState<{ name: string | null; x: number; y: number; z: number }[] | null>(null);
  const [directFileName, setDirectFileName] = useState<string | null>(null);

  function loadDirectFile(file: File) {
    setDirectPoints(null);
    setDirectFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const pts = parseXYZ((ev.target?.result as string) ?? "");
      setDirectPoints(pts.length >= 3 ? pts : []);
    };
    reader.readAsText(file);
  }

  useEffect(() => {
    setStockpileInput({ interval, datumMode, manualDatum });
  }, [interval, datumMode, manualDatum, setStockpileInput]);

  // Build XYZ points: prefer directly uploaded file, fall back to importResult
  const importedPoints = (importResult?.rows ?? [])
    .filter((row) => row.east != null && row.north != null && row.rl != null)
    .map((row) => ({ name: row.beaconId, x: row.east!, y: row.north!, z: row.rl! }));

  const activePoints = directPoints ?? importedPoints;
  const hasPoints = activePoints.length >= 3;
  const hasNoRL = !directPoints && importResult && importResult.rows.length > 0 && importedPoints.length === 0;

  async function process() {
    setError(null);
    if (!hasPoints) { setError("No elevation data found. Upload a CSV file with Name, E, N, RL columns."); return; }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        points: activePoints,
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
          {/* Survey data: direct upload OR from Data Import */}
          <Card title="Survey Data (Name, E, N, RL)">
            <div className="space-y-3">
              {/* Direct upload */}
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => fileRef.current?.click()}>Upload CSV / TXT</Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,.txt"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) loadDirectFile(f); e.target.value = ""; }}
                />
                {directFileName && (
                  <>
                    <span className="text-sm text-slate-600">{directFileName}</span>
                    <button onClick={() => { setDirectPoints(null); setDirectFileName(null); }} className="text-xs text-red-500 hover:underline">Clear</button>
                  </>
                )}
              </div>

              {/* Status */}
              {directPoints !== null ? (
                directPoints.length < 3 ? (
                  <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">
                    File parsed but fewer than 3 valid points found. Check format: Name, Easting, Northing, RL (comma or space separated).
                  </div>
                ) : (
                  <div className="rounded-md bg-green-50 border border-green-200 p-3 text-sm text-green-700">
                    <strong>{directPoints.length} points</strong> loaded from <em>{directFileName}</em>.
                  </div>
                )
              ) : hasNoRL ? (
                <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-700">
                  Data Import file has no RL column. Upload a file above with a 4th elevation column.
                </div>
              ) : importedPoints.length >= 3 ? (
                <div className="rounded-md bg-blue-50 border border-blue-200 p-3 text-sm text-blue-700">
                  Using <strong>{importedPoints.length} points</strong> from Data Import (<em>{importResult?.filename}</em>). Upload a file above to use different data.
                </div>
              ) : (
                <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-700">
                  Upload a CSV/TXT file above, or import data via the Data Import tab first.
                </div>
              )}
            </div>
          </Card>

          <Card title="Computation Settings">
            <div className="space-y-3">
              <Field label="Contour interval (m)">
                <Input value={interval} onChange={setInterval} placeholder="0 = auto" />
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
                  <Input value={manualDatum} onChange={setManualDatum} placeholder="e.g. 101.00" />
                </Field>
              )}
              <Button onClick={process} disabled={busy || !hasPoints} className="w-full">
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
              {/* Clear button */}
              <div className="flex justify-end">
                <button
                  onClick={() => { setStockpileResult(null); setDirectPoints(null); setDirectFileName(null); if (fileRef.current) fileRef.current.value = ""; }}
                  className="text-xs font-medium text-red-500 underline hover:text-red-700"
                >
                  ✕ Clear results
                </button>
              </div>
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
                <div className="mb-2 flex gap-1 flex-wrap">
                  {(["plan", "3d", ...(r.comparison ? ["change" as const] : [])] as ("plan" | "3d" | "change")[]).map((v) => (
                    <button
                      key={v}
                      onClick={() => setView(v)}
                      className={`rounded px-3 py-1 text-xs font-medium transition ${
                        view === v ? "bg-brand text-white" : "border border-slate-200 text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      {v === "plan" ? "Plan View (DSM)" : v === "3d" ? "3D Wireframe" : "Change Map"}
                    </button>
                  ))}
                </div>
                {view === "plan" && <PlanCanvas result={r} />}
                {view === "3d" && <IsoCanvas result={r} />}
                {view === "change" && r.comparison && <ChangeCanvas result={r} />}
              </div>

              {/* Surface comparison results */}
              {r.comparison && (
                <Card title="Surface Comparison">
                  <div className="space-y-3">
                    <div className="grid grid-cols-3 gap-3">
                      <Stat label="Fill (added)" value={`${fmt(r.comparison.fill_m3)} m³`} />
                      <Stat label="Cut (removed)" value={`${fmt(r.comparison.cut_m3)} m³`} />
                      <Stat label="Net change" value={`${r.comparison.net_m3 >= 0 ? "+" : ""}${fmt(r.comparison.net_m3)} m³`} />
                    </div>
                    <dl className="space-y-1 text-sm">
                      <div className="flex justify-between">
                        <dt className="text-slate-500">Previous survey volume</dt>
                        <dd className="font-medium">{fmt(r.comparison.previous.volume_m3)} m³</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-slate-500">Current survey volume</dt>
                        <dd className="font-medium">{fmt(r.volume_m3)} m³</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-slate-500">Previous survey points</dt>
                        <dd className="font-medium">{r.comparison.previous.stats.count}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-slate-500">Triangles compared</dt>
                        <dd className="font-medium">{r.comparison.faces.length}</dd>
                      </div>
                    </dl>
                    {r.comparison.notes.length > 0 && (
                      <ul className="space-y-0.5">
                        {r.comparison.notes.map((n, i) => (
                          <li key={i} className="text-xs text-slate-500">{n}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </Card>
              )}

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
