"use client";

import { useState } from "react";
import { apiJson } from "@/lib/api";
import { Button, Field, Input, Modal, Select } from "@/components/ui";

export type ToolId = "inverse" | "intersection" | "curve" | "area" | "transform";

const TOOL_TITLES: Record<ToolId, string> = {
  inverse: "Forward / Inverse Calculation",
  intersection: "Intersection Methods",
  curve: "Circular Curve Computation",
  area: "Area Calculation",
  transform: "Coordinate Transform (Lo / Arc1950 / WGS84 / UTM)",
};

// Gauss-Conform "Lo" belts. Botswana's official belts are odd central meridians
// (Lo21–Lo29); the full Lo12–Lo29 span is offered per the client brief.
const LO_MERIDIANS = Array.from({ length: 29 - 12 + 1 }, (_, i) => 12 + i); // 12..29
const CRS_OPTIONS = [
  ...LO_MERIDIANS.map((m) => ({
    value: `Lo${m}`,
    label: `Lo ${m}°${[21, 23, 25, 27, 29].includes(m) ? " (Botswana)" : ""}`,
  })),
  { value: "Arc1950", label: "Arc 1950 (lat/lon)" },
  { value: "WGS84", label: "WGS84 (lat/lon)" },
  { value: "UTM34S", label: "UTM 34S" },
  { value: "UTM35S", label: "UTM 35S" },
];

function Result({ data }: { data: any }) {
  if (data == null) return null;
  return (
    <pre className="mt-4 overflow-x-auto rounded-lg bg-slate-50 p-4 text-sm text-slate-700">
      {typeof data === "string" ? data : JSON.stringify(data, null, 2)}
    </pre>
  );
}

export function CogoTools({
  tool,
  onClose,
  onAddPoint,
}: {
  tool: ToolId | null;
  onClose: () => void;
  /** Push a computed point onto the work station's drawing. Only offered by
   *  tools that produce a real east/north in the project's own coordinate
   *  system (Forward, Intersection) — Inverse only measures between two
   *  already-known points, Curve/Area aren't located in space, and Transform
   *  can output a different (e.g. lat/lon) system that isn't plottable here. */
  onAddPoint?: (p: { name: string; east: number; north: number }) => void;
}) {
  return (
    <Modal open={tool !== null} onClose={onClose} title={tool ? TOOL_TITLES[tool] : ""}>
      {tool === "inverse" && <InverseTool onAddPoint={onAddPoint} />}
      {tool === "intersection" && <IntersectionTool onAddPoint={onAddPoint} />}
      {tool === "curve" && <CurveTool />}
      {tool === "area" && <AreaTool />}
      {tool === "transform" && <TransformTool />}
    </Modal>
  );
}

function AddToDrawing({
  east,
  north,
  onAddPoint,
}: {
  east: number;
  north: number;
  onAddPoint?: (p: { name: string; east: number; north: number }) => void;
}) {
  if (!onAddPoint) return null;
  return (
    <Button
      variant="ghost"
      onClick={() => {
        const name = window.prompt("Point name", "New1") ?? "New1";
        onAddPoint({ name, east, north });
      }}
    >
      + Add to drawing
    </Button>
  );
}

function useRun() {
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(path: string, body: unknown) {
    setError(null);
    setBusy(true);
    try {
      setResult(await apiJson(path, body));
    } catch (e: any) {
      setError(e.message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  }
  return { result, error, busy, run };
}

function InverseTool({ onAddPoint }: { onAddPoint?: (p: { name: string; east: number; north: number }) => void }) {
  const [mode, setMode] = useState("inverse");
  const [a, setA] = useState({ e: "0", n: "0" });
  const [b, setB] = useState({ e: "100", n: "100" });
  const [fwd, setFwd] = useState({ brg: "45.00.00", dist: "100" });
  const { result, error, busy, run } = useRun();
  return (
    <div>
      <Field label="Calculation">
        <Select value={mode} onChange={setMode} options={[
          { value: "inverse", label: "Inverse / Join — two points → bearing & distance" },
          { value: "forward", label: "Forward / Polar — point + bearing + distance → new point" },
        ]} />
      </Field>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label="From Easting"><Input value={a.e} onChange={(v) => setA({ ...a, e: v })} /></Field>
        <Field label="From Northing"><Input value={a.n} onChange={(v) => setA({ ...a, n: v })} /></Field>
        {mode === "inverse" ? (
          <>
            <Field label="To Easting"><Input value={b.e} onChange={(v) => setB({ ...b, e: v })} /></Field>
            <Field label="To Northing"><Input value={b.n} onChange={(v) => setB({ ...b, n: v })} /></Field>
          </>
        ) : (
          <>
            <Field label="Bearing (DDD.MMSS or decimal)"><Input value={fwd.brg} onChange={(v) => setFwd({ ...fwd, brg: v })} /></Field>
            <Field label="Distance (m)"><Input value={fwd.dist} onChange={(v) => setFwd({ ...fwd, dist: v })} /></Field>
          </>
        )}
      </div>
      <div className="mt-4">
        <Button disabled={busy} loading={busy} onClick={() =>
          mode === "inverse"
            ? run("/cogo/inverse", { from_point: { east: +a.e, north: +a.n }, to_point: { east: +b.e, north: +b.n } })
            : run("/cogo/forward", { from_point: { east: +a.e, north: +a.n }, bearing: fwd.brg, distance: +fwd.dist })
        }>{busy ? "…" : "Compute"}</Button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <Result data={result} />
      {mode === "forward" && result?.east != null && (
        <div className="mt-3"><AddToDrawing east={result.east} north={result.north} onAddPoint={onAddPoint} /></div>
      )}
    </div>
  );
}

function IntersectionTool({ onAddPoint }: { onAddPoint?: (p: { name: string; east: number; north: number }) => void }) {
  const [method, setMethod] = useState("bb");
  const [a, setA] = useState({ e: "0", n: "0", brg: "45", r: "120" });
  const [b, setB] = useState({ e: "100", n: "0", brg: "315", r: "120" });
  const { result, error, busy, run } = useRun();
  return (
    <div>
      <Field label="Method">
        <Select value={method} onChange={setMethod} options={[
          { value: "bb", label: "Bearing – Bearing" },
          { value: "dd", label: "Distance – Distance" },
          { value: "bd", label: "Bearing – Distance" },
        ]} />
      </Field>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label="Point A Easting"><Input value={a.e} onChange={(v) => setA({ ...a, e: v })} /></Field>
        <Field label="Point A Northing"><Input value={a.n} onChange={(v) => setA({ ...a, n: v })} /></Field>
        {(method === "bb" || method === "bd") && (
          <Field label="Bearing from A"><Input value={a.brg} onChange={(v) => setA({ ...a, brg: v })} /></Field>
        )}
        {method === "dd" && (
          <Field label="Radius from A"><Input value={a.r} onChange={(v) => setA({ ...a, r: v })} /></Field>
        )}
        <Field label="Point B Easting"><Input value={b.e} onChange={(v) => setB({ ...b, e: v })} /></Field>
        <Field label="Point B Northing"><Input value={b.n} onChange={(v) => setB({ ...b, n: v })} /></Field>
        {method === "bb" && (
          <Field label="Bearing from B"><Input value={b.brg} onChange={(v) => setB({ ...b, brg: v })} /></Field>
        )}
        {(method === "dd" || method === "bd") && (
          <Field label="Radius from B"><Input value={b.r} onChange={(v) => setB({ ...b, r: v })} /></Field>
        )}
      </div>
      <div className="mt-4">
        <Button disabled={busy} loading={busy} onClick={() => run("/cogo/intersection", {
          method,
          a: { east: +a.e, north: +a.n },
          b: { east: +b.e, north: +b.n },
          bearing_a: a.brg, bearing_b: b.brg,
          radius_a: +a.r, radius_b: +b.r,
        })}>{busy ? "…" : "Compute"}</Button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <Result data={result} />
      {result?.east != null && (
        <div className="mt-3"><AddToDrawing east={result.east} north={result.north} onAddPoint={onAddPoint} /></div>
      )}
    </div>
  );
}

function CurveTool() {
  const [radius, setRadius] = useState("100");
  const [defl, setDefl] = useState("90");
  const { result, error, busy, run } = useRun();
  return (
    <div>
      <p className="mb-3 text-sm text-slate-500">Circular curve — arc, chord, tangent, mid-ordinate, external.</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Radius (m)"><Input value={radius} onChange={setRadius} /></Field>
        <Field label="Deflection / central angle (°)"><Input value={defl} onChange={setDefl} /></Field>
      </div>
      <div className="mt-4">
        <Button disabled={busy} loading={busy} onClick={() => run("/cogo/curve", { radius: +radius, deflection_deg: +defl })}>
          {busy ? "…" : "Compute"}
        </Button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <Result data={result} />
    </div>
  );
}

function AreaTool() {
  const [mode, setMode] = useState("polygon");
  const [text, setText] = useState("0,0\n100,0\n100,100\n0,100");
  const [strip, setStrip] = useState({ len: "100", w: "10" });
  const { result, error, busy, run } = useRun();
  function parse() {
    return text.split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [e, n] = l.split(/[, \t]+/).map(Number);
      return { east: e, north: n };
    });
  }
  const len = Number(strip.len) || 0;
  const w = Number(strip.w) || 0;
  const stripArea = len * w;
  return (
    <div>
      <Field label="Area type">
        <Select value={mode} onChange={setMode} options={[
          { value: "polygon", label: "Polygon — parcel (enter vertices)" },
          { value: "strip", label: "Strip — road reserve / servitude (length × width)" },
        ]} />
      </Field>
      {mode === "polygon" ? (
        <>
          <p className="mb-2 mt-3 text-sm text-slate-500">One vertex per line: <code>easting, northing</code>.</p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            className="w-full rounded-lg border border-slate-200 p-3 font-mono text-sm focus:border-brand focus:outline-none"
          />
          <div className="mt-4">
            <Button disabled={busy} loading={busy} onClick={() => run("/cogo/area", { points: parse() })}>
              {busy ? "…" : "Compute area"}
            </Button>
          </div>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          <Result data={result} />
        </>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Centre-line length (m)"><Input value={strip.len} onChange={(v) => setStrip({ ...strip, len: v })} /></Field>
            <Field label="Reserve width (m)"><Input value={strip.w} onChange={(v) => setStrip({ ...strip, w: v })} /></Field>
          </div>
          <Result data={{ method: "strip", length_m: len, width_m: w, area_m2: Math.round(stripArea * 1000) / 1000, area_ha: Math.round((stripArea / 10000) * 10000) / 10000 }} />
        </>
      )}
    </div>
  );
}

function TransformTool() {
  const [src, setSrc] = useState("Lo21");
  const [dst, setDst] = useState("WGS84");
  const [text, setText] = useState("93205.88, 2464520.65, A");
  const { result, error, busy, run } = useRun();
  function parse() {
    return text.split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [a, b, name] = l.split(/[,\t]+/).map((s) => s.trim());
      return { a: Number(a), b: Number(b), name: name || null };
    });
  }
  return (
    <div>
      <p className="mb-3 text-sm text-slate-500">
        One-click datum / projection conversion. Projected systems use (Y/E, X/N);
        geographic systems use (lat, lon).
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="From"><Select value={src} onChange={setSrc} options={CRS_OPTIONS} /></Field>
        <Field label="To"><Select value={dst} onChange={setDst} options={CRS_OPTIONS} /></Field>
      </div>
      <div className="mt-3">
        <Field label="Points — one per line: a, b, [name]">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            className="w-full rounded-lg border border-slate-200 p-3 font-mono text-sm focus:border-brand focus:outline-none"
          />
        </Field>
      </div>
      <div className="mt-4">
        <Button disabled={busy} loading={busy} onClick={() => run("/crs/transform", { src, dst, points: parse() })}>
          {busy ? "…" : "Transform"}
        </Button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {result?.points && (
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-xs uppercase text-slate-500">
            <tr><th className="py-1">Name</th><th className="py-1">{dst} a</th><th className="py-1">{dst} b</th></tr>
          </thead>
          <tbody>
            {result.points.map((p: any, i: number) => (
              <tr key={i} className="border-t border-slate-100">
                <td className="py-1 font-medium">{p.name ?? "—"}</td>
                <td className="py-1">{p.a}</td>
                <td className="py-1">{p.b}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
