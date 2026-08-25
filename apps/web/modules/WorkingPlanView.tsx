"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, cogoTabLabel } from "@/lib/store";
import { Button, Card, Field, Input } from "@/components/ui";
import { WorkingPlan, type WorkingPlanMeta } from "@/components/WorkingPlan";
import type { ManualAnnotation, ManualText } from "@/components/SgDiagram";

/**
 * Working Plan (Module D / M3) — a cadastral working plan in the WP-Model.pdf
 * style, drawn from the computed figure (COGO result or a parcel sent to it).
 */
export function WorkingPlanView() {
  const { cogoResult, diagramFigure, config, setActiveTab, workingPlanInput, setWorkingPlanInput, diagramInput, importResult } = useStore();
  const svgRef = useRef<SVGSVGElement>(null);
  const fig = diagramFigure ?? cogoResult;

  const points = useMemo(
    () => (fig?.points ?? []).map((p) => ({ name: p.name, east: p.east, north: p.north })),
    [fig]
  );
  const sides = useMemo(
    () => (fig?.legs ?? []).map((l) => ({ from: l.from, to: l.to, bearing_dms: l.bearing_dms, distance: l.distance })),
    [fig]
  );
  // Reference marks (client req 2026-08-20, Part 12b) — excluded from the
  // Cadastral work station, but shown here since Working Plan is where
  // reference marks are actually used.
  const refMarks = useMemo(
    () =>
      (importResult?.rows ?? [])
        .filter((r) => r.east != null && r.north != null && r.pointType === "ref")
        .map((r) => ({ name: r.beaconId, east: r.east as number, north: r.north as number })),
    [importResult]
  );

  // Restore saved title-block from the project, else derive defaults from config.
  const saved = (workingPlanInput ?? null) as Partial<WorkingPlanMeta> | null;
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
    surveyor: config.surveyor || "",
    dateOfSurvey: "",
    ...(saved ?? {}),
  });

  // Auto-captured values: the Land Surveyor comes from the project surveyor, and
  // the placed-beacon description mirrors the one entered under Diagrams.
  const diagramBeaconDesc = ((diagramInput as { meta?: { beaconDescription?: string } } | null)?.meta?.beaconDescription) || "";
  const diagramAnnotations =
    (diagramInput as { annotations?: ManualAnnotation[] } | null)?.annotations ?? [];
  const diagramTexts = (diagramInput as { texts?: ManualText[] } | null)?.texts ?? [];
  const effectiveMeta: WorkingPlanMeta = {
    ...meta,
    surveyor: config.surveyor || meta.surveyor || "",
    placedBeaconDescription: diagramBeaconDesc || meta.placedBeaconDescription,
  };
  const set = (k: keyof WorkingPlanMeta) => (v: string) =>
    setMeta((m) => ({ ...m, [k]: k === "scale" ? Number(v) || 0 : v }));

  // Persist the title-block into the project bundle so it round-trips on save/open.
  useEffect(() => {
    setWorkingPlanInput(meta);
  }, [meta, setWorkingPlanInput]);

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
    if (!w) {
      alert("Pop-up blocked. Please allow pop-ups for this site in your browser, then click Print again.");
      return;
    }
    w.document.write(
      `<html><head><title>Working Plan — ${meta.lotName}</title>` +
        `<style>@page{size:portrait}body{margin:0}svg{width:100%;height:auto}</style></head>` +
        `<body onload="window.print()">${svg}</body></html>`
    );
    w.document.close();
  }

  if (!fig || points.length < 3) {
    const cogoLabel = cogoTabLabel(config.discipline);
    return (
      <Card>
        <div className="py-12 text-center text-slate-500">
          <p className="text-lg">No computed figure yet</p>
          <p className="mt-1 text-sm">
            Run a <strong>closed traverse</strong> in the {cogoLabel}, or build a parcel and use
            <strong> Generate SG Diagram</strong> — the working plan is drawn from that figure.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Button onClick={() => setActiveTab("cogo")}>Go to {cogoLabel}</Button>
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
          <Field label="Placed beacons (auto from Diagram if set)"><Input value={meta.placedBeaconDescription} onChange={set("placedBeaconDescription")} /></Field>
          <Field label="Date of survey"><Input value={meta.dateOfSurvey ?? ""} onChange={set("dateOfSurvey")} placeholder="e.g. 15 June 2026" /></Field>
        </div>
        <p className="mt-2 text-xs text-slate-400">
          Land Surveyor is taken automatically from the project surveyor{config.surveyor ? ` (${config.surveyor})` : ` — set it in ${cogoTabLabel(config.discipline)} ▸ Project Details`}. Placed-beacon description mirrors the one entered under Diagrams.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={download}>⬇ Download SVG</Button>
          <Button variant="ghost" onClick={print}>Print / Save PDF</Button>
        </div>
      </Card>

      <Card title="Working Plan">
        <div className="mx-auto max-w-3xl">
          <WorkingPlan
            ref={svgRef}
            meta={effectiveMeta}
            points={points}
            sides={sides}
            refMarks={refMarks}
            manualAnnotations={diagramAnnotations}
            manualTexts={diagramTexts}
          />
        </div>
      </Card>
    </div>
  );
}
