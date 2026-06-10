"use client";

import { useEffect, useState } from "react";
import { apiJson } from "@/lib/api";
import { useStore } from "@/lib/store";
import type { VolumeMethod, VolumeResult } from "@/lib/types";
import { Button, Card, Field, Input, Select, Stat } from "@/components/ui";

const METHODS: { id: VolumeMethod; label: string; blurb: string }[] = [
  { id: "surface", label: "Surface / TIN", blurb: "Cut & fill vs a datum level or design surface (stockpiles, earthworks)." },
  { id: "section", label: "Cross-section", blurb: "Average-end-area + prismoidal from section areas (roads, channels)." },
  { id: "grid", label: "Grid / borrow-pit", blurb: "Volume from a regular grid of cut/fill depths." },
  { id: "contour", label: "Contour-area", blurb: "Volume between successive contour rings (dams, reservoirs)." },
];

// Form state lives in the parent so it persists with the project (controlled forms).
interface VForms {
  surface: { text: string; mode: string; datum: string; design: string };
  section: { text: string };
  grid: { text: string; dx: string; dy: string };
  contour: { text: string; topHeight: string };
}
function defaultForms(): VForms {
  return {
    surface: { text: "", mode: "datum", datum: "100", design: "" },
    section: { text: SECTION_SAMPLE },
    grid: { text: GRID_SAMPLE, dx: "10", dy: "10" },
    contour: { text: CONTOUR_SAMPLE, topHeight: "0.6" },
  };
}

export function Volume() {
  const { volumeResult, setVolumeResult, volumeInput, setVolumeInput } = useStore();
  const vi = (volumeInput ?? {}) as { method?: VolumeMethod; forms?: VForms };
  const [method, setMethod] = useState<VolumeMethod>(vi.method ?? "surface");
  const [forms, setForms] = useState<VForms>(vi.forms ?? defaultForms());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Persist method + form inputs into the project bundle.
  useEffect(() => { setVolumeInput({ method, forms }); }, [method, forms, setVolumeInput]);
  const setForm = <K extends keyof VForms>(k: K, v: VForms[K]) => setForms((f) => ({ ...f, [k]: v }));

  async function run(body: any) {
    setError(null);
    setBusy(true);
    try {
      const result = await apiJson<VolumeResult>("/volume", { method, ...body });
      setVolumeResult(result);
    } catch (e: any) {
      setError(e.message);
      setVolumeResult(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Method switcher */}
      <div className="flex flex-wrap gap-2">
        {METHODS.map((m) => (
          <button
            key={m.id}
            onClick={() => {
              setMethod(m.id);
              setVolumeResult(null);
              setError(null);
            }}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              method === m.id
                ? "bg-brand text-white shadow-sm"
                : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="-mt-2 text-sm text-slate-500">{METHODS.find((m) => m.id === method)?.blurb}</p>

      <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
        <div>
          {method === "surface" && <SurfaceForm busy={busy} onRun={run} value={forms.surface} onChange={(v) => setForm("surface", v)} />}
          {method === "section" && <SectionForm busy={busy} onRun={run} value={forms.section} onChange={(v) => setForm("section", v)} />}
          {method === "grid" && <GridForm busy={busy} onRun={run} value={forms.grid} onChange={(v) => setForm("grid", v)} />}
          {method === "contour" && <ContourForm busy={busy} onRun={run} value={forms.contour} onChange={(v) => setForm("contour", v)} />}
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        </div>

        <div className="space-y-5">
          {!volumeResult ? (
            <Card>
              <div className="py-16 text-center text-slate-400">
                <p className="text-lg">No volume computed yet</p>
                <p className="mt-1 text-sm">Enter the data on the left and run the computation.</p>
              </div>
            </Card>
          ) : (
            <Results result={volumeResult} />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------
const SURFACE_SAMPLE = `P1,50000,72000,101.2
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

function SurfaceForm({ busy, onRun, value, onChange }: { busy: boolean; onRun: (b: any) => void; value: VForms["surface"]; onChange: (v: VForms["surface"]) => void }) {
  const { topoResult } = useStore();
  const { text, mode, datum, design } = value;
  const set = (patch: Partial<VForms["surface"]>) => onChange({ ...value, ...patch });

  function useTopo() {
    if (!topoResult) return;
    set({ text: topoResult.points.map((p) => `${p.name ?? ""},${p.x},${p.y},${p.z}`).join("\n") });
  }

  return (
    <Card title="Existing Surface (E, N, RL)" icon={<span>⛰</span>}>
      <textarea
        value={text}
        onChange={(e) => set({ text: e.target.value })}
        rows={8}
        placeholder={"P1, 50000, 72000, 101.2\n…"}
        className="w-full rounded-lg border border-slate-200 p-3 font-mono text-xs focus:border-brand focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="ghost" onClick={() => set({ text: SURFACE_SAMPLE })}>Load sample</Button>
        {topoResult && (
          <Button variant="ghost" onClick={useTopo}>Use topo surface</Button>
        )}
      </div>
      <div className="mt-3 space-y-3">
        <Field label="Reference">
          <Select
            value={mode}
            onChange={(m) => set({ mode: m })}
            options={[
              { value: "datum", label: "Horizontal datum level" },
              { value: "surface", label: "Design surface (TIN)" },
            ]}
          />
        </Field>
        {mode === "datum" ? (
          <Field label="Datum / base RL (m)">
            <Input type="number" value={datum} onChange={(v) => set({ datum: v })} placeholder="100" />
          </Field>
        ) : (
          <Field label="Design surface points (E, N, RL)">
            <textarea
              value={design}
              onChange={(e) => set({ design: e.target.value })}
              rows={5}
              placeholder={"D1, 50000, 72000, 103\n…"}
              className="w-full rounded-lg border border-slate-200 p-3 font-mono text-xs focus:border-brand focus:outline-none"
            />
          </Field>
        )}
      </div>
      <div className="mt-4">
        <Button disabled={busy} onClick={() => onRun({ text, mode, datum: Number(datum), designText: design })}>
          {busy ? "Computing…" : "▶ Compute volume"}
        </Button>
      </div>
    </Card>
  );
}

const SECTION_SAMPLE = `0, 12.5, 0
20, 18.2, 0
40, 22.0, 1.5
60, 9.4, 6.0
80, 0, 14.0`;

function SectionForm({ busy, onRun, value, onChange }: { busy: boolean; onRun: (b: any) => void; value: VForms["section"]; onChange: (v: VForms["section"]) => void }) {
  const text = value.text;
  function parse() {
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [chainage, cut, fill] = l.split(/[,\t ]+/).map(Number);
        return { chainage, cut: cut || 0, fill: fill || 0 };
      })
      .filter((s) => Number.isFinite(s.chainage)); // skip header / non-numeric lines
  }
  return (
    <Card title="Cross-sections" icon={<span>⌇</span>}>
      <p className="mb-2 text-xs text-slate-500">
        One section per line: <code>chainage, cut area, fill area</code> (m²).
      </p>
      <textarea
        value={text}
        onChange={(e) => onChange({ text: e.target.value })}
        rows={8}
        className="w-full rounded-lg border border-slate-200 p-3 font-mono text-xs focus:border-brand focus:outline-none"
      />
      <div className="mt-4">
        <Button disabled={busy} onClick={() => onRun({ sections: parse() })}>
          {busy ? "Computing…" : "▶ Compute volume"}
        </Button>
      </div>
    </Card>
  );
}

const GRID_SAMPLE = `1.2 1.5 1.1 0.8
1.6 2.1 1.8 1.0
0.4 0.9 -0.5 -0.9
-0.8 -0.6 -1.1 -1.4`;

function GridForm({ busy, onRun, value, onChange }: { busy: boolean; onRun: (b: any) => void; value: VForms["grid"]; onChange: (v: VForms["grid"]) => void }) {
  const { text, dx, dy } = value;
  const set = (patch: Partial<VForms["grid"]>) => onChange({ ...value, ...patch });
  return (
    <Card title="Depth Grid" icon={<span>▦</span>}>
      <p className="mb-2 text-xs text-slate-500">
        Grid of depths (rows × cols). +ve = cut, −ve = fill.
      </p>
      <textarea
        value={text}
        onChange={(e) => set({ text: e.target.value })}
        rows={6}
        className="w-full rounded-lg border border-slate-200 p-3 font-mono text-xs focus:border-brand focus:outline-none"
      />
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label="Cell size E (m)"><Input type="number" value={dx} onChange={(v) => set({ dx: v })} /></Field>
        <Field label="Cell size N (m)"><Input type="number" value={dy} onChange={(v) => set({ dy: v })} /></Field>
      </div>
      <div className="mt-4">
        <Button disabled={busy} onClick={() => onRun({ text, dx: Number(dx), dy: Number(dy) })}>
          {busy ? "Computing…" : "▶ Compute volume"}
        </Button>
      </div>
    </Card>
  );
}

const CONTOUR_SAMPLE = `100, 8200
101, 6400
102, 4500
103, 2600
104, 900`;

function ContourForm({ busy, onRun, value, onChange }: { busy: boolean; onRun: (b: any) => void; value: VForms["contour"]; onChange: (v: VForms["contour"]) => void }) {
  const { text, topHeight } = value;
  const set = (patch: Partial<VForms["contour"]>) => onChange({ ...value, ...patch });
  function parse() {
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [level, area] = l.split(/[,\t ]+/).map(Number);
        return { level, area: area || 0 };
      })
      .filter((r) => Number.isFinite(r.level)); // skip header / non-numeric lines
  }
  return (
    <Card title="Contour Areas" icon={<span>〰</span>}>
      <p className="mb-2 text-xs text-slate-500">
        One contour per line: <code>RL, enclosed area</code> (m²).
      </p>
      <textarea
        value={text}
        onChange={(e) => set({ text: e.target.value })}
        rows={7}
        className="w-full rounded-lg border border-slate-200 p-3 font-mono text-xs focus:border-brand focus:outline-none"
      />
      <div className="mt-3">
        <Field label="Summit height above top contour (m) — optional">
          <Input type="number" value={topHeight} onChange={(v) => set({ topHeight: v })} />
        </Field>
      </div>
      <div className="mt-4">
        <Button disabled={busy} onClick={() => onRun({ rows: parse(), topHeight: Number(topHeight) })}>
          {busy ? "Computing…" : "▶ Compute volume"}
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
function Results({ result }: { result: VolumeResult }) {
  const showFill = result.method !== "contour";
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat value={fmt(result.cut)} label={result.method === "contour" ? "Volume (m³)" : "Cut (m³)"} tone="brand" />
        {showFill && <Stat value={fmt(result.fill)} label="Fill (m³)" tone="warning" />}
        <Stat value={fmt(result.net)} label="Net (m³)" tone={result.net >= 0 ? "default" : "error"} />
      </div>

      {(result.prismoidalCut != null || result.prismoidalFill != null) && (
        <Card title="Prismoidal (Simpson) Check" icon={<span>∑</span>}>
          <dl className="space-y-2 text-sm">
            {result.prismoidalCut != null && (
              <Row label={result.method === "contour" ? "Prismoidal volume" : "Prismoidal cut"} value={`${fmt(result.prismoidalCut)} m³`} />
            )}
            {result.prismoidalFill != null && <Row label="Prismoidal fill" value={`${fmt(result.prismoidalFill)} m³`} />}
          </dl>
        </Card>
      )}

      {result.faces && result.points && (
        <Card title="Cut / Fill Map" icon={<span>🗺</span>}>
          <CutFillMap result={result} />
          <div className="mt-3 flex items-center gap-3 text-xs text-slate-500">
            <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded" style={{ background: "#dc2626" }} /> cut</span>
            <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded" style={{ background: "#f1f5f9" }} /> balance</span>
            <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded" style={{ background: "#2563eb" }} /> fill</span>
            {result.datum != null && <span className="ml-auto">Datum RL {result.datum} m</span>}
          </div>
        </Card>
      )}

      {result.breakdown.length > 0 && (
        <Card title="Breakdown" icon={<span>▤</span>}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {result.breakdown.map((b, i) => (
                  <tr key={i} className="border-t border-slate-100 first:border-t-0">
                    <td className="py-2 pr-4 text-slate-500">{b.label}</td>
                    <td className="py-2 text-right font-medium text-slate-800">{fmt(b.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {result.notes.length > 0 && (
        <ul className="space-y-1 text-xs text-slate-500">
          {result.notes.map((n, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-0.5 text-brand">◆</span>
              {n}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function CutFillMap({ result }: { result: VolumeResult }) {
  const W = 760;
  const H = 520;
  const pad = 30;
  const pts = result.points!;
  const faces = result.faces!;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxAbs = 1e-6;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  for (const f of faces) maxAbs = Math.max(maxAbs, Math.abs(f.d));
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const offX = (W - spanX * scale) / 2;
  const offY = (H - spanY * scale) / 2;
  const toX = (e: number) => offX + (e - minX) * scale;
  const toY = (n: number) => offY + (maxY - n) * scale;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} xmlns="http://www.w3.org/2000/svg" style={{ width: "100%", height: "auto", background: "#f8fafc", borderRadius: 12 }}>
      {faces.map((f, i) => {
        const a = pts[f.a], b = pts[f.b], c = pts[f.c];
        return (
          <polygon
            key={i}
            points={`${toX(a.x)},${toY(a.y)} ${toX(b.x)},${toY(b.y)} ${toX(c.x)},${toY(c.y)}`}
            fill={cutFillColor(f.d, maxAbs)}
            stroke="#ffffff"
            strokeWidth={0.4}
          />
        );
      })}
      {pts.map((p, i) => (
        <circle key={i} cx={toX(p.x)} cy={toY(p.y)} r={1.6} fill="#0f172a" />
      ))}
    </svg>
  );
}

// d>0 = cut (red), d<0 = fill (blue), ~0 = neutral.
function cutFillColor(d: number, maxAbs: number): string {
  const t = Math.max(-1, Math.min(1, d / maxAbs));
  if (t >= 0) {
    const k = t; // 0 -> neutral, 1 -> red
    return `rgb(${Math.round(241 + (220 - 241) * k)},${Math.round(245 + (38 - 245) * k)},${Math.round(249 + (38 - 249) * k)})`;
  }
  const k = -t; // 0 -> neutral, 1 -> blue
  return `rgb(${Math.round(241 + (37 - 241) * k)},${Math.round(245 + (99 - 245) * k)},${Math.round(249 + (235 - 249) * k)})`;
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-800">{value}</dd>
    </div>
  );
}
