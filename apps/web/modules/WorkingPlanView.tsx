"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useStore, cogoTabLabel } from "@/lib/store";
import { Button, Card, Field, Input } from "@/components/ui";
import { WorkingPlan, type WorkingPlanMeta, type WorkingPlanPlot } from "@/components/WorkingPlan";
import type { ManualAnnotation, ManualText, DiagramTransform } from "@/components/SgDiagram";
import { writeDxf, type ImportedDrawing } from "@/lib/dxf";
import { dedupePoints } from "@/lib/plots";

/**
 * Working Plan (Module D / M3) — a cadastral working plan in the WP-Model.pdf
 * style, drawn from the computed figure (COGO result or a parcel sent to it),
 * or from several numbered plots picked from the Cadastral work station
 * (client req 2026-08-26, Part 33: "Working plan should allow to add and
 * work on multiple plots from COGO... like shown", e.g. a subdivision's
 * LOTS 37455-37458 all drawn on one sheet).
 */
export function WorkingPlanView() {
  const { cogoResult, diagramFigure, config, setActiveTab, workingPlanInput, setWorkingPlanInput, diagramInput, importResult, cogoPlots } = useStore();
  const svgRef = useRef<SVGSVGElement>(null);
  const fig = diagramFigure ?? cogoResult;
  // Live pixel<->survey-coordinate conversion for whatever's currently drawn
  // (client req 2026-08-28: "Also download Dxf") — handed over by
  // WorkingPlan's own onTransform, same mechanism Diagrams.tsx already uses
  // for its DXF export. A ref, not state: it's set during WorkingPlan's own
  // render, so setState here would be a React anti-pattern.
  const transformRef = useRef<DiagramTransform | null>(null);

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
  // {meta, labelOffsets, plotNumbers}, so accept the old bare shape too for
  // projects saved before Part 29a.
  const savedRaw = workingPlanInput as
    | {
        meta?: Partial<WorkingPlanMeta>;
        labelOffsets?: Record<string, { dx: number; dy: number; scale?: number }>;
        textOffsets?: Record<string, { dx: number; dy: number; scale?: number }>;
        titleOffset?: { dx: number; dy: number; scale?: number };
        plotNumbers?: string[];
      }
    | Partial<WorkingPlanMeta>
    | null;
  const isWrappedSave = !!savedRaw && typeof savedRaw === "object" && "meta" in savedRaw;
  const saved = (isWrappedSave ? (savedRaw as { meta?: Partial<WorkingPlanMeta> }).meta : (savedRaw as Partial<WorkingPlanMeta> | null)) ?? null;
  const [labelOffsets, setLabelOffsets] = useState<Record<string, { dx: number; dy: number; scale?: number }>>(
    (isWrappedSave ? (savedRaw as { labelOffsets?: Record<string, { dx: number; dy: number; scale?: number }> }).labelOffsets : null) ?? {}
  );
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  // Same select/move/resize treatment, but for the manual text notes (client
  // req 2026-08-28) — its own offset store keyed by note id, kept separate
  // from `labelOffsets` (which is keyed by point name) and from the
  // Diagrams module's own copy of the note (see WorkingPlan.tsx's prop doc).
  const [textOffsets, setTextOffsets] = useState<Record<string, { dx: number; dy: number; scale?: number }>>(
    (isWrappedSave ? (savedRaw as { textOffsets?: Record<string, { dx: number; dy: number; scale?: number }> }).textOffsets : null) ?? {}
  );
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  // Same select/move/resize treatment for the title block itself (client req
  // 2026-08-28, screenshot pointed at "WORKING PLAN OF / LOTS.../TRIBAL
  // TERRITORY/SCALE") — one offset for the whole block, not per-line.
  const [titleOffset, setTitleOffset] = useState<{ dx: number; dy: number; scale?: number }>(
    (isWrappedSave ? (savedRaw as { titleOffset?: { dx: number; dy: number; scale?: number } }).titleOffset : null) ?? { dx: 0, dy: 0 }
  );
  const [titleSelected, setTitleSelected] = useState(false);
  // Plots picked from the Cadastral work station for one multi-plot sheet
  // (client req 2026-08-26, Part 33a) — numbers only; resolved against
  // `cogoPlots` below so the sheet always reflects that tab's latest data.
  const [plotNumbers, setPlotNumbers] = useState<string[]>(
    (isWrappedSave ? (savedRaw as { plotNumbers?: string[] }).plotNumbers : null) ?? []
  );
  const [plotNumberInput, setPlotNumberInput] = useState("");
  const [plotNumberError, setPlotNumberError] = useState<string | null>(null);
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
  // Same in-progress-drag tracking as beacon labels, for the manual text
  // notes (client req 2026-08-28).
  const [draggingText, setDraggingText] = useState<{
    id: string;
    startSx: number;
    startSy: number;
    origDx: number;
    origDy: number;
  } | null>(null);
  const dragTextMovedRef = useRef(false);
  // Same in-progress-drag tracking, for the title block (client req 2026-08-28).
  const [draggingTitle, setDraggingTitle] = useState<{ startSx: number; startSy: number; origDx: number; origDy: number } | null>(null);
  const dragTitleMovedRef = useRef(false);
  // One-time default for the multi-plot title's "PORTIONS OF LOT [...]" line
  // (client req 2026-08-26, Part 33b) — seeded from the Diagrams module's
  // "Parent / portion" field (e.g. "A PORTION OF CADASTRE 243" -> "243"),
  // same source Part 33b names ("Part 19's parent-portion field"), but kept
  // as its own editable value since the prefix wording varies case to case.
  const initialDiagramParent = ((diagramInput as { meta?: { parent?: string } } | null)?.meta?.parent) || "";
  const initialParentLotNumber = initialDiagramParent.replace(/^a\s+portion\s+of\s+cadastre\s+/i, "").trim();
  const initialLocality = ((diagramInput as { meta?: { location?: string } } | null)?.meta?.location) || "";
  const [meta, setMeta] = useState<WorkingPlanMeta>({
    lotName: config.name && config.name !== "Untitled Survey" ? config.name.toUpperCase() : "LOT 2773 TLOKWENG",
    parent: "",
    tribalArea: "BATLOKWA TRIBAL TERRITORY",
    scale: 750,
    coordinateSystem: config.coordinateSystem.replace(" Botswana", ""),
    observedFrom: "TLO8",
    checkedFrom: "WP1",
    referenceMarkDescription: "All Reference Marks: 20mm Iron Peg in Concrete",
    workingStationDescription: "WP1: 12mm Iron Peg",
    placedBeaconDescription: "ALL: 12mm Iron Peg",
    foundBeaconDescription: "",
    surveyor: config.surveyor || "",
    dateOfSurvey: "",
    parentLotNumber: initialParentLotNumber,
    locality: initialLocality,
    ...(saved ?? {}),
  });

  // Auto-captured values: the Land Surveyor comes from the project surveyor, and
  // the placed-beacon description and lot name mirror what's entered under
  // Diagrams (client req 2026-08-26, Part 29b: the title's second line must be
  // the actual lot name, e.g. "LOT 4231 GABANE" — not the generic project name).
  const diagramBeaconDesc = ((diagramInput as { meta?: { beaconDescription?: string } } | null)?.meta?.beaconDescription) || "";
  const diagramLotName = ((diagramInput as { meta?: { lotName?: string } } | null)?.meta?.lotName) || "";
  // "Parent / portion" (client req 2026-08-26: "we want to Add that there")
  // — reused from the Diagrams module's own field, same as lotName above,
  // not re-collected here.
  const diagramParent = ((diagramInput as { meta?: { parent?: string } } | null)?.meta?.parent) || "";
  const diagramAnnotations =
    (diagramInput as { annotations?: ManualAnnotation[] } | null)?.annotations ?? [];
  const diagramTexts = (diagramInput as { texts?: ManualText[] } | null)?.texts ?? [];
  const effectiveMeta: WorkingPlanMeta = {
    ...meta,
    surveyor: config.surveyor || meta.surveyor || "",
    placedBeaconDescription: diagramBeaconDesc || meta.placedBeaconDescription,
    lotName: diagramLotName || meta.lotName,
    parent: diagramParent || meta.parent,
  };
  const set = (k: keyof WorkingPlanMeta) => (v: string) =>
    setMeta((m) => ({ ...m, [k]: k === "scale" ? Number(v) || 0 : v }));

  // Resolve the picked plot numbers against the Cadastral work station's own
  // saved plots (client req 2026-08-26, Part 33a) — always looked up live so
  // the sheet reflects that tab's latest coordinates, not a frozen copy.
  // A number that no longer resolves (renamed/deleted there) is silently
  // dropped rather than breaking the whole sheet.
  const resolvedPlots: WorkingPlanPlot[] = useMemo(
    () =>
      plotNumbers
        .map((n) => cogoPlots.find((p) => p.number.toLowerCase() === n.toLowerCase()))
        .filter((p): p is NonNullable<typeof p> => !!p)
        .map((p) => ({
          number: p.number,
          points: p.fig.points.map((pt) => ({ name: pt.name, east: pt.east, north: pt.north })),
        })),
    [plotNumbers, cogoPlots]
  );

  function addPlot() {
    const n = plotNumberInput.trim();
    if (!n) return;
    if (plotNumbers.some((p) => p.toLowerCase() === n.toLowerCase())) {
      setPlotNumberError(`Plot "${n}" is already on this sheet.`);
      return;
    }
    const plot = cogoPlots.find((p) => p.number.toLowerCase() === n.toLowerCase());
    if (!plot) {
      setPlotNumberError(`No plot numbered "${n}" found. Number it first in ${cogoTabLabel(config.discipline)} — the Lot Number prompt after finishing a polygon, or Tables → Polygons → Position.`);
      return;
    }
    setPlotNumberError(null);
    setPlotNumberInput("");
    setPlotNumbers((list) => [...list, plot.number]);
  }
  function removePlot(n: string) {
    setPlotNumbers((list) => list.filter((x) => x !== n));
  }

  // Persist the title-block + label positions + picked plots into the
  // project bundle so they round-trip on save/open.
  useEffect(() => {
    setWorkingPlanInput({ meta, labelOffsets, textOffsets, titleOffset, plotNumbers });
  }, [meta, labelOffsets, textOffsets, titleOffset, plotNumbers, setWorkingPlanInput]);

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

  // Text-note equivalents of the beacon-label handlers above (client req
  // 2026-08-28).
  function handleTextClick(id: string) {
    if (dragTextMovedRef.current) {
      dragTextMovedRef.current = false;
      return;
    }
    setSelectedTextId((cur) => (cur === id ? null : id));
  }
  function handleTextPointerDown(id: string, e: ReactPointerEvent<SVGElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toSvgPoint(e);
    const orig = textOffsets[id] ?? { dx: 0, dy: 0 };
    setDraggingText({ id, startSx: p.x, startSy: p.y, origDx: orig.dx, origDy: orig.dy });
  }
  function handleTextPointerMove(id: string, e: ReactPointerEvent<SVGElement>) {
    if (!draggingText || draggingText.id !== id) return;
    const p = toSvgPoint(e);
    const dx = p.x - draggingText.startSx, dy = p.y - draggingText.startSy;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) dragTextMovedRef.current = true;
    setTextOffsets((m) => ({ ...m, [id]: { ...m[id], dx: draggingText.origDx + dx, dy: draggingText.origDy + dy } }));
  }
  function handleTextPointerUp() {
    setDraggingText(null);
  }
  function cancelTextDrag() {
    if (!draggingText) return;
    setTextOffsets((m) => ({ ...m, [draggingText.id]: { ...m[draggingText.id], dx: draggingText.origDx, dy: draggingText.origDy } }));
    setDraggingText(null);
  }
  function handleTextResize(id: string, delta: number) {
    setTextOffsets((m) => {
      const cur = m[id] ?? { dx: 0, dy: 0, scale: 1 };
      const scale = Math.max(0.5, Math.min(3, (cur.scale ?? 1) + delta));
      return { ...m, [id]: { ...cur, scale } };
    });
  }
  useEffect(() => {
    if (!draggingText) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") cancelTextDrag(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingText]);

  // Title-block equivalents of the text-note handlers above (client req
  // 2026-08-28) — one offset for the whole block, so no id parameter.
  function handleTitleClick() {
    if (dragTitleMovedRef.current) {
      dragTitleMovedRef.current = false;
      return;
    }
    setTitleSelected((cur) => !cur);
  }
  function handleTitlePointerDown(e: ReactPointerEvent<SVGElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toSvgPoint(e);
    setDraggingTitle({ startSx: p.x, startSy: p.y, origDx: titleOffset.dx, origDy: titleOffset.dy });
  }
  function handleTitlePointerMove(e: ReactPointerEvent<SVGElement>) {
    if (!draggingTitle) return;
    const p = toSvgPoint(e);
    const dx = p.x - draggingTitle.startSx, dy = p.y - draggingTitle.startSy;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) dragTitleMovedRef.current = true;
    setTitleOffset((cur) => ({ ...cur, dx: draggingTitle.origDx + dx, dy: draggingTitle.origDy + dy }));
  }
  function handleTitlePointerUp() {
    setDraggingTitle(null);
  }
  function cancelTitleDrag() {
    if (!draggingTitle) return;
    setTitleOffset((cur) => ({ ...cur, dx: draggingTitle.origDx, dy: draggingTitle.origDy }));
    setDraggingTitle(null);
  }
  function handleTitleResize(delta: number) {
    setTitleOffset((cur) => ({ ...cur, scale: Math.max(0.5, Math.min(3, (cur.scale ?? 1) + delta)) }));
  }
  useEffect(() => {
    if (!draggingTitle) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") cancelTitleDrag(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingTitle]);

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
  // DXF export (client req 2026-08-28: "Also download Dxf") — same pattern
  // Diagrams.tsx's own downloadDxf() uses: walk this sheet's real geometry
  // through the SAME east/north<->screen transform WorkingPlan hands back
  // via onTransform, emitting DXF entities rather than re-deriving layout.
  // Covers the survey content a DXF is actually needed for — boundary,
  // beacons, manual annotations/notes, and the title/description text —
  // rather than chasing pixel-for-pixel fidelity with every sheet decoration
  // (grid lines, inset box) the way Diagrams.tsx's more mature export does.
  function downloadDxf() {
    const t = transformRef.current;
    if (!t) return;
    const a = t.toWorld(0, 0), b = t.toWorld(1, 0);
    const metresPerUnit = Math.hypot(b.east - a.east, b.north - a.north) || 1;
    const notes: ImportedDrawing["texts"] = [];
    const polylines: ImportedDrawing["polylines"] = [];
    const beaconPoints: ImportedDrawing["points"] = [];

    function text(x: number, y: number, s: string, heightUnits: number, anchor?: "middle" | "end") {
      if (!s) return;
      const p = t!.toWorld(x, y);
      notes.push({ x: p.east, y: p.north, text: s, height: heightUnits * metresPerUnit, layer: "SHEET", anchor });
    }

    const activePlots = resolvedPlots.length > 0 ? resolvedPlots : [{ number: effectiveMeta.lotName, points }];
    for (const plot of activePlots) {
      if (plot.points.length < 2) continue;
      polylines.push({
        pts: plot.points.map((p) => ({ x: p.east, y: p.north })),
        closed: plot.points.length >= 3,
        layer: "BOUNDARY",
      });
    }
    const allBeacons = dedupePoints(activePlots);
    for (const p of allBeacons) {
      if (!p.name) continue;
      beaconPoints.push({ x: p.east, y: p.north, label: p.name, layer: "BEACONS" });
    }
    for (const r of refMarks) {
      beaconPoints.push({ x: r.east, y: r.north, label: r.name ?? undefined, layer: "REFERENCE" });
    }
    for (const ann of diagramAnnotations) {
      polylines.push({ pts: [{ x: ann.e1, y: ann.n1 }, { x: ann.e2, y: ann.n2 }], closed: false, layer: "ANNOTATIONS" });
    }
    for (const tt of diagramTexts) {
      const off = textOffsets[tt.id];
      const p = off ? t.toWorld(t.toScreen(tt.east, tt.north).x + off.dx, t.toScreen(tt.east, tt.north).y + off.dy) : { east: tt.east, north: tt.north };
      notes.push({ x: p.east, y: p.north, text: tt.text, height: 10 * (off?.scale ?? 1) * metresPerUnit, layer: "NOTES" });
    }

    // Title block text — approximate positions matching WorkingPlan.tsx's
    // own title layout (VB_W=600), not a pixel-exact re-derivation of it —
    // shifted/scaled by the same titleOffset the user dragged/resized on
    // screen, so the DXF matches wherever the title currently sits.
    const tOff = titleOffset;
    const tScale = tOff.scale ?? 1;
    const titleX = 300 + tOff.dx;
    text(titleX, 40 + tOff.dy, "WORKING PLAN OF", 14 * tScale, "middle");
    text(titleX, 62 + tOff.dy, resolvedPlots.length > 0 ? `LOTS ${resolvedPlots.map((p) => p.number).join(", ")} ${effectiveMeta.locality || ""}` : effectiveMeta.lotName, 13 * tScale, "middle");
    text(titleX, 84 + tOff.dy, effectiveMeta.tribalArea, 12 * tScale, "middle");
    text(titleX, 104 + tOff.dy, `1:${effectiveMeta.scale}`, 12 * tScale, "middle");
    text(26, 30, `REFERENCE MARKS: ${effectiveMeta.referenceMarkDescription}`, 8.5);
    text(26, 42, `WORKING STATION: ${effectiveMeta.workingStationDescription}`, 8.5);
    text(26, 54, `PLACED BEACONS: ${effectiveMeta.placedBeaconDescription}`, 8.5);
    if (effectiveMeta.foundBeaconDescription) text(26, 66, `FOUND BEACONS: ${effectiveMeta.foundBeaconDescription}`, 8.5);
    text(26, 78, `Land Surveyor: ${effectiveMeta.surveyor || "—"}`, 8.5);
    text(26, 90, `Date of survey: ${effectiveMeta.dateOfSurvey || "—"}`, 8.5);

    const drawing: ImportedDrawing = { points: beaconPoints, polylines, texts: notes };
    const dxf = writeDxf(drawing);
    const blob = new Blob([dxf], { type: "application/dxf" });
    const url = URL.createObjectURL(blob);
    const a2 = document.createElement("a");
    a2.href = url;
    a2.download = `working-plan-${(meta.lotName || "plan").replace(/\s+/g, "_")}.dxf`;
    a2.click();
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

  // A multi-plot sheet needs no "currently active" figure at all — it's
  // built entirely from numbered plots already saved in the Cadastral work
  // station (client req 2026-08-26, Part 33a), so only show the empty state
  // when there's neither an active figure nor any resolvable picked plot.
  if ((!fig || points.length < 3) && resolvedPlots.length === 0) {
    const cogoLabel = cogoTabLabel(config.discipline);
    return (
      <Card>
        <div className="py-12 text-center text-slate-500">
          <p className="text-lg">No computed figure yet</p>
          <p className="mt-1 text-sm">
            Run a <strong>closed traverse</strong> in the {cogoLabel}, or build a parcel and use
            <strong> Generate SG Diagram</strong> — the working plan is drawn from that figure. Or add one or
            more numbered plots below if you've already saved them in {cogoLabel}.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Button onClick={() => setActiveTab("cogo")}>Go to {cogoLabel}</Button>
            <Button variant="ghost" onClick={() => setActiveTab("parcels")}>Go to Parcels</Button>
          </div>
          {cogoPlots.length > 0 && (
            <div className="mx-auto mt-6 max-w-sm text-left">
              <Field label={`Add a plot (from ${cogoLabel})`}>
                <div className="flex gap-2">
                  <Input
                    value={plotNumberInput}
                    onChange={setPlotNumberInput}
                    placeholder="e.g. 37455"
                    onKeyDown={(e) => { if (e.key === "Enter") addPlot(); }}
                  />
                  <Button onClick={addPlot}>Add</Button>
                </div>
              </Field>
              {plotNumberError && <p className="mt-1 text-xs text-red-600">{plotNumberError}</p>}
            </div>
          )}
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
          <Field label="Found beacons"><Input value={meta.foundBeaconDescription ?? ""} onChange={set("foundBeaconDescription")} placeholder="e.g. All Found Beacons: 20mm Iron Peg" /></Field>
          <Field label="Date of survey"><Input value={meta.dateOfSurvey ?? ""} onChange={set("dateOfSurvey")} placeholder="e.g. 15 June 2026" /></Field>
        </div>
        <p className="mt-2 text-xs text-slate-400">
          Land Surveyor is taken automatically from the project surveyor{config.surveyor ? ` (${config.surveyor})` : ` — set it in ${cogoTabLabel(config.discipline)} ▸ Project Details`}. Lot name and placed-beacon description mirror what's entered under Diagrams.
        </p>

        {/* Multi-plot sheet (client req 2026-08-26, Part 33a) — draw several
            numbered plots from the Cadastral work station on one sheet, e.g.
            a subdivision's adjoining lots. Hidden entirely when nothing has
            been numbered there yet, same as Diagrams' own plot picker. */}
        {cogoPlots.length > 0 && (
          <div className="mt-4 border-t border-slate-100 pt-4">
            <p className="text-sm font-medium text-slate-700">Multi-plot sheet (optional)</p>
            <p className="mt-1 text-xs text-slate-400">
              Add numbered plots from {cogoTabLabel(config.discipline)} to draw them together on one sheet
              — shared boundary points between adjoining plots are drawn once.
            </p>
            <div className="mt-2 flex max-w-sm gap-2">
              <Input
                value={plotNumberInput}
                onChange={setPlotNumberInput}
                placeholder="e.g. 37455"
                onKeyDown={(e) => { if (e.key === "Enter") addPlot(); }}
              />
              <Button onClick={addPlot}>Add plot</Button>
            </div>
            {plotNumberError && <p className="mt-1 text-xs text-red-600">{plotNumberError}</p>}
            {plotNumbers.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {plotNumbers.map((n) => (
                  <span key={n} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700">
                    {n}
                    <button
                      type="button"
                      onClick={() => removePlot(n)}
                      className="text-slate-400 hover:text-red-600"
                      aria-label={`Remove plot ${n}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {plotNumbers.length > 0 && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label='Parent lot number (for "PORTIONS OF LOT")'>
                  <Input value={meta.parentLotNumber ?? ""} onChange={set("parentLotNumber")} placeholder="e.g. 37454" />
                </Field>
                <Field label="Locality"><Input value={meta.locality ?? ""} onChange={set("locality")} placeholder="e.g. GABORONE" /></Field>
              </div>
            )}
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={download}>⬇ Download SVG</Button>
          <Button variant="ghost" onClick={downloadDxf}>⬇ Download DXF</Button>
          <Button variant="ghost" onClick={print}>Print / Save PDF</Button>
        </div>
      </Card>

      <Card title="Working Plan">
        <p className="mb-2 text-xs text-slate-400">
          Click a beacon letter, a text note, or the title block to select it, then drag to reposition, or use the +/− buttons to
          resize it — useful where labels sit close together (e.g. tightly-spaced beacons). Esc cancels a drag in progress.
        </p>
        <div className="mx-auto max-w-3xl" onClick={() => { setSelectedLabel(null); setSelectedTextId(null); setTitleSelected(false); }}>
          <WorkingPlan
            ref={svgRef}
            meta={effectiveMeta}
            points={points}
            sides={sides}
            plots={resolvedPlots.length > 0 ? resolvedPlots : undefined}
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
            textOffsets={textOffsets}
            selectedTextId={selectedTextId}
            onTextClick={(id) => handleTextClick(id)}
            onTextPointerDown={handleTextPointerDown}
            onTextPointerMove={handleTextPointerMove}
            onTextPointerUp={handleTextPointerUp}
            onTextResize={handleTextResize}
            titleOffset={titleOffset}
            titleSelected={titleSelected}
            onTitleClick={handleTitleClick}
            onTitlePointerDown={handleTitlePointerDown}
            onTitlePointerMove={handleTitlePointerMove}
            onTitlePointerUp={handleTitlePointerUp}
            onTitleResize={handleTitleResize}
            onTransform={(t) => { transformRef.current = t; }}
            rotation={config.displayRotation ?? 0}
            flip={config.displayFlip ?? false}
          />
        </div>
      </Card>
    </div>
  );
}
