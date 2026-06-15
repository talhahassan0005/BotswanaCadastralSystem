"use client";

import { useEffect, useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { Badge, Button, Card, Field, Input, Stat } from "@/components/ui";
import { MutationDiagram } from "@/components/MutationDiagram";
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
  const { parcelDoc, setParcelDoc, cogoResult, importResult, topoResult, config, setCogoResult, setActiveTab } =
    useStore();

  const [doc, setDoc] = useState<ParcelDoc>(() => {
    const d = parcelDoc as ParcelDoc | null;
    return d && Array.isArray(d.beacons) && Array.isArray(d.parcels) ? d : emptyDoc();
  });
  const [selId, setSelId] = useState<string | null>(null);
  const [building, setBuilding] = useState<string[]>([]); // beacon ids for a new parcel
  const [msg, setMsg] = useState<string | null>(null);

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
    setCogoResult(figure);
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
          <ParcelPlot doc={doc} by={by} selId={selId} building={building} />
          <p className="mt-2 text-xs text-slate-400">Coordinates in {config.coordinateSystem} (survey metres). North is up.</p>
        </Card>
      </div>

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
            coordinateSystem: config.coordinateSystem,
          }}
        />
      </Card>
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
      setDoc((d) => {
        const others = d.parcels.filter((p) => p.id !== parcel.id);
        const base = parcel.number || "LOT";
        const a: Parcel = { id: `${parcel.id}_a`, number: `${base}-1`, name: parcel.name, beaconIds: childA };
        const b: Parcel = { id: `${parcel.id}_b`, number: `${base}-2`, name: parcel.name, beaconIds: childB };
        return { ...d, parcels: [...others, a, b] };
      });
      setSelId(`${parcel.id}_a`);
      flash("Parcel subdivided into two.");
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
  doc, by, selId, building,
}: {
  doc: ParcelDoc;
  by: Map<string, Beacon>;
  selId: string | null;
  building: string[];
}) {
  const W = 460, H = 320, pad = 28;
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

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-md border border-slate-200 bg-slate-50">
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
            <polygon points={d} fill={col} fillOpacity={selId === p.id ? 0.32 : 0.16} stroke={col} strokeWidth={selId === p.id ? 2 : 1.3} />
            <text x={cx} y={cy} textAnchor="middle" fontSize={10} fontWeight={600} fill={col}>{p.number}</text>
          </g>
        );
      })}
      {/* building ring preview */}
      {building.length >= 2 && (
        <polyline
          points={building.map((id) => by.get(id)).filter(Boolean).map((b) => `${sx(b!.east)},${sy(b!.north)}`).join(" ")}
          fill="none" stroke="#0d9488" strokeWidth={1.5} strokeDasharray="4 3"
        />
      )}
      {/* beacons */}
      {doc.beacons.map((b) => (
        <g key={b.id}>
          <circle cx={sx(b.east)} cy={sy(b.north)} r={3} fill="#0f172a" />
          <text x={sx(b.east) + 5} y={sy(b.north) - 4} fontSize={9} fill="#334155">{b.id}</text>
        </g>
      ))}
      {/* north arrow */}
      <g transform={`translate(${W - 22},22)`}>
        <line x1={0} y1={10} x2={0} y2={-8} stroke="#0f172a" strokeWidth={1.5} />
        <polygon points="0,-12 -4,-4 4,-4" fill="#0f172a" />
        <text x={0} y={22} textAnchor="middle" fontSize={9} fill="#0f172a">N</text>
      </g>
    </svg>
  );
}
