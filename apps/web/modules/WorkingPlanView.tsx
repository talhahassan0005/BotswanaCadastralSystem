"use client";

import { useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { Button, Card, Field, Input } from "@/components/ui";
import { WorkingPlan, type WorkingPlanMeta } from "@/components/WorkingPlan";

/**
 * Working Plan (Module D / M3) — a cadastral working plan in the WP-Model.pdf
 * style, drawn from the computed figure (COGO result or a parcel sent to it).
 */
export function WorkingPlanView() {
  const { cogoResult, config, setActiveTab } = useStore();
  const svgRef = useRef<SVGSVGElement>(null);

  const points = useMemo(
    () => (cogoResult?.points ?? []).map((p) => ({ name: p.name, east: p.east, north: p.north })),
    [cogoResult]
  );
  const sides = useMemo(
    () => (cogoResult?.legs ?? []).map((l) => ({ from: l.from, to: l.to, bearing_dms: l.bearing_dms, distance: l.distance })),
    [cogoResult]
  );

  const [meta, setMeta] = useState<WorkingPlanMeta>({
    lotName: config.name && config.name !== "Untitled Survey" ? config.name.toUpperCase() : "LOT 2773 TLOKWENG",
    tribalArea: "BATLOKWA TRIBAL TERRITORY",
    scale: 750,
    coordinateSystem: config.coordinateSystem.replace(" Botswana", ""),
    observedFrom: "TLO8",
    checkedFrom: "WP1",
    referenceMarkDescription: "All Reference Marks: 20mm Iron Peg in Concrete",
    workingStationDescription: "WP1: 12mm Iron Peg",
    placedBeaconDescription: "ALL: 12mm Iron Peg",
  });
  const set = (k: keyof WorkingPlanMeta) => (v: string) =>
    setMeta((m) => ({ ...m, [k]: k === "scale" ? Number(v) || 0 : v }));

  function serialize(): string | null {
    if (!svgRef.current) return null;
    const clone = svgRef.current.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return new XMLSerializer().serializeToString(clone);
  }
  function download() {
    const svg = serialize();
    if (!svg) return;
    const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svg}`], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `working-plan-${(meta.lotName || "plan").replace(/\s+/g, "_")}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }
  function print() {
    const svg = serialize();
    if (!svg) return;
    const w = window.open("", "_blank", "width=900,height=1200");
    if (!w) return;
    w.document.write(
      `<html><head><title>Working Plan — ${meta.lotName}</title>` +
        `<style>@page{size:portrait}body{margin:0}svg{width:100%;height:auto}</style></head>` +
        `<body onload="window.print()">${svg}</body></html>`
    );
    w.document.close();
  }

  if (!cogoResult || points.length < 3) {
    return (
      <Card>
        <div className="py-12 text-center text-slate-500">
          <p className="text-lg">No computed figure yet</p>
          <p className="mt-1 text-sm">
            Run a <strong>closed traverse</strong> in the COGO Engine, or build a parcel and use
            <strong> Generate SG Diagram</strong> — the working plan is drawn from that figure.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Button onClick={() => setActiveTab("cogo")}>Go to COGO Engine</Button>
            <Button variant="ghost" onClick={() => setActiveTab("parcels")}>Go to Parcels</Button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card title="Working Plan details">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Lot / parcel name"><Input value={meta.lotName} onChange={set("lotName")} /></Field>
          <Field label="Tribal territory / area"><Input value={meta.tribalArea} onChange={set("tribalArea")} /></Field>
          <Field label="Scale 1:"><Input type="number" value={meta.scale} onChange={set("scale")} /></Field>
          <Field label="Observed from"><Input value={meta.observedFrom} onChange={set("observedFrom")} /></Field>
          <Field label="Checked from"><Input value={meta.checkedFrom} onChange={set("checkedFrom")} /></Field>
          <Field label="Coordinate system"><Input value={meta.coordinateSystem} onChange={set("coordinateSystem")} /></Field>
          <Field label="Reference marks"><Input value={meta.referenceMarkDescription} onChange={set("referenceMarkDescription")} /></Field>
          <Field label="Working station"><Input value={meta.workingStationDescription} onChange={set("workingStationDescription")} /></Field>
          <Field label="Placed beacons"><Input value={meta.placedBeaconDescription} onChange={set("placedBeaconDescription")} /></Field>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={download}>⬇ Download SVG</Button>
          <Button variant="ghost" onClick={print}>Print / Save PDF</Button>
        </div>
      </Card>

      <Card title="Working Plan">
        <div className="mx-auto max-w-3xl">
          <WorkingPlan ref={svgRef} meta={meta} points={points} sides={sides} />
        </div>
      </Card>
    </div>
  );
}
