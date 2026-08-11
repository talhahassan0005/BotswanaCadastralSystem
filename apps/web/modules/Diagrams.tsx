"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { Button, Card, Field, Input, Select } from "@/components/ui";
import { beaconMap, parcelMetrics, ringPoints } from "@/lib/server/parcel";
import type { CogoResult, ParcelDoc } from "@/lib/types";
import { SgDiagram, type DiagramKind, type DiagramMeta } from "@/components/SgDiagram";
import { BoreholeDiagram } from "@/components/BoreholeDiagram";
import { TribalLeaseSketch, type LeaseMeta } from "@/components/TribalLeaseSketch";

const KINDS: { id: DiagramKind; label: string; blurb: string }[] = [
  { id: "surveyed", label: "Surveyed", blurb: "Parcel surveyed on the ground — beacons measured and computed." },
  { id: "framed", label: "Framed", blurb: "Framed from an approved General Plan." },
  { id: "compiled", label: "Compiled", blurb: "Compiled from existing approved records — submitted to DSM for approval (carries the DSM approval block)." },
  { id: "borehole", label: "Borehole", blurb: "Borehole site tied by bearing & distance to reference marks." },
  { id: "lease", label: "Tribal Lease", blurb: "Land Board tribal-lease sketch — NOT submitted to DSM (witness blocks, no approval). Locality + boundary sketch from base-map data." },
];

// Remembered location -> "Parent / portion" (cadastre) map, so entering a known
// location auto-fills its cadastre. It learns as the surveyor uses it (no external
// dataset needed) and persists across projects in the browser.
const CAD_KEY = "bcs-location-cadastre";
function loadCadMap(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(window.localStorage.getItem(CAD_KEY) || "{}"); } catch { return {}; }
}
function rememberCad(location: string, parent: string) {
  const loc = location.trim().toUpperCase();
  if (!loc || !parent.trim() || typeof window === "undefined") return;
  try {
    const m = loadCadMap();
    m[loc] = parent;
    window.localStorage.setItem(CAD_KEY, JSON.stringify(m));
  } catch { /* ignore */ }
}

export function Diagrams() {
  const { cogoResult, diagramFigure, config, setActiveTab, diagramInput, setDiagramInput, parcelDoc } = useStore();
  const svgRef = useRef<SVGSVGElement>(null);

  // The surveyor picks which lot (parcel) to draw the diagram for, right here.
  const pdoc = parcelDoc as ParcelDoc | null;
  const parcels = useMemo(() => pdoc?.parcels ?? [], [pdoc]);
  const [selParcelId, setSelParcelId] = useState<string | null>(null);
  const parcelFigure = useMemo<CogoResult | null>(() => {
    if (!pdoc || !selParcelId) return null;
    const p = pdoc.parcels.find((x) => x.id === selParcelId);
    if (!p) return null;
    const by = beaconMap(pdoc.beacons);
    const m = parcelMetrics(p.beaconIds, by);
    if (!m.closed) return null;
    const pts = ringPoints(p.beaconIds, by);
    return {
      type: "closed",
      adjustment: "none",
      closure: { misclose_east: 0, misclose_north: 0, linear_misclosure: 0, total_distance: m.perimeter, relative_precision: null, relative_precision_text: "exact (constructed parcel)" },
      area_m2: m.area_m2,
      area_ha: m.area_ha,
      sigma0: 0,
      points: pts.map((pp) => ({ name: pp.name ?? null, east: pp.east, north: pp.north })),
      legs: m.sides.map((s, i) => ({ index: i + 1, from: s.from, to: s.to, bearing: s.bearing, bearing_dms: s.bearing_dms, distance: s.distance, d_east_adj: 0, d_north_adj: 0 })),
      residuals: [],
    };
  }, [pdoc, selParcelId]);

  // Prefer the picked lot, then a parcel sent from Parcels, then the COGO traverse.
  const fig = parcelFigure ?? diagramFigure ?? cogoResult;
  // Restore saved diagram form state from the project, else derive defaults from config.
  const di = (diagramInput ?? {}) as { kind?: DiagramKind; meta?: Omit<DiagramMeta, "closed" | "kind">; leaseMeta?: Omit<LeaseMeta, "areaM2" | "coordinateSystem"> };
  const [kind, setKind] = useState<DiagramKind>(di.kind ?? "surveyed");

  // `closed`/`kind` are applied at render time, not stored in the form state.
  const [meta, setMeta] = useState<Omit<DiagramMeta, "closed" | "kind">>(di.meta ?? {
    lotName: config.name && config.name !== "Untitled Survey" ? config.name.toUpperCase() : "LOT 14182 CHARLESHILL",
    parent: "A PORTION OF CADASTRE 243",
    location: "CHARLESHILL",
    tribalArea: "GHANZI TRIBAL AREA",
    surveyor: config.surveyor ? config.surveyor.toUpperCase() : "G. G. SESINYI",
    surveyedDate: "FEBRUARY 2026",
    coordinateSystem: config.coordinateSystem.replace(" Botswana", ""),
    scale: 5000,
    dsmNo: "",
    srNo: "",
    gpNo: "",
    degreeSquare: "",
    parentDiagram: "",
    beaconDescription: "ALL: 12mm iron peg",
    areaHa: fig?.area_ha ?? 0,
    sourceRef: "",
    boreholeNo: "",
    boreholeE: 0,
    boreholeN: 0,
  });

  const points = useMemo(
    () => (fig?.points ?? []).map((p) => ({ name: p.name, east: p.east, north: p.north })),
    [fig]
  );
  const sides = useMemo(
    () =>
      (fig?.legs ?? []).map((l) => ({
        from: l.from,
        to: l.to,
        bearing_dms: l.bearing_dms,
        distance: l.distance,
      })),
    [fig]
  );

  const fullMeta: DiagramMeta = {
    ...meta,
    kind,
    areaHa: fig?.area_ha ?? meta.areaHa,
    closed: fig?.type === "closed",
  };

  // Tribal-lease sketch carries its own (Land Board) field set.
  const [leaseMeta, setLeaseMeta] = useState<Omit<LeaseMeta, "areaM2" | "coordinateSystem">>(di.leaseMeta ?? {
    fileNo: "B",
    date: "16/09/2025",
    compiledBy: "O. Ithuteng",
    applicantName: "Aobakwe Thuo Chijoro",
    useType: "Residential",
    tribalLot: "4266",
    village: "Mmopane, Block 1",
    postal: "P O Box 80934 Gaborone",
    localityScale: 1530,
    boundaryScale: 1250,
  });
  const setLease = (k: keyof typeof leaseMeta) => (v: string) =>
    setLeaseMeta((m) => ({ ...m, [k]: k === "localityScale" || k === "boundaryScale" ? Number(v) || 0 : v }));

  // When a lot is picked, pre-fill the diagram's lot name from the parcel number.
  useEffect(() => {
    const p = parcels.find((x) => x.id === selParcelId);
    if (p?.number) setMeta((m) => ({ ...m, lotName: p.number.toUpperCase() }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selParcelId]);

  // Persist diagram form state into the project bundle.
  useEffect(() => {
    setDiagramInput({ kind, meta, leaseMeta });
  }, [kind, meta, leaseMeta, setDiagramInput]);
  const fullLeaseMeta: LeaseMeta = {
    ...leaseMeta,
    coordinateSystem: meta.coordinateSystem,
    areaM2: fig?.area_m2 ?? 0,
  };

  function serializeSvg(): string | null {
    if (!svgRef.current) return null;
    const clone = svgRef.current.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return new XMLSerializer().serializeToString(clone);
  }

  function downloadSvg() {
    const svg = serializeSvg();
    if (!svg) return;
    const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svg}`], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${kind}-diagram-${(meta.lotName || "diagram").replace(/\s+/g, "_")}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function printDiagram() {
    const svg = serializeSvg();
    if (!svg) return;
    const w = window.open("", "_blank", "width=1200,height=850");
    if (!w) {
      alert("Pop-up blocked. Please allow pop-ups for this site in your browser, then click Print again.");
      return;
    }
    w.document.write(
      `<html><head><title>${kind} diagram — ${meta.lotName}</title>` +
        `<style>@page{size:A4 portrait;margin:8mm}body{margin:0}svg{width:100%;height:auto}</style></head>` +
        `<body onload="window.print()">${svg}</body></html>`
    );
    w.document.close();
  }

  const set = (k: keyof typeof meta) => (v: string) =>
    setMeta((m) => ({ ...m, [k]: k === "scale" || k === "boreholeE" || k === "boreholeN" ? Number(v) || 0 : v }));

  // Entering a known location auto-picks its cadastre (Parent / portion); typing a
  // parent for a location remembers it for next time.
  const onLocation = (v: string) =>
    setMeta((m) => {
      const remembered = loadCadMap()[v.trim().toUpperCase()];
      return { ...m, location: v, parent: remembered ?? m.parent };
    });
  const onParent = (v: string) =>
    setMeta((m) => {
      rememberCad(m.location, v);
      return { ...m, parent: v };
    });

  if (!fig || points.length < 3) {
    return (
      <Card>
        <div className="py-12 text-center text-slate-500">
          <p className="text-lg font-medium text-slate-700">Choose a lot to draw its diagram</p>
          {parcels.length > 0 ? (
            <>
              <p className="mt-1 text-sm">Pick the lot (parcel) you want a diagram for:</p>
              <div className="mx-auto mt-4 max-w-xs text-left">
                <Select
                  value={selParcelId ?? ""}
                  onChange={(v) => setSelParcelId(v || null)}
                  options={[{ value: "", label: "— select a lot —" }, ...parcels.map((p) => ({ value: p.id, label: p.number || "(unnamed)" }))]}
                />
              </div>
              <p className="mt-3 text-xs text-slate-400">…or run a closed traverse in the COGO Engine.</p>
            </>
          ) : (
            <p className="mt-1 text-sm">
              Build a parcel in the <strong>Parcels</strong> tab, or run a <strong>closed traverse</strong> in the COGO Engine —
              the diagram is drawn from its beacon coordinates and sides.
            </p>
          )}
          <div className="mt-4 flex justify-center gap-2">
            <Button variant="ghost" onClick={() => setActiveTab("parcels")}>Go to Parcels</Button>
            <Button variant="ghost" onClick={() => setActiveTab("cogo")}>Go to COGO Engine</Button>
          </div>
        </div>
      </Card>
    );
  }

  const isBorehole = kind === "borehole";
  const isLease = kind === "lease";

  return (
    <div className="space-y-5">
      {/* Lot / parcel picker — which figure this diagram draws */}
      {parcels.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm">
          <span className="text-sm font-medium text-slate-600">Lot / parcel:</span>
          <div className="min-w-[200px]">
            <Select
              value={selParcelId ?? ""}
              onChange={(v) => setSelParcelId(v || null)}
              options={[{ value: "", label: cogoResult ? "COGO traverse figure" : "— pick a lot —" }, ...parcels.map((p) => ({ value: p.id, label: p.number || "(unnamed)" }))]}
            />
          </div>
          {selParcelId && <span className="text-xs text-slate-400">drawing this lot · {fig.area_ha.toFixed(4)} ha</span>}
        </div>
      )}

      {/* Diagram type selector */}
      <div className="flex flex-wrap gap-2">
        {KINDS.map((k) => (
          <button
            key={k.id}
            onClick={() => setKind(k.id)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              kind === k.id
                ? "bg-brand text-white shadow-sm"
                : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>
      <p className="-mt-2 text-sm text-slate-500">{KINDS.find((k) => k.id === kind)?.blurb}</p>

      <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
        <div className="space-y-4">
          {isLease ? (
            <Card title="Tribal Lease Details">
              <div className="space-y-3">
                <Field label="File No"><Input value={leaseMeta.fileNo} onChange={setLease("fileNo")} /></Field>
                <Field label="Date"><Input value={leaseMeta.date} onChange={setLease("date")} /></Field>
                <Field label="Compiled by (Mapping)"><Input value={leaseMeta.compiledBy} onChange={setLease("compiledBy")} /></Field>
                <Field label="Applicant name"><Input value={leaseMeta.applicantName} onChange={setLease("applicantName")} /></Field>
                <Field label="Use / purpose"><Input value={leaseMeta.useType} onChange={setLease("useType")} /></Field>
                <Field label="Tribal Lot No."><Input value={leaseMeta.tribalLot} onChange={setLease("tribalLot")} /></Field>
                <Field label="Village / block"><Input value={leaseMeta.village} onChange={setLease("village")} /></Field>
                <Field label="Postal address"><Input value={leaseMeta.postal} onChange={setLease("postal")} /></Field>
                <Field label="Locality scale 1:N"><Input type="number" value={leaseMeta.localityScale} onChange={setLease("localityScale")} /></Field>
                <Field label="Boundary scale 1:N"><Input type="number" value={leaseMeta.boundaryScale} onChange={setLease("boundaryScale")} /></Field>
              </div>
            </Card>
          ) : (
            <>
              <Card title="Diagram Details">
                <div className="space-y-3">
                  <Field label={isBorehole ? "Borehole name / site" : "Land called (lot name)"}>
                    <Input value={meta.lotName} onChange={set("lotName")} />
                  </Field>
                  {isBorehole ? (
                    <>
                      <Field label="Borehole No.">
                        <Input value={meta.boreholeNo ?? ""} onChange={set("boreholeNo")} />
                      </Field>
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="Borehole Easting"><Input type="number" value={meta.boreholeE ?? 0} onChange={set("boreholeE")} /></Field>
                        <Field label="Borehole Northing"><Input type="number" value={meta.boreholeN ?? 0} onChange={set("boreholeN")} /></Field>
                      </div>
                    </>
                  ) : (
                    <Field label="Parent / portion">
                      <Input value={meta.parent} onChange={onParent} placeholder="e.g. A PORTION OF CADASTRE 243" />
                    </Field>
                  )}
                  {(kind === "compiled" || kind === "framed") && (
                    <Field label={kind === "framed" ? "Framed from (General Plan No.)" : "Compiled from (source document)"}>
                      <Input value={meta.sourceRef ?? ""} onChange={set("sourceRef")} />
                    </Field>
                  )}
                  <Field label="Situate at (location)"><Input value={meta.location} onChange={onLocation} placeholder="e.g. CHARLESHILL" /></Field>
                  <Field label="Tribal / administrative area"><Input value={meta.tribalArea} onChange={set("tribalArea")} /></Field>
                  <Field label="Land surveyor"><Input value={meta.surveyor} onChange={set("surveyor")} /></Field>
                  <Field label="Date"><Input value={meta.surveyedDate} onChange={set("surveyedDate")} /></Field>
                  <Field label="Scale 1:N"><Input type="number" value={meta.scale} onChange={set("scale")} /></Field>
                  {!isBorehole && (
                    <Field label="Beacon description"><Input value={meta.beaconDescription} onChange={set("beaconDescription")} /></Field>
                  )}
                </div>
              </Card>
              <Card title="Registration">
                <div className="space-y-3">
                  <Field label="D.S.M No."><Input value={meta.dsmNo} onChange={set("dsmNo")} /></Field>
                  <Field label="S.R No."><Input value={meta.srNo} onChange={set("srNo")} /></Field>
                  {!isBorehole && (
                    <Field label="General Plan No."><Input value={meta.gpNo} onChange={set("gpNo")} /></Field>
                  )}
                  <Field label="Degree Square"><Input value={meta.degreeSquare} onChange={set("degreeSquare")} /></Field>
                  <Field label="D.S.M File"><Input value={meta.dsmFile ?? ""} onChange={set("dsmFile")} placeholder="e.g. CAD T9" /></Field>
                  <Field label="Comp."><Input value={meta.comp ?? ""} onChange={set("comp")} /></Field>
                  <Field label="LIR No."><Input value={meta.lirNo ?? ""} onChange={set("lirNo")} /></Field>
                  <Field label="Immediate parent diagram No. (subdivisions)"><Input value={meta.parentDiagramNo ?? meta.parentDiagram ?? ""} onChange={set("parentDiagramNo")} placeholder="e.g. SR 1087/2014" /></Field>
                  <Field label="Annexed to (Deeds Registry No.)"><Input value={meta.annexedToNo ?? ""} onChange={set("annexedToNo")} /></Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Annexed — dated"><Input value={meta.annexedDate ?? ""} onChange={set("annexedDate")} /></Field>
                    <Field label="In favour of"><Input value={meta.annexedInFavourOf ?? ""} onChange={set("annexedInFavourOf")} /></Field>
                  </div>
                  <Field label="Name above ‘Registrar of Deeds’ (optional)"><Input value={meta.annexName ?? ""} onChange={set("annexName")} placeholder="optional" /></Field>
                </div>
              </Card>
            </>
          )}
          <Card title="Output">
            <div className="flex flex-col gap-2">
              <Button onClick={downloadSvg}>⬇ Download SVG</Button>
              <Button variant="ghost" onClick={printDiagram}>Print / Save PDF</Button>
            </div>
          </Card>
        </div>

        <Card title={`${KINDS.find((k) => k.id === kind)?.label} Preview`} className="overflow-auto">
          <div className="rounded-lg border border-slate-200">
            {isLease ? (
              <TribalLeaseSketch ref={svgRef} meta={fullLeaseMeta} points={points} sides={sides} />
            ) : isBorehole ? (
              <BoreholeDiagram ref={svgRef} meta={fullMeta} points={points} />
            ) : (
              <SgDiagram ref={svgRef} meta={fullMeta} points={points} sides={sides} />
            )}
          </div>
          <p className="mt-3 text-xs text-slate-400">
            {isLease ? (
              <>Boundary sketch &amp; coordinate schedule are drawn from the COGO figure. The locality sketch
              (surrounding lots) is populated once a base map is imported (DXF / Shapefile).</>
            ) : (
              <>Drawn from the computed figure ({points.length} beacons, area {fig.area_ha.toFixed(4)} ha).
              Template wording follows standard SG convention — verify against the official Botswana
              {" "}{KINDS.find((k) => k.id === kind)?.label.toLowerCase()} sample before lodging.</>
            )}
          </p>
        </Card>
      </div>
    </div>
  );
}
