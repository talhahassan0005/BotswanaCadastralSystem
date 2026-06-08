"use client";

import { useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { Button, Card, Field, Input } from "@/components/ui";
import { SgDiagram, type DiagramMeta } from "@/components/SgDiagram";

export function Diagrams() {
  const { cogoResult, config, setActiveTab } = useStore();
  const svgRef = useRef<SVGSVGElement>(null);

  // `closed` is derived from the COGO result, not edited in the form.
  const [meta, setMeta] = useState<Omit<DiagramMeta, "closed">>({
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
    areaHa: cogoResult?.area_ha ?? meta.areaHa,
    closed: cogoResult?.type === "closed",
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
    const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svg}`], {
      type: "image/svg+xml",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `SG-Diagram-${(meta.lotName || "diagram").replace(/\s+/g, "_")}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function printDiagram() {
    const svg = serializeSvg();
    if (!svg) return;
    const w = window.open("", "_blank", "width=1200,height=850");
    if (!w) return;
    w.document.write(
      `<html><head><title>SG Diagram — ${meta.lotName}</title>` +
        `<style>@page{size:landscape}body{margin:0}svg{width:100%;height:auto}</style></head>` +
        `<body onload="window.print()">${svg}</body></html>`
    );
    w.document.close();
  }

  const set = (k: keyof Omit<DiagramMeta, "closed">) => (v: string) =>
    setMeta((m) => ({ ...m, [k]: k === "scale" ? Number(v) || 0 : v }));

  if (!cogoResult || points.length < 3) {
    return (
      <Card>
        <div className="py-12 text-center text-slate-500">
          <p className="text-lg">No computed figure yet</p>
          <p className="mt-1 text-sm">
            Run a <strong>closed traverse</strong> in the COGO Engine first — the SG Diagram is drawn
            from its computed beacon coordinates and sides.
          </p>
          <div className="mt-4">
            <Button onClick={() => setActiveTab("cogo")}>Go to COGO Engine</Button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
      <div className="space-y-4">
        <Card title="Diagram Details">
          <div className="space-y-3">
            <Field label="Land called (lot name)"><Input value={meta.lotName} onChange={set("lotName")} /></Field>
            <Field label="Parent / portion"><Input value={meta.parent} onChange={set("parent")} /></Field>
            <Field label="Situate at (location)"><Input value={meta.location} onChange={set("location")} /></Field>
            <Field label="Tribal / administrative area"><Input value={meta.tribalArea} onChange={set("tribalArea")} /></Field>
            <Field label="Land surveyor"><Input value={meta.surveyor} onChange={set("surveyor")} /></Field>
            <Field label="Surveyed (date)"><Input value={meta.surveyedDate} onChange={set("surveyedDate")} /></Field>
            <Field label="Scale 1:N"><Input type="number" value={meta.scale} onChange={set("scale")} /></Field>
            <Field label="Beacon description"><Input value={meta.beaconDescription} onChange={set("beaconDescription")} /></Field>
          </div>
        </Card>
        <Card title="Registration">
          <div className="space-y-3">
            <Field label="D.S.M No."><Input value={meta.dsmNo} onChange={set("dsmNo")} /></Field>
            <Field label="S.R No."><Input value={meta.srNo} onChange={set("srNo")} /></Field>
            <Field label="General Plan No."><Input value={meta.gpNo} onChange={set("gpNo")} /></Field>
            <Field label="Degree Square"><Input value={meta.degreeSquare} onChange={set("degreeSquare")} /></Field>
          </div>
          <div className="mt-4 flex flex-col gap-2">
            <Button onClick={downloadSvg}>⬇ Download SVG</Button>
            <Button variant="ghost" onClick={printDiagram}>🖨 Print / Save PDF</Button>
          </div>
        </Card>
      </div>

      <Card title="SG Diagram Preview" className="overflow-auto">
        <div className="rounded-lg border border-slate-200">
          <SgDiagram ref={svgRef} meta={fullMeta} points={points} sides={sides} />
        </div>
        <p className="mt-3 text-xs text-slate-400">
          Drawn from the COGO-computed figure ({points.length} beacons, area {(cogoResult.area_ha).toFixed(4)} ha).
          Coordinates are the engine&apos;s working values; once official {meta.coordinateSystem} transform
          parameters are wired (Phase 2), the Y/X table will carry true Lo grid values.
        </p>
      </Card>
    </div>
  );
}
