"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { Badge, Button, Card, Field, Input, Stat } from "@/components/ui";
import { MutationDiagram } from "@/components/MutationDiagram";
import { displayCrs } from "@/lib/crsOptions";
import type { Beacon, Parcel, ParcelDoc } from "@/lib/types";
import type { CogoResult } from "@/lib/types";
import {
  beaconMap,
  consolidate,
  parcelMetrics,
  ringPoints,
  subdivide,
  validateParcels,
} from "@/lib/server/parcel";
import {
  forward,
  inverse,
  intersectBearingBearing,
  intersectBearingDistance,
  intersectDistanceDistance,
  type Point,
} from "@/lib/server/geometry";
import { parseBearing } from "@/lib/server/angles";

const PALETTE = ["#0d9488", "#2563eb", "#db2777", "#d97706", "#7c3aed", "#16a34a", "#dc2626", "#0891b2"];

function emptyDoc(): ParcelDoc {
  return { beacons: [], parcels: [] };
}

function nextBeaconId(doc: ParcelDoc): string {
  const used = new Set(doc.beacons.map((b) => b.id));
  for (let i = 1; i < 100000; i++) if (!used.has(String(i))) return String(i);
  return String(Date.now());
}
function nextParcelNumber(doc: ParcelDoc): string {
  const used = new Set(doc.parcels.map((p) => p.number));
  for (let i = 1; i < 100000; i++) if (!used.has(`LOT ${i}`)) return `LOT ${i}`;
  return `LOT ${doc.parcels.length + 1}`;
}
function uid(prefix: string): string {
  // deterministic-enough unique id without Math.random in render-critical paths
  return `${prefix}_${Date.now().toString(36)}_${Math.floor(performance.now() % 1e6).toString(36)}`;
}

export function Parcels() {
  const { parcelDoc, setParcelDoc, cogoResult, importResult, topoResult, config, setDiagramFigure, setActiveTab } =
    useStore();

  const [doc, setDoc] = useState<ParcelDoc>(() => {
    const d = parcelDoc as ParcelDoc | null;
    return d && Array.isArray(d.beacons) && Array.isArray(d.parcels) ? d : emptyDoc();
  });
  const [selId, setSelId] = useState<string | null>(null);
  const [building, setBuilding] = useState<string[]>([]); // beacon ids for a new parcel
  const [msg, setMsg] = useState<string | null>(null);
  // The line the user is currently working on in "Compute subdivision point" (drawn on the plot).
  const [activeLine, setActiveLine] = useState<{ from: string; to: string } | null>(null);

  // Persist into the project bundle (synchronous ref write — no re-render).
  useEffect(() => {
    setParcelDoc(doc);
  }, [doc, setParcelDoc]);

  const by = useMemo(() => beaconMap(doc.beacons), [doc.beacons]);
  const selected = doc.parcels.find((p) => p.id === selId) ?? null;
  const checks = useMemo(() => validateParcels(doc.beacons, doc.parcels), [doc.beacons, doc.parcels]);
  const errors = checks.filter((c) => c.severity === "error").length;
  const warnings = checks.filter((c) => c.severity === "warning").length;

  function flash(m: string) {
    setMsg(m);
    setTimeout(() => setMsg(null), 3500);
  }

  // ---- beacons ----
  function addBeacon() {
    setDoc((d) => ({ ...d, beacons: [...d.beacons, { id: nextBeaconId(d), east: 0, north: 0 }] }));
  }
  function updateBeacon(id: string, patch: Partial<Beacon>) {
    setDoc((d) => ({ ...d, beacons: d.beacons.map((b) => (b.id === id ? { ...b, ...patch } : b)) }));
  }
  function deleteBeacon(id: string) {
    setDoc((d) => ({
      ...d,
      beacons: d.beacons.filter((b) => b.id !== id),
      parcels: d.parcels.map((p) => ({ ...p, beaconIds: p.beaconIds.filter((x) => x !== id) })),
    }));
    setBuilding((b) => b.filter((x) => x !== id));
  }

  /** Add a beacon at COMPUTED coordinates (subdivision points). Returns true on success. */
  function addComputedBeacon(id: string, east: number, north: number): boolean {
    const clean = id.trim();
    if (!clean) { flash("Enter a name for the new point."); return false; }
    if (doc.beacons.some((b) => b.id === clean)) { flash(`Beacon "${clean}" already exists — choose another name.`); return false; }
    if (!Number.isFinite(east) || !Number.isFinite(north)) { flash("Computation failed — check the inputs."); return false; }
    const e3 = Math.round(east * 1000) / 1000;
    const n3 = Math.round(north * 1000) / 1000;
    setDoc((d) => ({ ...d, beacons: [...d.beacons, { id: clean, east: e3, north: n3, computed: true }] }));
    flash(`Computed "${clean}" at E ${e3}, N ${n3} — now include it in a parcel.`);
    return true;
  }

  /** Add several computed points at once (radial / consecutive polar). */
  function addComputedBeacons(points: { id: string; east: number; north: number }[]): boolean {
    const ids = points.map((p) => p.id.trim());
    if (ids.some((id) => !id)) { flash("Each computed point needs a name."); return false; }
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) { flash(`Duplicate point name in the list: "${dup}".`); return false; }
    const existing = new Set(doc.beacons.map((b) => b.id));
    const clash = ids.find((id) => existing.has(id));
    if (clash) { flash(`Beacon "${clash}" already exists — choose another name.`); return false; }
    if (points.some((p) => !Number.isFinite(p.east) || !Number.isFinite(p.north))) { flash("Computation failed — check the inputs."); return false; }
    setDoc((d) => ({
      ...d,
      beacons: [...d.beacons, ...points.map((p) => ({ id: p.id.trim(), east: Math.round(p.east * 1000) / 1000, north: Math.round(p.north * 1000) / 1000, computed: true }))],
    }));
    flash(`Added ${points.length} computed point(s) — now include them in portions.`);
    return true;
  }

  function importBeacons(source: { id: string; east: number; north: number }[], label: string) {
    if (!source.length) {
      flash(`No coordinates available from ${label}.`);
      return;
    }
    setDoc((d) => {
      const map = new Map(d.beacons.map((b) => [b.id, b] as const));
      let added = 0;
      for (const s of source) {
        const id = s.id?.trim() || nextBeaconId({ beacons: [...map.values()], parcels: d.parcels });
        if (!map.has(id)) {
          map.set(id, { id, east: s.east, north: s.north });
          added++;
        }
      }
      flash(`Imported ${added} new beacon(s) from ${label}.`);
      return { ...d, beacons: [...map.values()] };
    });
  }

  const cogoBeacons = (cogoResult?.points ?? [])
    .filter((p) => p.name)
    .map((p) => ({ id: String(p.name), east: p.east, north: p.north }));
  const importBeaconRows = (importResult?.rows ?? [])
    .filter((r) => r.east != null && r.north != null && r.beaconId)
    .map((r) => ({ id: String(r.beaconId), east: r.east as number, north: r.north as number }));
  const topoBeacons = (topoResult?.points ?? [])
    .filter((p) => p.name)
    .map((p) => ({ id: String(p.name), east: p.x, north: p.y }));

  // ---- parcel building ----
  function toggleBuild(id: string) {
    setBuilding((b) => (b.includes(id) ? b.filter((x) => x !== id) : [...b, id]));
  }
  const buildMetrics = useMemo(
    () => (building.length >= 2 ? parcelMetrics(building, by) : null),
    [building, by]
  );
  function createParcel() {
    if (building.length < 3) {
      flash("Pick at least 3 beacons (in boundary order) to form a parcel.");
      return;
    }
    setDoc((d) => {
      const p: Parcel = { id: uid("parcel"), number: nextParcelNumber(d), name: "", beaconIds: [...building] };
      return { ...d, parcels: [...d.parcels, p] };
    });
    setBuilding([]);
    flash("Parcel created.");
  }

  function updateParcel(id: string, patch: Partial<Parcel>) {
    setDoc((d) => ({ ...d, parcels: d.parcels.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  }
  function deleteParcel(id: string) {
    setDoc((d) => ({ ...d, parcels: d.parcels.filter((p) => p.id !== id) }));
    if (selId === id) setSelId(null);
  }

  // ---- generate SG diagram from a parcel ----
  function toDiagram(p: Parcel) {
    const m = parcelMetrics(p.beaconIds, by);
    if (!m.closed) {
      flash("Parcel must have at least 3 beacons to make a diagram.");
      return;
    }
    const pts = ringPoints(p.beaconIds, by);
    const figure: CogoResult = {
      type: "closed",
      adjustment: "none",
      closure: {
        misclose_east: 0,
        misclose_north: 0,
        linear_misclosure: 0,
        total_distance: m.perimeter,
        relative_precision: null,
        relative_precision_text: "exact (constructed parcel)",
      },
      area_m2: m.area_m2,
      area_ha: m.area_ha,
      sigma0: 0,
      points: pts.map((pp) => ({ name: pp.name ?? null, east: pp.east, north: pp.north })),
      legs: m.sides.map((s, i) => ({
        index: i + 1,
        from: s.from,
        to: s.to,
        bearing: s.bearing,
        bearing_dms: s.bearing_dms,
        distance: s.distance,
        d_east_adj: 0,
        d_north_adj: 0,
      })),
      residuals: [],
    };
    setDiagramFigure(figure); // separate slot — does NOT clobber the real COGO traverse
    setActiveTab("diagrams");
  }

  return (
    <div className="space-y-4">
      {/* summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat value={doc.beacons.length} label="Beacons" />
        <Stat value={doc.parcels.length} label="Parcels" tone="brand" />
        <Stat value={errors} label="Errors" tone={errors ? "error" : "default"} />
        <Stat value={warnings} label="Warnings" tone={warnings ? "warning" : "default"} />
      </div>

      {msg && <div className="rounded-md bg-brand-light/40 px-3 py-2 text-sm text-brand-dark">{msg}</div>}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Beacon manager */}
        <Card title="Beacon Manager">
          <div className="mb-2 flex flex-wrap gap-2">
            <Button variant="ghost" onClick={addBeacon}>+ Add beacon</Button>
            <Button variant="ghost" onClick={() => importBeacons(cogoBeacons, "COGO")} disabled={!cogoBeacons.length}>
              ⬇ From COGO
            </Button>
            <Button variant="ghost" onClick={() => importBeacons(importBeaconRows, "Data Import")} disabled={!importBeaconRows.length}>
              ⬇ From Import
            </Button>
            <Button variant="ghost" onClick={() => importBeacons(topoBeacons, "Topo")} disabled={!topoBeacons.length}>
              ⬇ From Topo
            </Button>
          </div>
          {doc.beacons.length === 0 ? (
            <p className="text-sm text-slate-500">No beacons yet — add manually or import from COGO / Data Import / Topo.</p>
          ) : (
            <div className="max-h-72 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white text-left text-xs text-slate-500">
                  <tr><th className="py-1 pr-2">Beacon</th><th className="py-1 pr-2">East (Y)</th><th className="py-1 pr-2">North (X)</th><th></th></tr>
                </thead>
                <tbody>
                  {doc.beacons.map((b) => (
                    <tr key={b.id} className="border-t border-slate-100">
                      <td className="py-1 pr-2"><Input value={b.id} onChange={(v) => updateBeacon(b.id, { id: v })} /></td>
                      <td className="py-1 pr-2"><Input type="number" value={b.east} onChange={(v) => updateBeacon(b.id, { east: Number(v) || 0 })} /></td>
                      <td className="py-1 pr-2"><Input type="number" value={b.north} onChange={(v) => updateBeacon(b.id, { north: Number(v) || 0 })} /></td>
                      <td className="py-1"><button className="text-xs text-red-500 hover:text-red-700" onClick={() => deleteBeacon(b.id)}>delete</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Plot */}
        <Card title="Parcel Plot">
          <ParcelPlot doc={doc} by={by} selId={selId} building={building} activeLine={activeLine} onPickBeacon={toggleBuild} />
          <p className="mt-2 text-xs text-slate-400">Coordinates in {config.coordinateSystem} (survey metres). North is up.</p>
        </Card>
      </div>

      {/* Compute subdivision points from the parent figure (COGO) */}
      <Card title="Compute subdivision point (COGO)">
        <p className="mb-2 text-sm text-slate-500">
          Create new boundary points from existing beacons — polar (bearing + distance), a point on a line, or an
          intersection — then include them in a portion. This is how a parent plot is split into sub-plots.
        </p>
        <ComputePoint beacons={doc.beacons} by={by} onAdd={addComputedBeacon} onAddMany={addComputedBeacons} onActiveLine={setActiveLine} />
      </Card>

      {/* Build a parcel */}
      <Card title="Construct Parcel">
        <p className="mb-2 text-sm text-slate-500">Click beacons in boundary order, then create the parcel.</p>
        <div className="flex flex-wrap gap-2">
          {doc.beacons.map((b) => {
            const order = building.indexOf(b.id);
            return (
              <button
                key={b.id}
                onClick={() => toggleBuild(b.id)}
                className={`rounded-md border px-3 py-1.5 text-sm transition ${
                  order >= 0 ? "border-brand bg-brand-light/50 font-semibold text-brand-dark" : "border-slate-200 hover:bg-slate-50"
                }`}
              >
                {b.id}{order >= 0 ? ` · ${order + 1}` : ""}
              </button>
            );
          })}
          {doc.beacons.length === 0 && <span className="text-sm text-slate-400">Add beacons first.</span>}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button onClick={createParcel} disabled={building.length < 3}>Create parcel →</Button>
          {building.length > 0 && <Button variant="ghost" onClick={() => setBuilding([])}>Clear selection</Button>}
          {buildMetrics && (
            <span className="text-sm text-slate-600">
              Ring: {building.length} beacons · area {buildMetrics.area_ha} ha ({buildMetrics.area_m2} m²) · perimeter {buildMetrics.perimeter} m
            </span>
          )}
        </div>
      </Card>

      {/* Parcel list + detail */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Parcels">
          {doc.parcels.length === 0 ? (
            <p className="text-sm text-slate-500">No parcels yet.</p>
          ) : (
            <div className="space-y-1">
              {doc.parcels.map((p, i) => {
                const m = parcelMetrics(p.beaconIds, by);
                return (
                  <button
                    key={p.id}
                    onClick={() => setSelId(p.id)}
                    className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm ${
                      selId === p.id ? "border-brand bg-brand-light/30" : "border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="inline-block h-3 w-3 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
                      <span className="font-medium text-slate-700">{p.number || "(unnumbered)"}</span>
                    </span>
                    <span className="text-xs text-slate-500">{m.area_ha} ha · {p.beaconIds.length} beacons</span>
                  </button>
                );
              })}
            </div>
          )}
          <ConsolidatePanel doc={doc} by={by} setDoc={setDoc} flash={flash} />
        </Card>

        <Card title={selected ? `Parcel ${selected.number || ""}` : "Parcel detail"}>
          {!selected ? (
            <p className="text-sm text-slate-500">Select a parcel to view its dimensions, edit numbering, subdivide, or make a diagram.</p>
          ) : (
            <ParcelDetail
              parcel={selected}
              by={by}
              doc={doc}
              onUpdate={updateParcel}
              onDelete={deleteParcel}
              onDiagram={toDiagram}
              setDoc={setDoc}
              setSelId={setSelId}
              flash={flash}
            />
          )}
        </Card>
      </div>

      {/* Validation */}
      <Card title="Parcel Validation & Smart Warnings">
        {checks.length === 0 ? (
          <p className="text-sm text-slate-500">Add beacons and parcels to run topology checks (overlaps, closure, duplicates, coordinate consistency).</p>
        ) : (
          <ul className="space-y-1.5">
            {checks.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <Badge kind={c.severity === "pass" ? "pass" : c.severity === "warning" ? "warning" : "error"}>
                  {c.severity}
                </Badge>
                <span className="text-slate-700"><span className="font-medium">{c.rule}:</span> {c.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Mutation diagram (Module D output) */}
      <Card title="Mutation Diagram">
        <MutationDiagram
          beacons={doc.beacons}
          parcels={doc.parcels}
          meta={{
            title: config.name,
            surveyor: config.surveyor,
            date: "",
            coordinateSystem: displayCrs(config.coordinateSystem),
          }}
        />
      </Card>
    </div>
  );
}

// --- compute a new point from existing beacons (polar / point-on-line / intersection) ---
function ComputePoint({
  beacons, by, onAdd, onAddMany, onActiveLine,
}: {
  beacons: Beacon[];
  by: Map<string, Beacon>;
  onAdd: (id: string, east: number, north: number) => boolean;
  onAddMany: (points: { id: string; east: number; north: number }[]) => boolean;
  onActiveLine: (line: { from: string; to: string } | null) => void;
}) {
  const [method, setMethod] = useState<"polar" | "online" | "intersection">("polar");
  const [polarMode, setPolarMode] = useState<"single" | "radial" | "consecutive">("single");
  const [legs, setLegs] = useState<{ name: string; bearing: string; distance: string }[]>([{ name: "", bearing: "", distance: "" }]);
  const [imethod, setImethod] = useState<"bb" | "bd" | "dd">("bb");
  const [newId, setNewId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  // shared beacon pickers + params
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [bearing, setBearing] = useState("");
  const [distance, setDistance] = useState("");
  const [pa, setPa] = useState(""); // bearing/radius at A
  const [pb, setPb] = useState(""); // bearing/radius at B

  // Report the line we're working on so the plot can draw it (point-on-line / intersection).
  useEffect(() => {
    if ((method === "online" || method === "intersection") && fromId && toId && fromId !== toId) {
      onActiveLine({ from: fromId, to: toId });
    } else {
      onActiveLine(null);
    }
  }, [method, fromId, toId, onActiveLine]);

  const pt = (id: string): Point | null => {
    const b = by.get(id);
    return b ? { east: b.east, north: b.north, name: id } : null;
  };
  const BeaconSelect = ({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) => (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">
        <option value="">—</option>
        {beacons.map((b) => <option key={b.id} value={b.id}>{b.id}</option>)}
      </select>
    </Field>
  );

  const posNum = (v: string, label: string): number => {
    const n = Number((v ?? "").trim());
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Enter ${label} greater than 0.`);
    return n;
  };

  function compute() {
    setErr(null);
    try {
      if (!newId.trim()) throw new Error("Enter a name for the new point (e.g. X1).");
      let res: Point;
      if (method === "polar") {
        const f = pt(fromId);
        if (!f) throw new Error("Pick the 'from' beacon.");
        if (!bearing.trim()) throw new Error("Enter a bearing.");
        res = forward(f, parseBearing(bearing), posNum(distance, "a distance (m)"));
      } else if (method === "online") {
        const a = pt(fromId), b = pt(toId);
        if (!a || !b) throw new Error("Pick both line beacons (from / to).");
        if (fromId === toId) throw new Error("'From' and 'to' must be different beacons.");
        const [brg] = inverse(a, b);
        res = forward(a, brg, posNum(distance, "a distance (m)")); // distance along line from 'from'
      } else {
        const a = pt(fromId), b = pt(toId);
        if (!a || !b) throw new Error("Pick both reference beacons (A / B).");
        if (fromId === toId) throw new Error("Beacon A and B must be different.");
        if (imethod === "bb") {
          if (!pa.trim() || !pb.trim()) throw new Error("Enter both bearings (from A and from B).");
          res = intersectBearingBearing(a, parseBearing(pa), b, parseBearing(pb));
        } else if (imethod === "bd") {
          if (!pa.trim()) throw new Error("Enter the bearing from A.");
          res = intersectBearingDistance(a, parseBearing(pa), b, posNum(pb, "a radius (m) from B"));
        } else {
          res = intersectDistanceDistance(a, posNum(pa, "a radius (m) from A"), b, posNum(pb, "a radius (m) from B"));
        }
      }
      if (onAdd(newId, res.east, res.north)) {
        setNewId(""); setBearing(""); setDistance(""); setPa(""); setPb("");
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  // ---- radial / consecutive polar (multiple points from one station) ----
  const setLeg = (i: number, patch: Partial<{ name: string; bearing: string; distance: string }>) =>
    setLegs((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addLeg = () => setLegs((ls) => [...ls, { name: "", bearing: "", distance: "" }]);
  const removeLeg = (i: number) => setLegs((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : ls));

  function computeMulti() {
    setErr(null);
    try {
      const start = pt(fromId);
      if (!start) throw new Error("Pick the 'from' station.");
      const rows = legs.filter((l) => l.name.trim() || l.bearing.trim() || l.distance.trim());
      if (!rows.length) throw new Error("Add at least one leg (name, bearing, distance).");
      let base: Point = start;
      const out: { id: string; east: number; north: number }[] = [];
      for (const l of rows) {
        if (!l.name.trim()) throw new Error("Each leg needs a point name.");
        if (!l.bearing.trim()) throw new Error(`Point "${l.name}": enter a bearing.`);
        const d = Number(l.distance);
        if (!Number.isFinite(d) || d <= 0) throw new Error(`Point "${l.name}": distance must be greater than 0.`);
        const p = forward(base, parseBearing(l.bearing), d);
        out.push({ id: l.name.trim(), east: p.east, north: p.north });
        if (polarMode === "consecutive") base = { east: p.east, north: p.north, name: l.name };
      }
      if (onAddMany(out)) setLegs([{ name: "", bearing: "", distance: "" }]);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  // Length of the selected line (point-on-line mode) — shown as a range hint.
  const lineLen = (() => {
    if (method !== "online") return null;
    const a = pt(fromId), b = pt(toId);
    return a && b && fromId !== toId ? inverse(a, b)[1] : null;
  })();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {([
          ["polar", "Polar (bearing + distance)"],
          ["online", "Point on line"],
          ["intersection", "Intersection"],
        ] as [typeof method, string][]).map(([m, lbl]) => (
          <button
            key={m}
            onClick={() => { setMethod(m); setErr(null); }}
            className={`rounded-md border px-3 py-1.5 text-sm ${method === m ? "border-brand bg-brand-light/50 font-semibold text-brand-dark" : "border-slate-200 hover:bg-slate-50"}`}
          >
            {lbl}
          </button>
        ))}
      </div>

      {method === "polar" && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {([
              ["single", "Single"],
              ["radial", "Radial (one station → many points)"],
              ["consecutive", "Consecutive (chained)"],
            ] as [typeof polarMode, string][]).map(([m, lbl]) => (
              <button key={m} type="button" onClick={() => { setPolarMode(m); setErr(null); }} className={`rounded-md border px-2.5 py-1 text-xs ${polarMode === m ? "border-brand bg-brand-light/50 text-brand-dark" : "border-slate-200 hover:bg-slate-50"}`}>{lbl}</button>
            ))}
          </div>
          {polarMode === "single" ? (
            <div className="grid gap-2 sm:grid-cols-3">
              <BeaconSelect value={fromId} onChange={setFromId} label="From beacon" />
              <Field label="Bearing (DMS / decimal)"><Input value={bearing} onChange={setBearing} placeholder="e.g. 272.36.20" /></Field>
              <Field label="Distance (m)"><Input type="number" value={distance} onChange={setDistance} placeholder="e.g. 50" /></Field>
            </div>
          ) : (
            <div className="space-y-2">
              <BeaconSelect value={fromId} onChange={setFromId} label={polarMode === "radial" ? "From station (all points radiate from here)" : "Start station (first leg from here, then chained)"} />
              <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 text-xs text-slate-500">
                <span>Point name</span><span>Bearing</span><span>Distance (m)</span><span />
              </div>
              {legs.map((l, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-2">
                  <Input value={l.name} onChange={(v) => setLeg(i, { name: v })} placeholder="X1" />
                  <Input value={l.bearing} onChange={(v) => setLeg(i, { bearing: v })} placeholder="90" />
                  <Input type="number" value={l.distance} onChange={(v) => setLeg(i, { distance: v })} placeholder="50" />
                  <button type="button" className="px-2 text-sm text-red-500 hover:text-red-700 disabled:opacity-30" onClick={() => removeLeg(i)} disabled={legs.length <= 1} title="Remove leg">×</button>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" onClick={addLeg}>+ Add leg</Button>
                <Button onClick={computeMulti}>Compute &amp; add all points</Button>
              </div>
            </div>
          )}
        </div>
      )}
      {method === "online" && (
        <div className="grid gap-2 sm:grid-cols-3">
          <BeaconSelect value={fromId} onChange={setFromId} label="Line from" />
          <BeaconSelect value={toId} onChange={setToId} label="Line to" />
          <Field label="Distance from 'from' (m)"><Input type="number" value={distance} onChange={setDistance} placeholder="e.g. 25" /></Field>
        </div>
      )}
      {method === "online" && lineLen != null && (
        <p className="text-xs text-slate-500">
          Line {fromId}→{toId} is <strong>{lineLen.toFixed(2)} m</strong> long (distance from {fromId} must be 0–{lineLen.toFixed(0)}).{" "}
          <button type="button" className="underline hover:text-slate-700" onClick={() => setDistance((lineLen / 2).toFixed(2))}>
            use midpoint ({(lineLen / 2).toFixed(1)} m)
          </button>
        </p>
      )}
      {method === "intersection" && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {([["bb", "Bearing–Bearing"], ["bd", "Bearing–Distance"], ["dd", "Distance–Distance"]] as [typeof imethod, string][]).map(([m, lbl]) => (
              <button key={m} onClick={() => setImethod(m)} className={`rounded-md border px-2.5 py-1 text-xs ${imethod === m ? "border-brand bg-brand-light/50 text-brand-dark" : "border-slate-200 hover:bg-slate-50"}`}>{lbl}</button>
            ))}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <BeaconSelect value={fromId} onChange={setFromId} label="Beacon A" />
            <BeaconSelect value={toId} onChange={setToId} label="Beacon B" />
            <Field label={imethod === "dd" ? "Radius from A (m)" : "Bearing from A"}><Input value={pa} onChange={setPa} placeholder={imethod === "dd" ? "e.g. 40" : "e.g. 90"} /></Field>
            <Field label={imethod === "bb" ? "Bearing from B" : "Radius/Distance from B (m)"}><Input value={pb} onChange={setPb} placeholder={imethod === "bb" ? "e.g. 180" : "e.g. 40"} /></Field>
          </div>
        </div>
      )}

      {!(method === "polar" && polarMode !== "single") && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="New point name"><Input value={newId} onChange={setNewId} placeholder="e.g. X1" /></Field>
          <Button onClick={compute}>Compute &amp; add point</Button>
        </div>
      )}
      {err && <p className="text-sm text-red-600">{err}</p>}
    </div>
  );
}

// --- parcel detail (metrics, numbering, subdivide, diagram) ---------------
function ParcelDetail({
  parcel, by, doc, onUpdate, onDelete, onDiagram, setDoc, setSelId, flash,
}: {
  parcel: Parcel;
  by: Map<string, Beacon>;
  doc: ParcelDoc;
  onUpdate: (id: string, patch: Partial<Parcel>) => void;
  onDelete: (id: string) => void;
  onDiagram: (p: Parcel) => void;
  setDoc: (fn: (d: ParcelDoc) => ParcelDoc) => void;
  setSelId: (id: string | null) => void;
  flash: (m: string) => void;
}) {
  const m = parcelMetrics(parcel.beaconIds, by);
  const [splitFrom, setSplitFrom] = useState("");
  const [splitTo, setSplitTo] = useState("");
  const [insertId, setInsertId] = useState("");

  const setRing = (ids: string[]) => onUpdate(parcel.id, { beaconIds: ids });
  function moveBeacon(idx: number, dir: -1 | 1) {
    const ids = [...parcel.beaconIds];
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    setRing(ids);
  }
  function removeFromRing(idx: number) {
    if (parcel.beaconIds.length <= 3) {
      flash("A parcel needs at least 3 beacons.");
      return;
    }
    setRing(parcel.beaconIds.filter((_, i) => i !== idx));
  }

  function doSubdivide() {
    try {
      const { childA, childB } = subdivide(parcel.beaconIds, splitFrom, splitTo);
      const base = parcel.number || "LOT";
      // The "root" is the original parent number with any -N portion suffixes stripped,
      // so we can count how many portions now descend from the same parent.
      const root = base.replace(/(-\d+)+$/, "") || base;
      let portions = 0;
      setDoc((d) => {
        const others = d.parcels.filter((p) => p.id !== parcel.id);
        const a: Parcel = { id: `${parcel.id}_a`, number: `${base}-1`, name: parcel.name, beaconIds: childA };
        const b: Parcel = { id: `${parcel.id}_b`, number: `${base}-2`, name: parcel.name, beaconIds: childB };
        const next = [...others, a, b];
        portions = next.filter((p) => p.number === root || p.number.startsWith(`${root}-`)).length;
        return { ...d, parcels: next };
      });
      setSelId(`${parcel.id}_a`);
      flash(
        portions > 4
          ? `Parcel subdivided into two — this parent now has ${portions} portions. Botswana practice limits a subdivision to 4 portions; beyond that a General Plan is normally required. Please confirm before lodging.`
          : "Parcel subdivided into two."
      );
    } catch (e) {
      flash((e as Error).message);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Parcel number (Erf / Lot)"><Input value={parcel.number} onChange={(v) => onUpdate(parcel.id, { number: v })} placeholder="e.g. LOT 14182" /></Field>
        <Field label="Description"><Input value={parcel.name} onChange={(v) => onUpdate(parcel.id, { name: v })} placeholder="optional" /></Field>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Stat value={m.area_ha} label="Area (ha)" tone="brand" />
        <Stat value={m.area_m2} label="Area (m²)" />
        <Stat value={m.perimeter} label="Perimeter (m)" />
      </div>

      <div>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Boundary (bearings & distances)</div>
        <div className="max-h-56 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500"><tr><th className="py-1 pr-3">Side</th><th className="py-1 pr-3">Bearing</th><th className="py-1 pr-3">Distance (m)</th></tr></thead>
            <tbody>
              {m.sides.map((s, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="py-1 pr-3 font-medium">{s.from} → {s.to}</td>
                  <td className="py-1 pr-3">{s.bearing_dms}</td>
                  <td className="py-1 pr-3">{s.distance}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Boundary editing */}
      <div className="rounded-md border border-slate-200 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Boundary order (edit)</span>
          <button className="text-xs text-slate-500 underline" onClick={() => setRing([...parcel.beaconIds].reverse())}>Reverse direction</button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {parcel.beaconIds.map((id, idx) => (
            <span key={`${id}_${idx}`} className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs">
              <span className="font-medium text-slate-700">{idx + 1}. {id}</span>
              <button title="Move earlier" className="text-slate-400 hover:text-slate-700 disabled:opacity-30" onClick={() => moveBeacon(idx, -1)} disabled={idx === 0}>↑</button>
              <button title="Move later" className="text-slate-400 hover:text-slate-700 disabled:opacity-30" onClick={() => moveBeacon(idx, 1)} disabled={idx === parcel.beaconIds.length - 1}>↓</button>
              <button title="Remove from boundary" className="text-red-400 hover:text-red-600" onClick={() => removeFromRing(idx)}>×</button>
            </span>
          ))}
        </div>
        <div className="mt-2 flex items-end gap-2">
          <Field label="Insert beacon at end">
            <select value={insertId} onChange={(e) => setInsertId(e.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <option value="">—</option>
              {doc.beacons.map((b) => <option key={b.id} value={b.id}>{b.id}</option>)}
            </select>
          </Field>
          <Button variant="ghost" onClick={() => { if (insertId) { setRing([...parcel.beaconIds, insertId]); setInsertId(""); } }} disabled={!insertId}>+ Insert</Button>
        </div>
      </div>

      {/* Subdivide */}
      <div className="rounded-md border border-slate-200 p-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Subdivide (split along a chord between two boundary beacons)</div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="From beacon">
            <select value={splitFrom} onChange={(e) => setSplitFrom(e.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <option value="">—</option>
              {parcel.beaconIds.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          </Field>
          <Field label="To beacon">
            <select value={splitTo} onChange={(e) => setSplitTo(e.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <option value="">—</option>
              {parcel.beaconIds.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          </Field>
          <Button variant="ghost" onClick={doSubdivide} disabled={!splitFrom || !splitTo}>Subdivide</Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => onDiagram(parcel)}>Generate SG Diagram →</Button>
        <Button variant="ghost" onClick={() => onDelete(parcel.id)}>Delete parcel</Button>
      </div>
    </div>
  );
}

// --- consolidate panel ----------------------------------------------------
function ConsolidatePanel({
  doc, by, setDoc, flash,
}: {
  doc: ParcelDoc;
  by: Map<string, Beacon>;
  setDoc: (fn: (d: ParcelDoc) => ParcelDoc) => void;
  flash: (m: string) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  if (doc.parcels.length < 2) return null;

  function toggle(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }
  function run() {
    const sel = doc.parcels.filter((p) => picked.includes(p.id));
    if (sel.length < 2) {
      flash("Pick at least two parcels to consolidate.");
      return;
    }
    try {
      const res = consolidate(sel, by);
      setDoc((d) => {
        const others = d.parcels.filter((p) => !picked.includes(p.id));
        const merged: Parcel = {
          id: `merge_${Date.now().toString(36)}`,
          number: sel.map((p) => p.number).filter(Boolean).join("+") || "MERGED",
          name: "Consolidated",
          beaconIds: res.beaconIds,
        };
        return { ...d, parcels: [...others, merged] };
      });
      setPicked([]);
      flash(res.warning ? `Consolidated. ${res.warning}` : "Parcels consolidated into one.");
    } catch (e) {
      flash((e as Error).message);
    }
  }

  return (
    <div className="mt-3 rounded-md border border-slate-200 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Consolidate (merge adjacent parcels)</div>
      <div className="flex flex-wrap gap-2">
        {doc.parcels.map((p) => (
          <button
            key={p.id}
            onClick={() => toggle(p.id)}
            className={`rounded-md border px-2.5 py-1 text-xs ${picked.includes(p.id) ? "border-brand bg-brand-light/50 text-brand-dark" : "border-slate-200 hover:bg-slate-50"}`}
          >
            {p.number || "(unnumbered)"}
          </button>
        ))}
      </div>
      <div className="mt-2"><Button variant="ghost" onClick={run} disabled={picked.length < 2}>Consolidate {picked.length || ""}</Button></div>
    </div>
  );
}

// --- SVG plot -------------------------------------------------------------
function ParcelPlot({
  doc, by, selId, building, activeLine, onPickBeacon,
}: {
  doc: ParcelDoc;
  by: Map<string, Beacon>;
  selId: string | null;
  building: string[];
  activeLine: { from: string; to: string } | null;
  onPickBeacon?: (id: string) => void;
}) {
  const W = 460, H = 320, pad = 28;
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, w: W, h: H });
  const viewRef = useRef(view);
  viewRef.current = view;
  const drag = useRef<{ x: number; y: number } | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null); // pointer-down pos (click vs drag)
  const [grabbing, setGrabbing] = useState(false);

  const zoomBy = (factor: number, fx?: number, fy?: number) =>
    setView((v) => {
      const nw = Math.min(Math.max(v.w / factor, W / 40), W * 2); // clamp 40x in … 2x out
      const nh = nw * (H / W);
      const cx = fx ?? v.x + v.w / 2;
      const cy = fy ?? v.y + v.h / 2;
      return { x: cx - ((cx - v.x) / v.w) * nw, y: cy - ((cy - v.y) / v.h) * nh, w: nw, h: nh };
    });
  const fit = () => setView({ x: 0, y: 0, w: W, h: H });

  // Wheel-zoom toward the cursor. Bound non-passively so the page doesn't scroll.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      const rect = svg.getBoundingClientRect();
      const fx = v.x + ((e.clientX - rect.left) / rect.width) * v.w;
      const fy = v.y + ((e.clientY - rect.top) / rect.height) * v.h;
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, fx, fy);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  if (doc.beacons.length === 0) {
    return <div className="grid h-48 place-items-center text-sm text-slate-400">Nothing to plot yet.</div>;
  }
  const xs = doc.beacons.map((b) => b.east);
  const ys = doc.beacons.map((b) => b.north);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX || 1, spanY = maxY - minY || 1;
  const s = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const ox = (W - s * spanX) / 2, oy = (H - s * spanY) / 2;
  const sx = (e: number) => ox + (e - minX) * s;
  const sy = (n: number) => H - (oy + (n - minY) * s); // flip: north up

  // Keep dot radius / label size roughly constant on screen as the user zooms.
  const k = view.w / W;
  const onDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY };
    start.current = { x: e.clientX, y: e.clientY };
    setGrabbing(true);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const dx = ((e.clientX - drag.current.x) * view.w) / rect.width;
    const dy = ((e.clientY - drag.current.y) * view.h) / rect.height;
    drag.current = { x: e.clientX, y: e.clientY };
    setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
  };
  // A pointer-up that barely moved is a CLICK: pick the nearest beacon (within
  // ~16px) and add it to the parcel ring. A larger movement was a pan.
  const onUp = (e: React.PointerEvent) => {
    const st = start.current;
    drag.current = null;
    start.current = null;
    setGrabbing(false);
    if (!onPickBeacon || !st || !svgRef.current) return;
    if (Math.hypot(e.clientX - st.x, e.clientY - st.y) > 6) return; // was a pan
    const rect = svgRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    let best: Beacon | null = null, bestD = Infinity;
    for (const b of doc.beacons) {
      const bxp = ((sx(b.east) - view.x) / view.w) * rect.width;
      const byp = ((sy(b.north) - view.y) / view.h) * rect.height;
      const d = Math.hypot(bxp - px, byp - py);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (best && bestD <= 16) onPickBeacon(best.id);
  };
  const onLeave = () => { drag.current = null; start.current = null; setGrabbing(false); };
  const btn = "grid h-7 w-7 place-items-center rounded border border-slate-300 bg-white leading-none text-slate-700 shadow-sm hover:bg-slate-100";

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onLeave}
        className="w-full touch-none select-none rounded-md border border-slate-200 bg-slate-50"
        style={{ cursor: grabbing ? "grabbing" : onPickBeacon ? "pointer" : "grab" }}
      >
        {/* parcels */}
        {doc.parcels.map((p, i) => {
          const pts = ringPoints(p.beaconIds, by);
          if (pts.length < 3) return null;
          const d = pts.map((pp) => `${sx(pp.east)},${sy(pp.north)}`).join(" ");
          const cx = pts.reduce((a, pp) => a + sx(pp.east), 0) / pts.length;
          const cy = pts.reduce((a, pp) => a + sy(pp.north), 0) / pts.length;
          const col = PALETTE[i % PALETTE.length];
          return (
            <g key={p.id}>
              <polygon points={d} fill={col} fillOpacity={selId === p.id ? 0.32 : 0.16} stroke={col} strokeWidth={selId === p.id ? 2 : 1.3} vectorEffect="non-scaling-stroke" />
              <text x={cx} y={cy} textAnchor="middle" fontSize={10 * k} fontWeight={600} fill={col}>{p.number}</text>
            </g>
          );
        })}
        {/* building ring preview */}
        {building.length >= 2 && (
          <polyline
            points={building.map((id) => by.get(id)).filter(Boolean).map((b) => `${sx(b!.east)},${sy(b!.north)}`).join(" ")}
            fill="none" stroke="#0d9488" strokeWidth={1.5} strokeDasharray="4 3" vectorEffect="non-scaling-stroke"
          />
        )}
        {/* active line being worked on in "Compute subdivision point" (point-on-line / intersection) */}
        {activeLine && by.get(activeLine.from) && by.get(activeLine.to) && (
          <line
            x1={sx(by.get(activeLine.from)!.east)} y1={sy(by.get(activeLine.from)!.north)}
            x2={sx(by.get(activeLine.to)!.east)} y2={sy(by.get(activeLine.to)!.north)}
            stroke="#db2777" strokeWidth={1.8} strokeDasharray="5 3" vectorEffect="non-scaling-stroke"
          />
        )}
        {/* beacons — computed points pink; points selected into the new parcel ring
            are teal with their boundary-order number below them */}
        {doc.beacons.map((b) => {
          const order = building.indexOf(b.id);
          const inRing = order >= 0;
          const fill = inRing ? "#0d9488" : b.computed ? "#db2777" : "#0f172a";
          return (
            <g key={b.id}>
              <circle
                cx={sx(b.east)} cy={sy(b.north)} r={(inRing ? 4.4 : b.computed ? 3.5 : 3) * k}
                fill={fill} stroke={inRing ? "#fff" : "none"} strokeWidth={1 * k}
              />
              <text x={sx(b.east) + 5 * k} y={sy(b.north) - 4 * k} fontSize={9 * k} fontWeight={inRing || b.computed ? 700 : 400} fill={fill}>{b.id}</text>
              {inRing && (
                <text x={sx(b.east)} y={sy(b.north) + 12 * k} textAnchor="middle" fontSize={8 * k} fontWeight={700} fill="#0d9488">{order + 1}</text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Zoom controls */}
      <div className="absolute right-2 top-2 flex flex-col gap-1">
        <button type="button" title="Zoom in" onClick={() => zoomBy(1.3)} className={`${btn} text-lg`}>+</button>
        <button type="button" title="Zoom out" onClick={() => zoomBy(1 / 1.3)} className={`${btn} text-lg`}>−</button>
        <button type="button" title="Fit to all points" onClick={fit} className={`${btn} text-[10px] font-medium`}>Fit</button>
      </div>
      {/* North + hint */}
      <div className="pointer-events-none absolute left-2 top-2 select-none text-[10px] font-medium text-slate-500">N ↑</div>
      <div className="pointer-events-none absolute bottom-1.5 right-2 select-none text-[9px] text-slate-400">
        {onPickBeacon ? "click a point to add it to the parcel · drag to pan · scroll to zoom" : "scroll / drag to pan · Fit to reset"}
      </div>
    </div>
  );
}
