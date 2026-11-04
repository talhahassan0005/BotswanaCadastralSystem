"use client";

import { useRef, useState } from "react";
import { Button, Card, Field, Input, Stat } from "@/components/ui";

function deg2rad(d: number) { return (d * Math.PI) / 180; }
function rad2deg(r: number) { return (r * 180) / Math.PI; }
function fmt(n: number, dp = 4) { return n.toFixed(dp); }

function toDMS(deg: number): string {
  const d = Math.floor(deg);
  const m = Math.floor((deg - d) * 60);
  const s = ((deg - d) * 60 - m) * 60;
  return `${d}° ${m}' ${s.toFixed(2)}"`;
}

// ─── Chainage Calculation ─────────────────────────────────────────────────────
function ChainageCalc() {
  const [startE, setStartE] = useState("");
  const [startN, setStartN] = useState("");
  const [endE, setEndE] = useState("");
  const [endN, setEndN] = useState("");
  const [interval, setInterval] = useState("20");
  const [result, setResult] = useState<{ ch: number; e: number; n: number }[] | null>(null);

  function calculate() {
    const se = parseFloat(startE), sn = parseFloat(startN);
    const ee = parseFloat(endE), en = parseFloat(endN);
    const iv = parseFloat(interval);
    if ([se, sn, ee, en, iv].some(isNaN) || iv <= 0) return;
    const dx = ee - se, dy = en - sn;
    const L = Math.sqrt(dx * dx + dy * dy);
    const ux = dx / L, uy = dy / L;
    const pts: { ch: number; e: number; n: number }[] = [{ ch: 0, e: se, n: sn }];
    for (let ch = iv; ch < L; ch += iv) {
      pts.push({ ch, e: se + ux * ch, n: sn + uy * ch });
    }
    pts.push({ ch: L, e: ee, n: en });
    setResult(pts);
  }

  return (
    <Card title="Chainage Calculation">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Start Easting"><Input value={startE} onChange={setStartE} placeholder="e.g. 50000.00" /></Field>
        <Field label="Start Northing"><Input value={startN} onChange={setStartN} placeholder="e.g. 70000.00" /></Field>
        <Field label="End Easting"><Input value={endE} onChange={setEndE} placeholder="e.g. 50200.00" /></Field>
        <Field label="End Northing"><Input value={endN} onChange={setEndN} placeholder="e.g. 70150.00" /></Field>
      </div>
      <Field label="Chainage Interval (m)"><Input value={interval} onChange={setInterval} placeholder="20" /></Field>
      <Button onClick={calculate}>Calculate Chainages</Button>
      {result && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-slate-100 dark:bg-slate-800">
                <th className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-left">Chainage (m)</th>
                <th className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right">Easting</th>
                <th className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right">Northing</th>
              </tr>
            </thead>
            <tbody>
              {result.map((r, i) => (
                <tr key={i} className="odd:bg-white even:bg-slate-50 dark:odd:bg-slate-900 dark:even:bg-slate-800">
                  <td className="border border-slate-300 dark:border-slate-600 px-3 py-1">{fmt(r.ch, 3)}</td>
                  <td className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right font-mono">{fmt(r.e, 4)}</td>
                  <td className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right font-mono">{fmt(r.n, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-slate-500">Total length: {fmt(result[result.length - 1].ch, 3)} m — {result.length} points</p>
        </div>
      )}
    </Card>
  );
}

// ─── Road Curve (Horizontal Simple Circular) ─────────────────────────────────
function RoadCurve() {
  const [radius, setRadius] = useState("");
  const [deflection, setDeflection] = useState("");
  const [piE, setPiE] = useState("");
  const [piN, setPiN] = useState("");
  const [backBearing, setBackBearing] = useState("");
  const [interval, setInterval] = useState("20");
  const [result, setResult] = useState<{
    T: number; L: number; E: number; M: number; LC: number;
    pts: { ch: number; e: number; n: number }[];
  } | null>(null);

  function calculate() {
    const R = parseFloat(radius);
    const D = parseFloat(deflection);
    const pE = parseFloat(piE), pN = parseFloat(piN);
    const bb = parseFloat(backBearing);
    const iv = parseFloat(interval);
    if ([R, D, pE, pN, bb, iv].some(isNaN) || R <= 0 || D <= 0 || iv <= 0) return;

    const Drad = deg2rad(D);
    const T = R * Math.tan(Drad / 2);
    const L = R * Drad;
    const E = R * (1 / Math.cos(Drad / 2) - 1);
    const M = R * (1 - Math.cos(Drad / 2));
    const LC = 2 * R * Math.sin(Drad / 2);

    // TC point
    const bbRad = deg2rad(bb);
    const tcE = pE - T * Math.sin(bbRad);
    const tcN = pN - T * Math.cos(bbRad);

    // Centre (perpendicular right of entry tangent)
    const centBearRad = deg2rad((bb + 90) % 360);
    const centE = tcE + R * Math.sin(centBearRad);
    const centN = tcN + R * Math.cos(centBearRad);

    // TC bearing from centre = (bb + 90 + 180) % 360 from centre to TC
    const tcAngleFromCent = deg2rad((bb + 90 + 180) % 360);

    const pts: { ch: number; e: number; n: number }[] = [];
    let ch = 0;
    while (ch <= L + 0.001) {
      const clamped = Math.min(ch, L);
      const theta = clamped / R;
      const angle = tcAngleFromCent - theta; // CW sweep
      pts.push({ ch: clamped, e: centE + R * Math.sin(angle), n: centN + R * Math.cos(angle) });
      if (clamped >= L) break;
      ch += iv;
    }

    setResult({ T, L, E, M, LC, pts });
  }

  return (
    <Card title="Road Curve (Simple Circular)">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Radius R (m)"><Input value={radius} onChange={setRadius} placeholder="e.g. 200" /></Field>
        <Field label="Deflection Angle (deg)"><Input value={deflection} onChange={setDeflection} placeholder="e.g. 45.0" /></Field>
        <Field label="Entry Bearing (deg)"><Input value={backBearing} onChange={setBackBearing} placeholder="e.g. 90.0" /></Field>
        <Field label="PI Easting"><Input value={piE} onChange={setPiE} placeholder="e.g. 50000.00" /></Field>
        <Field label="PI Northing"><Input value={piN} onChange={setPiN} placeholder="e.g. 70000.00" /></Field>
        <Field label="Interval (m)"><Input value={interval} onChange={setInterval} placeholder="20" /></Field>
      </div>
      <Button onClick={calculate}>Calculate Curve</Button>
      {result && (
        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Stat label="Tangent Length T" value={`${fmt(result.T, 3)} m`} />
            <Stat label="Arc Length L" value={`${fmt(result.L, 3)} m`} />
            <Stat label="External E" value={`${fmt(result.E, 3)} m`} />
            <Stat label="Mid Ordinate M" value={`${fmt(result.M, 3)} m`} />
            <Stat label="Long Chord LC" value={`${fmt(result.LC, 3)} m`} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-slate-100 dark:bg-slate-800">
                  <th className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-left">Chainage (m)</th>
                  <th className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right">Easting</th>
                  <th className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right">Northing</th>
                </tr>
              </thead>
              <tbody>
                {result.pts.map((r, i) => (
                  <tr key={i} className="odd:bg-white even:bg-slate-50 dark:odd:bg-slate-900 dark:even:bg-slate-800">
                    <td className="border border-slate-300 dark:border-slate-600 px-3 py-1">{fmt(r.ch, 3)}</td>
                    <td className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right font-mono">{fmt(r.e, 4)}</td>
                    <td className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right font-mono">{fmt(r.n, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}

// ─── Road Centre Offset ───────────────────────────────────────────────────────
function RoadCentreOffset() {
  const [centreE, setCentreE] = useState("");
  const [centreN, setCentreN] = useState("");
  const [bearing, setBearing] = useState("");
  const [offsets, setOffsets] = useState("-10, -5, 0, 5, 10");
  const [result, setResult] = useState<{ offset: number; e: number; n: number }[] | null>(null);

  function calculate() {
    const ce = parseFloat(centreE), cn = parseFloat(centreN);
    const br = parseFloat(bearing);
    if ([ce, cn, br].some(isNaN)) return;
    const perpRad = deg2rad((br + 90) % 360);
    const offList = offsets.split(",").map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
    setResult(offList.map(off => ({
      offset: off,
      e: ce + off * Math.sin(perpRad),
      n: cn + off * Math.cos(perpRad),
    })));
  }

  return (
    <Card title="Road Centre Offset">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Centre Easting"><Input value={centreE} onChange={setCentreE} placeholder="e.g. 50000.00" /></Field>
        <Field label="Centre Northing"><Input value={centreN} onChange={setCentreN} placeholder="e.g. 70000.00" /></Field>
        <Field label="Road Bearing (deg)"><Input value={bearing} onChange={setBearing} placeholder="e.g. 90.0" /></Field>
      </div>
      <Field label="Offsets (m, comma-separated — negative=left, positive=right)">
        <Input value={offsets} onChange={setOffsets} placeholder="-10, -5, 0, 5, 10" />
      </Field>
      <Button onClick={calculate}>Calculate Offsets</Button>
      {result && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-slate-100 dark:bg-slate-800">
                <th className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-left">Offset (m)</th>
                <th className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right">Easting</th>
                <th className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right">Northing</th>
              </tr>
            </thead>
            <tbody>
              {result.map((r, i) => (
                <tr key={i} className="odd:bg-white even:bg-slate-50 dark:odd:bg-slate-900 dark:even:bg-slate-800">
                  <td className="border border-slate-300 dark:border-slate-600 px-3 py-1">{r.offset >= 0 ? `+${fmt(r.offset, 3)}` : fmt(r.offset, 3)}</td>
                  <td className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right font-mono">{fmt(r.e, 4)}</td>
                  <td className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right font-mono">{fmt(r.n, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ─── Slope Calculation ────────────────────────────────────────────────────────
interface SlopeRow { from: string; to: string; horizDist: number; vertDiff: number; grade: number; slopeDeg: number; slopeRatio: string; }
interface SlopePoint { name: string; e: number; n: number; z: number; }

function parseSlopePoints(text: string): SlopePoint[] {
  const pts: SlopePoint[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.includes(",") ? line.split(",").map(s => s.trim()) : line.split(/\s+/);
    if (parts.length < 4) continue;
    const name = parts[0];
    const [e, n, z] = parts.slice(1).map(Number);
    if ([e, n, z].some(isNaN)) continue;
    pts.push({ name, e, n, z });
  }
  return pts;
}

function computeSlopeRow(a: SlopePoint, b: SlopePoint): SlopeRow {
  const horizDist = Math.sqrt((b.e - a.e) ** 2 + (b.n - a.n) ** 2);
  const vertDiff = b.z - a.z;
  const rise = horizDist === 0 ? 0 : vertDiff / horizDist;
  const grade = rise * 100;
  const slopeDeg = rad2deg(Math.atan(rise));
  const slopeRatio = horizDist === 0 ? "vertical" : vertDiff === 0 ? "flat" : `1:${fmt(Math.abs(horizDist / vertDiff), 1)}`;
  return { from: a.name, to: b.name, horizDist, vertDiff, grade, slopeDeg, slopeRatio };
}

function SlopeCalc() {
  // Single-pair manual mode
  const [e1, setE1] = useState(""); const [n1, setN1] = useState(""); const [z1, setZ1] = useState("");
  const [e2, setE2] = useState(""); const [n2, setN2] = useState(""); const [z2, setZ2] = useState("");
  const [single, setSingle] = useState<SlopeRow | null>(null);

  // Multi-point CSV mode
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [multiRows, setMultiRows] = useState<SlopeRow[] | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  function calculateSingle() {
    const [a, b, c, d, e, f] = [e1, n1, z1, e2, n2, z2].map(parseFloat);
    if ([a, b, c, d, e, f].some(isNaN)) return;
    setSingle(computeSlopeRow(
      { name: "P1", e: a, n: b, z: c },
      { name: "P2", e: d, n: e, z: f }
    ));
  }

  function loadFile(file: File) {
    setFileError(null);
    setMultiRows(null);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = (ev.target?.result as string) ?? "";
      const pts = parseSlopePoints(text);
      if (pts.length < 2) { setFileError("Need at least 2 points with Name, E, N, Z columns."); return; }
      const rows: SlopeRow[] = [];
      for (let i = 0; i < pts.length - 1; i++) rows.push(computeSlopeRow(pts[i], pts[i + 1]));
      setMultiRows(rows);
    };
    reader.readAsText(file);
  }

  return (
    <div className="space-y-4">
      {/* CSV upload */}
      <Card title="Slope from File (Name, E, N, Z)">
        <p className="text-sm text-slate-500 mb-3">Upload a CSV / TXT file with columns: Name, Easting, Northing, Elevation — calculates slope between each consecutive pair of points.</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => fileRef.current?.click()}>Browse file</Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = ""; }}
          />
          {fileName && <span className="text-sm text-slate-600">{fileName}</span>}
          {fileName && <button onClick={() => { setFileName(null); setMultiRows(null); setFileError(null); }} className="text-xs text-red-500 hover:underline">Clear</button>}
        </div>
        {fileError && <p className="mt-2 text-sm text-red-600">{fileError}</p>}
        {multiRows && (
          <div className="mt-4 overflow-x-auto">
            <p className="mb-2 text-xs text-slate-500">{multiRows.length} slope segments</p>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-slate-100 dark:bg-slate-800">
                  <th className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-left">From</th>
                  <th className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-left">To</th>
                  <th className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right">Horiz Dist (m)</th>
                  <th className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right">Vert Diff (m)</th>
                  <th className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right">Grade %</th>
                  <th className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right">Angle</th>
                  <th className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right">Ratio</th>
                </tr>
              </thead>
              <tbody>
                {multiRows.map((r, i) => (
                  <tr key={i} className="odd:bg-white even:bg-slate-50 dark:odd:bg-slate-900 dark:even:bg-slate-800">
                    <td className="border border-slate-300 dark:border-slate-600 px-3 py-1 font-medium">{r.from}</td>
                    <td className="border border-slate-300 dark:border-slate-600 px-3 py-1 font-medium">{r.to}</td>
                    <td className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right font-mono">{fmt(r.horizDist, 3)}</td>
                    <td className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right font-mono">{fmt(r.vertDiff, 3)}</td>
                    <td className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right font-mono">{fmt(r.grade, 3)}</td>
                    <td className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right font-mono">{toDMS(Math.abs(r.slopeDeg))}</td>
                    <td className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right font-mono">{r.slopeRatio}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Manual two-point mode */}
      <Card title="Slope — Two Points (Manual)">
        <div className="space-y-3">
          <p className="text-sm text-slate-500">Point 1 (From)</p>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Easting"><Input value={e1} onChange={setE1} placeholder="E" /></Field>
            <Field label="Northing"><Input value={n1} onChange={setN1} placeholder="N" /></Field>
            <Field label="Elevation (m)"><Input value={z1} onChange={setZ1} placeholder="Z" /></Field>
          </div>
          <p className="text-sm text-slate-500">Point 2 (To)</p>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Easting"><Input value={e2} onChange={setE2} placeholder="E" /></Field>
            <Field label="Northing"><Input value={n2} onChange={setN2} placeholder="N" /></Field>
            <Field label="Elevation (m)"><Input value={z2} onChange={setZ2} placeholder="Z" /></Field>
          </div>
        </div>
        <Button onClick={calculateSingle}>Calculate Slope</Button>
        {single && (
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label="Horiz. Distance" value={`${fmt(single.horizDist, 3)} m`} />
            <Stat label="Vert. Difference" value={`${fmt(single.vertDiff, 3)} m`} />
            <Stat label="Grade %" value={`${fmt(single.grade, 3)} %`} />
            <Stat label="Slope Angle" value={toDMS(Math.abs(single.slopeDeg))} />
            <Stat label="Slope Ratio" value={single.slopeRatio} />
            <Stat label="Rise / Run" value={fmt(single.horizDist === 0 ? 0 : single.vertDiff / single.horizDist, 4)} />
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── Line Offset ──────────────────────────────────────────────────────────────
function LineOffset() {
  const [x1, setX1] = useState(""); const [y1, setY1] = useState("");
  const [x2, setX2] = useState(""); const [y2, setY2] = useState("");
  const [offsets, setOffsets] = useState("-5, 5");
  const [result, setResult] = useState<{ offset: number; p1: { e: number; n: number }; p2: { e: number; n: number } }[] | null>(null);

  function calculate() {
    const [a, b, c, d] = [x1, y1, x2, y2].map(parseFloat);
    if ([a, b, c, d].some(isNaN)) return;
    const dx = c - a, dy = d - b;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return;
    // Unit perpendicular (rotate 90° right)
    const px = dy / len, py = -dx / len;
    const offList = offsets.split(",").map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
    setResult(offList.map(off => ({
      offset: off,
      p1: { e: a + px * off, n: b + py * off },
      p2: { e: c + px * off, n: d + py * off },
    })));
  }

  return (
    <Card title="Line Offset">
      <p className="mb-3 text-sm text-slate-500">Define a base line by two points, then generate parallel offset lines. Negative = left of line direction, positive = right.</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Start Easting"><Input value={x1} onChange={setX1} placeholder="E1" /></Field>
        <Field label="Start Northing"><Input value={y1} onChange={setY1} placeholder="N1" /></Field>
        <Field label="End Easting"><Input value={x2} onChange={setX2} placeholder="E2" /></Field>
        <Field label="End Northing"><Input value={y2} onChange={setY2} placeholder="N2" /></Field>
      </div>
      <Field label="Offsets (m, comma-separated — negative=left, positive=right)">
        <Input value={offsets} onChange={setOffsets} placeholder="-5, 5" />
      </Field>
      <Button onClick={calculate}>Calculate Offsets</Button>
      {result && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-slate-100 dark:bg-slate-800">
                <th className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-left">Offset (m)</th>
                <th className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right">Start E</th>
                <th className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right">Start N</th>
                <th className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right">End E</th>
                <th className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right">End N</th>
              </tr>
            </thead>
            <tbody>
              {result.map((r, i) => (
                <tr key={i} className="odd:bg-white even:bg-slate-50 dark:odd:bg-slate-900 dark:even:bg-slate-800">
                  <td className="border border-slate-300 dark:border-slate-600 px-3 py-1 font-medium">{r.offset >= 0 ? `+${fmt(r.offset, 3)}` : fmt(r.offset, 3)}</td>
                  <td className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right font-mono">{fmt(r.p1.e, 4)}</td>
                  <td className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right font-mono">{fmt(r.p1.n, 4)}</td>
                  <td className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right font-mono">{fmt(r.p2.e, 4)}</td>
                  <td className="border border-slate-300 dark:border-slate-600 px-3 py-1 text-right font-mono">{fmt(r.p2.n, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ─── Main SettingOut module ───────────────────────────────────────────────────
const TOOLS = [
  { id: "chainage", label: "Chainage Calculation" },
  { id: "roadcurve", label: "Road Curve" },
  { id: "centreoffset", label: "Road Centre Offset" },
  { id: "lineoffset", label: "Line Offset" },
  { id: "slope", label: "Slope" },
] as const;
type ToolId = typeof TOOLS[number]["id"];

export function SettingOut() {
  const [tool, setTool] = useState<ToolId>("chainage");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 border-b border-slate-200 dark:border-slate-700 pb-3">
        {TOOLS.map(t => (
          <button
            key={t.id}
            onClick={() => setTool(t.id)}
            className={`rounded-md px-4 py-2 text-sm font-medium transition ${
              tool === t.id
                ? "bg-brand text-white"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tool === "chainage" && <ChainageCalc />}
      {tool === "roadcurve" && <RoadCurve />}
      {tool === "centreoffset" && <RoadCentreOffset />}
      {tool === "lineoffset" && <LineOffset />}
      {tool === "slope" && <SlopeCalc />}
    </div>
  );
}
