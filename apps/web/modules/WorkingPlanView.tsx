"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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

  // Restore saved title-block from the project, else derive defaults from
  // config. workingPlanInput used to BE the meta object directly; it's now
  // {meta, labelOffsets}, so accept the old bare shape too for projects
  // saved before Part 29a.
  const savedRaw = workingPlanInput as { meta?: Partial<WorkingPlanMeta>; labelOffsets?: Record<string, { dx: number; dy: number; scale?: number }> } | Partial<WorkingPlanMeta> | null;
  const isWrappedSave = !!savedRaw && typeof savedRaw === "object" && "meta" in savedRaw;
  const saved = (isWrappedSave ? (savedRaw as { meta?: Partial<WorkingPlanMeta> }).meta : (savedRaw as Partial<WorkingPlanMeta> | null)) ?? null;
  const [labelOffsets, setLabelOffsets] = useState<Record<string, { dx: number; dy: number; scale?: number }>>(
    (isWrappedSave ? (savedRaw as { labelOffsets?: Record<string, { dx: number; dy: number; scale?: number }> }).labelOffsets : null) ?? {}
  );
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  // In-progress drag of a beacon label (client req 2026-08-26, Part 29a:
  // "snap/click on the text then... manually move it") — `orig` lets Escape
  // revert exactly. The offset is a small nudge on top of the auto-computed
  // position, not an absolute coordinate, so it stays sane even if the
  // figure's own scale/position later recomputes.
  const [draggingLabel, setDraggingLabel] = useState<{
    name: string;
    startSx: number;
    startSy: number;
    origDx: number;
    origDy: number;
  } | null>(null);
  const dragMovedRef = useRef(false);
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
  // the placed-beacon description and lot name mirror what's entered under
  // Diagrams (client req 2026-08-26, Part 29b: the title's second line must be
  // the actual lot name, e.g. "LOT 4231 GABANE" — not the generic project name).
  const diagramBeaconDesc = ((diagramInput as { meta?: { beaconDescription?: string } } | null)?.meta?.beaconDescription) || "";
  const diagramLotName = ((diagramInput as { meta?: { lotName?: string } } | null)?.meta?.lotName) || "";
  const diagramAnnotations =
    (diagramInput as { annotations?: ManualAnnotation[] } | null)?.annotations ?? [];
  const diagramTexts = (diagramInput as { texts?: ManualText[] } | null)?.texts ?? [];
  const effectiveMeta: WorkingPlanMeta = {
    ...meta,
    surveyor: config.surveyor || meta.surveyor || "",
    placedBeaconDescription: diagramBeaconDesc || meta.placedBeaconDescription,
    lotName: diagramLotName || meta.lotName,
  };
  const set = (k: keyof WorkingPlanMeta) => (v: string) =>
    setMeta((m) => ({ ...m, [k]: k === "scale" ? Number(v) || 0 : v }));

  // Persist the title-block + label positions into the project bundle so
  // they round-trip on save/open.
  useEffect(() => {
    setWorkingPlanInput({ meta, labelOffsets });
  }, [meta, labelOffsets, setWorkingPlanInput]);

  function toSvgPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }
  function handleLabelClick(name: string) {
    if (dragMovedRef.current) {
      dragMovedRef.current = false; // swallow the click that trails a drag
      return;
    }
    setSelectedLabel((cur) => (cur === name ? null : name));
  }
  function handleLabelPointerDown(name: string, e: ReactPointerEvent<SVGElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toSvgPoint(e);
    const orig = labelOffsets[name] ?? { dx: 0, dy: 0 };
    setDraggingLabel({ name, startSx: p.x, startSy: p.y, origDx: orig.dx, origDy: orig.dy });
  }
  function handleLabelPointerMove(name: string, e: ReactPointerEvent<SVGElement>) {
    if (!draggingLabel || draggingLabel.name !== name) return;
    const p = toSvgPoint(e);
    const dx = p.x - draggingLabel.startSx, dy = p.y - draggingLabel.startSy;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) dragMovedRef.current = true;
    // Spread the existing entry first so a drag never wipes out that
    // label's own resize (scale).
    setLabelOffsets((m) => ({ ...m, [name]: { ...m[name], dx: draggingLabel.origDx + dx, dy: draggingLabel.origDy + dy } }));
  }
  function handleLabelPointerUp() {
    setDraggingLabel(null);
  }
  function cancelLabelDrag() {
    if (!draggingLabel) return;
    setLabelOffsets((m) => ({ ...m, [draggingLabel.name]: { ...m[draggingLabel.name], dx: draggingLabel.origDx, dy: draggingLabel.origDy } }));
    setDraggingLabel(null);
  }
  function handleLabelResize(name: string, delta: number) {
    setLabelOffsets((m) => {
      const cur = m[name] ?? { dx: 0, dy: 0, scale: 1 };
      const scale = Math.max(0.5, Math.min(3, (cur.scale ?? 1) + delta));
      return { ...m, [name]: { ...cur, scale } };
    });
  }
  useEffect(() => {
    if (!draggingLabel) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") cancelLabelDrag(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingLabel]);

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
          <Field label="Lot / parcel name (auto from Diagram if set)"><Input value={meta.lotName} onChange={set("lotName")} /></Field>
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
          Land Surveyor is taken automatically from the project surveyor{config.surveyor ? ` (${config.surveyor})` : ` — set it in ${cogoTabLabel(config.discipline)} ▸ Project Details`}. Lot name and placed-beacon description mirror what's entered under Diagrams.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={download}>⬇ Download SVG</Button>
          <Button variant="ghost" onClick={print}>Print / Save PDF</Button>
        </div>
      </Card>

      <Card title="Working Plan">
        <p className="mb-2 text-xs text-slate-400">
          Click a beacon letter to select it, then drag to reposition, or use the +/− buttons to resize it
          — useful where labels sit close together (e.g. tightly-spaced beacons). Esc cancels a drag in progress.
        </p>
        <div className="mx-auto max-w-3xl" onClick={() => setSelectedLabel(null)}>
          <WorkingPlan
            ref={svgRef}
            meta={effectiveMeta}
            points={points}
            sides={sides}
            refMarks={refMarks}
            manualAnnotations={diagramAnnotations}
            manualTexts={diagramTexts}
            labelOffsets={labelOffsets}
            selectedLabel={selectedLabel}
            onLabelClick={(name) => handleLabelClick(name)}
            onLabelPointerDown={handleLabelPointerDown}
            onLabelPointerMove={handleLabelPointerMove}
            onLabelPointerUp={handleLabelPointerUp}
            onLabelResize={handleLabelResize}
          />
        </div>
      </Card>
    </div>
  );
}
