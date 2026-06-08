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

const CRS_OPTIONS = [
  { value: "Lo21", label: "Lo 21° (Botswana)" },
  { value: "Lo23", label: "Lo 23° (Botswana)" },
  { value: "Lo25", label: "Lo 25° (Botswana)" },
  { value: "Lo27", label: "Lo 27° (Botswana)" },
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

export function CogoTools({ tool, onClose }: { tool: ToolId | null; onClose: () => void }) {
  return (
    <Modal open={tool !== null} onClose={onClose} title={tool ? TOOL_TITLES[tool] : ""}>
      {tool === "inverse" && <InverseTool />}
      {tool === "intersection" && <IntersectionTool />}
      {tool === "curve" && <CurveTool />}
      {tool === "area" && <AreaTool />}
      {tool === "transform" && <TransformTool />}
    </Modal>
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

function InverseTool() {
  const [a, setA] = useState({ e: "0", n: "0" });
  const [b, setB] = useState({ e: "100", n: "100" });
  const { result, error, busy, run } = useRun();
  return (
    <div>
      <p className="mb-3 text-sm text-slate-500">Join two coordinates — returns bearing and distance.</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="From Easting"><Input value={a.e} onChange={(v) => setA({ ...a, e: v })} /></Field>
        <Field label="From Northing"><Input value={a.n} onChange={(v) => setA({ ...a, n: v })} /></Field>
        <Field label="To Easting"><Input value={b.e} onChange={(v) => setB({ ...b, e: v })} /></Field>
        <Field label="To Northing"><Input value={b.n} onChange={(v) => setB({ ...b, n: v })} /></Field>
      </div>
      <div className="mt-4">
        <Button disabled={busy} onClick={() => run("/cogo/inverse", {
          from_point: { east: +a.e, north: +a.n },
          to_point: { east: +b.e, north: +b.n },
        })}>{busy ? "…" : "Compute"}</Button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <Result data={result} />
    </div>
  );
}

function IntersectionTool() {
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
        <Button disabled={busy} onClick={() => run("/cogo/intersection", {
          method,
          a: { east: +a.e, north: +a.n },
          b: { east: +b.e, north: +b.n },
          bearing_a: a.brg, bearing_b: b.brg,
          radius_a: +a.r, radius_b: +b.r,
        })}>{busy ? "…" : "Compute"}</Button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <Result data={result} />
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
        <Button disabled={busy} onClick={() => run("/cogo/curve", { radius: +radius, deflection_deg: +defl })}>
          {busy ? "…" : "Compute"}
        </Button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <Result data={result} />
    </div>
  );
}

function AreaTool() {
  const [text, setText] = useState("0,0\n100,0\n100,100\n0,100");
  const { result, error, busy, run } = useRun();
  function parse() {
    return text.split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [e, n] = l.split(/[, \t]+/).map(Number);
      return { east: e, north: n };
    });
  }
  return (
    <div>
      <p className="mb-3 text-sm text-slate-500">
        Parcel / road reserve / servitude area. One vertex per line: <code>easting, northing</code>.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        className="w-full rounded-lg border border-slate-200 p-3 font-mono text-sm focus:border-brand focus:outline-none"
      />
      <div className="mt-4">
        <Button disabled={busy} onClick={() => run("/cogo/area", { points: parse() })}>
          {busy ? "…" : "Compute area"}
        </Button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <Result data={result} />
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
        <Button disabled={busy} onClick={() => run("/crs/transform", { src, dst, points: parse() })}>
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
