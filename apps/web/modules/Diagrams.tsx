"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { Button, Card, Field, Input } from "@/components/ui";
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

export function Diagrams() {
  const { cogoResult, config, setActiveTab, diagramInput, setDiagramInput } = useStore();
  const svgRef = useRef<SVGSVGElement>(null);
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
    beaconDescription: "ALL: 12mm iron peg",
    areaHa: cogoResult?.area_ha ?? 0,
    sourceRef: "",
    boreholeNo: "",
    boreholeE: 0,
    boreholeN: 0,
  });

  const points = useMemo(
    () => (cogoResult?.points ?? []).map((p) => ({ name: p.name, east: p.east, north: p.north })),
    [cogoResult]
  );
  const sides = useMemo(
    () =>
      (cogoResult?.legs ?? []).map((l) => ({
        from: l.from,
        to: l.to,
        bearing_dms: l.bearing_dms,
        distance: l.distance,
      })),
    [cogoResult]
  );

  const fullMeta: DiagramMeta = {
    ...meta,
    kind,
    areaHa: cogoResult?.area_ha ?? meta.areaHa,
    closed: cogoResult?.type === "closed",
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

  // Persist diagram form state into the project bundle.
  useEffect(() => {
    setDiagramInput({ kind, meta, leaseMeta });
  }, [kind, meta, leaseMeta, setDiagramInput]);
  const fullLeaseMeta: LeaseMeta = {
    ...leaseMeta,
    coordinateSystem: meta.coordinateSystem,
    areaM2: cogoResult?.area_m2 ?? 0,
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
    if (!w) return;
    w.document.write(
      `<html><head><title>${kind} diagram — ${meta.lotName}</title>` +
        `<style>@page{size:landscape}body{margin:0}svg{width:100%;height:auto}</style></head>` +
        `<body onload="window.print()">${svg}</body></html>`
    );
    w.document.close();
  }

  const set = (k: keyof typeof meta) => (v: string) =>
    setMeta((m) => ({ ...m, [k]: k === "scale" || k === "boreholeE" || k === "boreholeN" ? Number(v) || 0 : v }));

  if (!cogoResult || points.length < 3) {
    return (
      <Card>
        <div className="py-12 text-center text-slate-500">
          <p className="text-lg">No computed figure yet</p>
          <p className="mt-1 text-sm">
            Run a <strong>closed traverse</strong> in the COGO Engine first — every diagram is drawn
            from its computed beacon coordinates and sides.
          </p>
          <div className="mt-4">
            <Button onClick={() => setActiveTab("cogo")}>Go to COGO Engine</Button>
          </div>
        </div>
      </Card>
    );
  }

  const isBorehole = kind === "borehole";
  const isLease = kind === "lease";

  return (
    <div className="space-y-5">
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
                      <Input value={meta.parent} onChange={set("parent")} />
                    </Field>
                  )}
                  {(kind === "compiled" || kind === "framed") && (
                    <Field label={kind === "framed" ? "Framed from (General Plan No.)" : "Compiled from (source document)"}>
                      <Input value={meta.sourceRef ?? ""} onChange={set("sourceRef")} />
                    </Field>
                  )}
                  <Field label="Situate at (location)"><Input value={meta.location} onChange={set("location")} /></Field>
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
                </div>
              </Card>
            </>
          )}
          <Card title="Output">
            <div className="flex flex-col gap-2">
              <Button onClick={downloadSvg}>⬇ Download SVG</Button>
              <Button variant="ghost" onClick={printDiagram}>🖨 Print / Save PDF</Button>
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
              <>Drawn from the COGO-computed figure ({points.length} beacons, area {cogoResult.area_ha.toFixed(4)} ha).
              Template wording follows standard SG convention — verify against the official Botswana
              {" "}{KINDS.find((k) => k.id === kind)?.label.toLowerCase()} sample before lodging.</>
            )}
          </p>
        </Card>
      </div>
    </div>
  );
}
