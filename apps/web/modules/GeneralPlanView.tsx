"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "@/lib/store";
import { Button, Card, Field, Input } from "@/components/ui";
import { displayCrs } from "@/lib/crsOptions";
import { dedupePoints, findBlockCorners, findOuterBoundary, sameWorldPoint, type Plot } from "@/lib/plots";
import { comparePointNames } from "@/lib/reportFormats";
import { fmtSystem } from "@/lib/diagramLayout";
import { inverse } from "@/lib/server/geometry";
import { formatDms } from "@/lib/server/angles";
import { type ManualText } from "@/components/SgDiagram";
import { writeDxf, type ImportedDrawing } from "@/lib/dxf";

const PALETTE = ["#0d9488", "#2563eb", "#db2777", "#d97706", "#7c3aed", "#16a34a", "#dc2626", "#0891b2"];
const COORDS_PER_SHEET = 48;
const W = 1000;
const H = 707; // A4 landscape ratio

/** One numbered plot's boundary, resolved from `cogoPlots` for drawing. */
interface GpBeacon { id: string; east: number; north: number }

/** Multi-sheet General Plan (Module D / M3): the whole layout of every plot
 *  numbered on the Cadastral/COGO canvas, on sheet 1, with the beacon
 *  coordinate schedule paginated onto continuation sheets.
 *
 *  Sourced from `cogoPlots` (client req 2026-08-27: "after joining all plots
 *  in code, you just click on General Plan — all polygons appear") — every
 *  plot ever given a Position/Lot number in COGO shows up here automatically,
 *  no manual re-selection or re-import, mirroring how Working Plan already
 *  reads `cogoPlots` (see WorkingPlanView.tsx's `resolvedPlots`) but without
 *  its manual `plotNumbers` picker: General Plan always shows ALL of them. */
export function GeneralPlanView() {
  const { cogoPlots, config, generalPlanInput, setGeneralPlanInput, importResult } = useStore();

  const refs = useRef<(SVGSVGElement | null)[]>([]);
  const [sheet, setSheet] = useState(0);
  // GP's own Working Plan variant (client req 2026-08-27/28, spec Part 3):
  // same drawing + descriptive block, but the Lot Numbers/Block Corner/
  // traverse tables are dropped in favour of an inset reference-mark sketch
  // + certification box — a display mode, not a separate saved document.
  const [sheetMode, setSheetMode] = useState<"general" | "working">("general");
  // Reference marks (same source as WorkingPlanView.tsx) — only relevant in
  // "working" mode, for the inset box.
  const refMarksGp = useMemo(
    () =>
      (importResult?.rows ?? [])
        .filter((r) => r.east != null && r.north != null && r.pointType === "ref")
        .map((r) => ({ name: r.beaconId, east: r.east as number, north: r.north as number })),
    [importResult]
  );

  const gpPlots = useMemo<Plot[]>(
    () => cogoPlots.map((p) => ({ number: p.number, points: p.fig.points })),
    [cogoPlots]
  );
  const usedBeacons = useMemo<GpBeacon[]>(
    () =>
      dedupePoints(gpPlots)
        .filter((p): p is { name: string; east: number; north: number } => !!p.name)
        .map((p) => ({ id: p.name, east: p.east, north: p.north })),
    [gpPlots]
  );

  const savedGp = (generalPlanInput ?? null) as Partial<{
    name: string; location: string; surveyor: string; gpNo: string; scale: number;
    gcNo: string; dsmNo: string; srNo: string; surveyedIn: string;
    beaconDescription: string; pedWay: string; splayEntries: { corner: string; distance: string }[];
    parentCadastre: string; roadLabels: ManualText[]; boundaryLabels: ManualText[]; dismissedAutoIds: string[];
  }> | null;
  const [meta, setMeta] = useState({
    name: config.name && config.name !== "Untitled Survey" ? config.name.toUpperCase() : "TOWNSHIP LAYOUT",
    location: "",
    surveyor: config.surveyor ? config.surveyor.toUpperCase() : "",
    gpNo: "",
    scale: 2000,
    gcNo: "",       // "GC-122" compilation/grid code, small red text top-right
    dsmNo: "",      // "DSM No: 1244/2026"
    srNo: "",       // "SR No: 966/2026", bottom-right of the sheet
    surveyedIn: "", // "Surveyed in February 2026"
    beaconDescription: "ALL: 12MM IRON PEG",
    pedWay: "All: 3m",
    // Per-corner splay distances, e.g. "A,B,B2,B3" -> "5m", with a default
    // fallback row ("All Others" -> "3m") — client req 2026-08-27, §2e.
    splayEntries: [{ corner: "All Others", distance: "3m" }] as { corner: string; distance: string }[],
    // The undivided lot these plots were subdivided from, e.g. "243" — feeds
    // the auto-suggested "REMAINDER OF CADASTRE 243" boundary labels below.
    parentCadastre: "",
    // Manually-placed road-width labels ("ROAD 15m" etc.) — client req
    // 2026-08-27, spec Part 4. Free text anchored in real east/north so it
    // stays put across pan/zoom/rescale, same as Diagrams' manual notes.
    roadLabels: [] as ManualText[],
    // Boundary labels — both user-placed and user-EDITED auto-suggestions
    // (an edited auto-suggestion is persisted here under its own auto- id so
    // the live auto-detection below doesn't also render its own copy).
    boundaryLabels: [] as ManualText[],
    // ids of auto-suggested boundary labels the user has explicitly removed
    // — the suggestion is recomputed from geometry every render, so without
    // this it would just reappear right after being deleted.
    dismissedAutoIds: [] as string[],
    ...(savedGp ?? {}),
  });
  const set = (k: keyof typeof meta) => (v: string) => setMeta((m) => ({ ...m, [k]: k === "scale" ? Number(v) || 0 : v }));
  const setSplayEntry = (i: number, patch: Partial<{ corner: string; distance: string }>) =>
    setMeta((m) => ({ ...m, splayEntries: m.splayEntries.map((e, j) => (j === i ? { ...e, ...patch } : e)) }));
  const addSplayEntry = () => setMeta((m) => ({ ...m, splayEntries: [...m.splayEntries, { corner: "", distance: "" }] }));
  const removeSplayEntry = (i: number) => setMeta((m) => ({ ...m, splayEntries: m.splayEntries.filter((_, j) => j !== i) }));

  // Persist the General Plan title-block (G.P. No., scale, etc.) with the project.
  useEffect(() => {
    setGeneralPlanInput(meta);
  }, [meta, setGeneralPlanInput]);

  // Pagination: layout sheet(s) first, then coordinate-schedule continuation
  // sheets. Large layouts split across multiple numbered layout sheets
  // (client req 2026-08-27, §2d/Part 4 "multi-sheet splitting") — a fixed
  // per-sheet plot cap rather than a true geographic split (the app has no
  // notion of a physical cut line through the drawing), each sheet
  // independently fitted/scaled to its own subset of plots.
  const PLOTS_PER_SHEET = 40;
  const sortedPlots = useMemo(
    () => [...cogoPlots].sort((a, b) => comparePointNames(a.number, b.number)),
    [cogoPlots]
  );
  const layoutGroups = useMemo(() => {
    if (!sortedPlots.length) return [[] as typeof sortedPlots];
    const groups: (typeof sortedPlots)[] = [];
    for (let i = 0; i < sortedPlots.length; i += PLOTS_PER_SHEET) groups.push(sortedPlots.slice(i, i + PLOTS_PER_SHEET));
    return groups;
  }, [sortedPlots]);
  const layoutSheetCount = layoutGroups.length;

  const coordChunks = useMemo(() => {
    const chunks: GpBeacon[][] = [];
    for (let i = 0; i < usedBeacons.length; i += COORDS_PER_SHEET) chunks.push(usedBeacons.slice(i, i + COORDS_PER_SHEET));
    return chunks;
  }, [usedBeacons]);
  const sheetCount = layoutSheetCount + Math.max(coordChunks.length, 0);

  // ---- figure transform, shared geometry constants ----
  // (client req 2026-08-27: General Plan must always show the template itself,
  // with no gating screen — this renders a blank sheet with an empty
  // layout/schedule until at least one plot has been numbered in COGO.)
  // FY1 pulled up from H-30 to H-150 (client req 2026-08-27, §2h) — frees a
  // strip along the bottom of the first sheet for the outer-boundary
  // traverse table + total area, matching the reference sheet's bottom band.
  const FX0 = 30, FY0 = 90, FX1 = 660, FY1 = H - 150;
  const pad = 30;
  /** Fit-to-box transform for one sheet's own subset of beacons — each
   *  layout sheet is scaled independently to its own plots (client req
   *  2026-08-27: real geographic alignment across sheets isn't available
   *  without a cut-line concept, so each sheet is instead kept legible on
   *  its own, same as the reference's per-sheet layout). */
  function computeTransform(beacons: GpBeacon[]) {
    const xs = beacons.map((b) => b.east);
    const ys = beacons.map((b) => b.north);
    const minX = xs.length ? Math.min(...xs) : 0, maxX = xs.length ? Math.max(...xs) : 0;
    const minY = ys.length ? Math.min(...ys) : 0, maxY = ys.length ? Math.max(...ys) : 0;
    const spanX = maxX - minX || 1, spanY = maxY - minY || 1;
    const s = Math.min((FX1 - FX0 - 2 * pad) / spanX, (FY1 - FY0 - 2 * pad) / spanY);
    const ox = FX0 + ((FX1 - FX0) - s * spanX) / 2;
    const oyOff = ((FY1 - FY0) - s * spanY) / 2;
    const sx = (e: number) => ox + (e - minX) * s;
    const sy = (n: number) => FY1 - oyOff - (n - minY) * s;
    // Inverse of sx/sy — screen (viewBox) point back to real east/north, for
    // placing/dragging labels the same way the boundary itself is fixed to
    // real survey coordinates rather than raw pixels (client req 2026-08-27,
    // same reasoning as Diagrams.tsx's `transformRef`).
    const screenToWorld = (px: number, py: number) => ({ east: (px - ox) / s + minX, north: minY + (FY1 - oyOff - py) / s });
    const bounds = { minX, maxX, minY, maxY };
    return { sx, sy, screenToWorld, bounds };
  }
  /** Sheet currently on screen, clamped to a valid layout-sheet index —
   *  drives which sheet's own transform the interaction handlers (click to
   *  place/edit a label) use, since only one sheet is visible at a time. */
  const activeGroupIdx = Math.min(sheet, layoutSheetCount - 1);
  const activeUsedBeacons = useMemo<GpBeacon[]>(
    () =>
      dedupePoints(layoutGroups[activeGroupIdx].map((p) => ({ number: p.number, points: p.fig.points })))
        .filter((p): p is { name: string; east: number; north: number } => !!p.name)
        .map((p) => ({ id: p.name, east: p.east, north: p.north })),
    [layoutGroups, activeGroupIdx]
  );
  const { sx, sy, screenToWorld } = computeTransform(activeUsedBeacons);

  const grandTotalHa = cogoPlots.reduce((a, p) => a + (p.fig.area_ha || 0), 0);

  // ===================== Road-width / boundary-label annotation tool ======
  // Plain click-to-place free text (spec Part 4), reusing SgDiagram's
  // ManualText type/pattern rather than inventing a new one.
  const [addingRoadLabel, setAddingRoadLabel] = useState(false);
  const [selectedLabel, setSelectedLabel] = useState<{ id: string; kind: "road" | "boundary" } | null>(null);
  const [textPrompt, setTextPrompt] = useState<{ id: string | null; kind: "road" | "boundary"; x: number; y: number; value: string; angle: number } | null>(null);
  const [draggingLabel, setDraggingLabel] = useState<{ id: string; kind: "road" | "boundary" } | null>(null);
  const dragMovedRef = useRef(false);

  useEffect(() => {
    if (!textPrompt && !addingRoadLabel) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setTextPrompt(null);
      setAddingRoadLabel(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [textPrompt, addingRoadLabel]);

  function toSvgPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const svg = refs.current[activeGroupIdx];
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }
  function handleCanvasClick(e: ReactMouseEvent<SVGSVGElement>) {
    if (addingRoadLabel) {
      const p = toSvgPoint(e);
      setTextPrompt({ id: null, kind: "road", x: p.x, y: p.y, value: "", angle: 0 });
      setAddingRoadLabel(false);
      return;
    }
    setSelectedLabel(null);
  }
  function labelArray(kind: "road" | "boundary") {
    return kind === "road" ? meta.roadLabels : meta.boundaryLabels;
  }
  function setLabelArray(kind: "road" | "boundary", next: ManualText[]) {
    setMeta((m) => (kind === "road" ? { ...m, roadLabels: next } : { ...m, boundaryLabels: next }));
  }
  function handleLabelClick(id: string, kind: "road" | "boundary") {
    if (dragMovedRef.current) {
      dragMovedRef.current = false; // swallow the click that trails a drag
      return;
    }
    setSelectedLabel((cur) => (cur?.id === id && cur.kind === kind ? null : { id, kind }));
  }
  function handleLabelDoubleClick(id: string, kind: "road" | "boundary", tt: ManualText) {
    const p = { x: sx(tt.east), y: sy(tt.north) };
    setTextPrompt({ id, kind, x: p.x, y: p.y, value: tt.text, angle: tt.angle ?? 0 });
  }
  function handleLabelPointerDown(id: string, kind: "road" | "boundary", e: ReactPointerEvent<SVGElement>) {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDraggingLabel({ id, kind });
    setSelectedLabel({ id, kind });
  }
  function handleLabelPointerMove(id: string, kind: "road" | "boundary", e: ReactPointerEvent<SVGElement>) {
    if (!draggingLabel || draggingLabel.id !== id || draggingLabel.kind !== kind) return;
    dragMovedRef.current = true;
    const p = toSvgPoint(e);
    const w = screenToWorld(p.x, p.y);
    setLabelArray(kind, labelArray(kind).map((tt) => (tt.id === id ? { ...tt, east: w.east, north: w.north } : tt)));
  }
  function handleLabelPointerUp() {
    setDraggingLabel(null);
  }
  function commitTextPrompt() {
    if (!textPrompt) return;
    const value = textPrompt.value.trim();
    if (value) {
      const w = screenToWorld(textPrompt.x, textPrompt.y);
      const angle = textPrompt.angle || undefined;
      if (textPrompt.id) {
        const existing = labelArray(textPrompt.kind);
        const already = existing.some((tt) => tt.id === textPrompt.id);
        setLabelArray(
          textPrompt.kind,
          already
            ? existing.map((tt) => (tt.id === textPrompt.id ? { ...tt, text: value, angle } : tt))
            : [...existing, { id: textPrompt.id, east: w.east, north: w.north, text: value, angle }]
        );
      } else {
        setLabelArray(textPrompt.kind, [...labelArray(textPrompt.kind), { id: `${textPrompt.kind}-${Date.now()}`, east: w.east, north: w.north, text: value, angle }]);
      }
    }
    setTextPrompt(null);
  }
  function deleteSelectedLabel() {
    if (!selectedLabel) return;
    if (selectedLabel.kind === "boundary" && selectedLabel.id.startsWith("auto-remainder-") && !meta.boundaryLabels.some((tt) => tt.id === selectedLabel.id)) {
      // An un-edited auto-suggestion isn't actually stored — remember that
      // it was dismissed instead, or the live detection below just re-adds it.
      setMeta((m) => ({ ...m, dismissedAutoIds: [...m.dismissedAutoIds, selectedLabel.id] }));
    } else {
      setLabelArray(selectedLabel.kind, labelArray(selectedLabel.kind).filter((tt) => tt.id !== selectedLabel.id));
    }
    setSelectedLabel(null);
  }

  // Auto-suggested "REMAINDER OF CADASTRE N" labels (spec Part 4): every
  // plot edge with no matching edge on any other plot in gpPlots — i.e. the
  // outer boundary of the whole layout — gets a suggested label at its
  // midpoint, unless the user already placed/edited one there (same id) or
  // explicitly dismissed it. Same shared-edge detection as Diagrams.tsx's
  // Part 37 auto-adjacency (`sameWorldPoint`, promoted to lib/plots.ts),
  // just inverted: there it labels a MATCHED edge with the neighbour's
  // number, here it labels an UNMATCHED edge with the parent cadastre.
  const autoBoundaryLabels = useMemo<ManualText[]>(() => {
    const out: ManualText[] = [];
    for (let pi = 0; pi < gpPlots.length; pi++) {
      const plot = gpPlots[pi];
      const pts = plot.points;
      if (pts.length < 3) continue;
      const cE = pts.reduce((a, p) => a + p.east, 0) / pts.length;
      const cN = pts.reduce((a, p) => a + p.north, 0) / pts.length;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const matched = gpPlots.some((other, oi) => {
          if (oi === pi) return false;
          return other.points.some((oa, j) => {
            const ob = other.points[(j + 1) % other.points.length];
            return (sameWorldPoint(a, oa) && sameWorldPoint(b, ob)) || (sameWorldPoint(a, ob) && sameWorldPoint(b, oa));
          });
        });
        if (matched) continue;
        const id = `auto-remainder-${plot.number}-${i}`;
        if (meta.dismissedAutoIds.includes(id) || meta.boundaryLabels.some((tt) => tt.id === id)) continue;
        const mE = (a.east + b.east) / 2, mN = (a.north + b.north) / 2;
        const dE = b.east - a.east, dN = b.north - a.north;
        const segLen = Math.hypot(dE, dN) || 1;
        let pE = -dN / segLen, pN = dE / segLen;
        if (pE * (mE - cE) + pN * (mN - cN) < 0) { pE = -pE; pN = -pN; }
        const stub = Math.min(20, Math.max(4, segLen * 0.15));
        out.push({ id, east: mE + pE * stub, north: mN + pN * stub, text: `REMAINDER OF CADASTRE ${meta.parentCadastre || "—"}` });
      }
    }
    return out;
  }, [gpPlots, meta.dismissedAutoIds, meta.boundaryLabels, meta.parentCadastre]);
  const displayBoundaryLabels = useMemo(() => [...meta.boundaryLabels, ...autoBoundaryLabels], [meta.boundaryLabels, autoBoundaryLabels]);

  // Block corners (client req 2026-08-27, §2g) — points where 3+ distinct
  // plots' boundaries converge (see findBlockCorners' own comment for why
  // that's the only usable signal without a Road/Block entity in the data
  // model). Labelled BC1, BC2… by discovery order (stable across renders
  // since gpPlots' own order is stable).
  const blockCorners = useMemo(() => findBlockCorners(gpPlots), [gpPlots]);

  // Bottom traverse table (client req 2026-08-27, §2h) — Sides/Directions/
  // Co-ordinates for the OUTER boundary of the whole layout (every plot
  // edge with no matching neighbour, chained into one ring), same source
  // edges as the REMAINDER OF CADASTRE auto-labels above. Bearing/distance
  // computed with the same `inverse()` the rest of the app's COGO math uses,
  // not re-derived — only the table's own compact GP-sheet formatting is
  // new (computeDiagramLayout's table is a full portrait A4 sheet in a
  // different coordinate space, not something this landscape sheet's bottom
  // strip can just embed).
  const outerBoundary = useMemo(() => findOuterBoundary(gpPlots), [gpPlots]);
  const outerSides = useMemo(
    () =>
      outerBoundary.map((p, i) => {
        const next = outerBoundary[(i + 1) % outerBoundary.length];
        const [bearing, distance] = inverse(p, next);
        return { point: p.name ?? "—", east: p.east, north: p.north, bearing: formatDms(bearing), distance };
      }),
    [outerBoundary]
  );

  function serialize(svg: SVGSVGElement | null): string | null {
    if (!svg) return null;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return new XMLSerializer().serializeToString(clone);
  }
  function download() {
    const svg = serialize(refs.current[sheet]);
    if (!svg) return;
    const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svg}`], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sheetMode}-plan-${(meta.name || "layout").replace(/\s+/g, "_")}-sheet${sheet + 1}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }
  // DXF export for the currently-viewed layout sheet (spec Part 7, "once the
  // SVG renderer is settled") — same pattern as Diagrams.tsx's own
  // downloadDxf(): walk this sheet's real geometry through screenToWorld
  // rather than re-deriving layout, using the SAME sx/sy/screenToWorld
  // already computed above for the active sheet. Scoped to the survey
  // content a DXF is actually needed for (boundary, beacons, road/boundary
  // labels, title/registration text) — not the Lot Numbers/Block Corner
  // tables, which are schedule data the app's own print/PDF output already
  // covers, same scoping call as WorkingPlanView.tsx's own DXF export.
  function downloadDxf() {
    if (sheet >= layoutSheetCount) return; // only layout sheets, not the coordinate schedule
    const metresPerUnit = (() => {
      const a = screenToWorld(0, 0), b = screenToWorld(1, 0);
      return Math.hypot(b.east - a.east, b.north - a.north) || 1;
    })();
    const notes: ImportedDrawing["texts"] = [];
    const polylines: ImportedDrawing["polylines"] = [];
    const beaconPoints: ImportedDrawing["points"] = [];

    function text(x: number, y: number, s: string, heightUnits: number, anchor?: "middle" | "end") {
      if (!s) return;
      const p = screenToWorld(x, y);
      notes.push({ x: p.east, y: p.north, text: s, height: heightUnits * metresPerUnit, layer: "SHEET", anchor });
    }

    text(W / 2, 34, `${sheetMode === "working" ? "WORKING" : "GENERAL"} PLAN OF ${meta.name}`, 19, "middle");
    text(W / 2, 54, `Layout of ${layoutGroups[activeGroupIdx].length} parcel(s)${meta.location ? ` — ${meta.location}` : ""}`, 11, "middle");
    text(regX + regW, 15, `GC-${meta.gcNo || "—"}`, 9, "end");
    text(regX + 6, 48, `G.P. No: ${meta.gpNo || "—"}`, 8);
    text(regX + 6, 60, `DSM No: ${meta.dsmNo || "—"}`, 8);
    text(regX + 6, 120, `Surveyed in ${meta.surveyedIn || "—"}`, 8);
    text(regX + 6, 132, meta.surveyor || "—", 8);
    text(W - 20, H - 16, `SR No: ${meta.srNo || "—"}`, 9, "end");

    const groupGpPlots: Plot[] = layoutGroups[activeGroupIdx].map((p) => ({ number: p.number, points: p.fig.points }));
    for (const p of groupGpPlots) {
      if (p.points.length < 2) continue;
      polylines.push({ pts: p.points.map((pp) => ({ x: pp.east, y: pp.north })), closed: p.points.length >= 3, layer: "BOUNDARY" });
    }
    for (const b of activeUsedBeacons) {
      beaconPoints.push({ x: b.east, y: b.north, label: b.id, layer: "BEACONS" });
    }
    const bounds = computeTransform(activeUsedBeacons).bounds;
    const inBounds = (tt: ManualText) =>
      tt.east >= bounds.minX - 1 && tt.east <= bounds.maxX + 1 && tt.north >= bounds.minY - 1 && tt.north <= bounds.maxY + 1;
    for (const tt of meta.roadLabels.filter(inBounds)) {
      notes.push({ x: tt.east, y: tt.north, text: tt.text, height: 8.5 * metresPerUnit, layer: "ROADS" });
    }
    for (const tt of displayBoundaryLabels.filter(inBounds)) {
      notes.push({ x: tt.east, y: tt.north, text: tt.text, height: 7.5 * metresPerUnit, layer: "BOUNDARY_LABELS" });
    }

    const drawing: ImportedDrawing = { points: beaconPoints, polylines, texts: notes };
    const dxf = writeDxf(drawing);
    const blob = new Blob([dxf], { type: "application/dxf" });
    const url = URL.createObjectURL(blob);
    const a2 = document.createElement("a");
    a2.href = url;
    a2.download = `${sheetMode}-plan-${(meta.name || "layout").replace(/\s+/g, "_")}-sheet${sheet + 1}.dxf`;
    a2.click();
    URL.revokeObjectURL(url);
  }
  function printAll() {
    const all: string[] = [];
    for (let i = 0; i < sheetCount; i++) {
      const svg = serialize(refs.current[i]);
      if (svg) all.push(`<div style="page-break-after:always">${svg}</div>`);
    }
    const w = window.open("", "_blank", "width=1200,height=850");
    if (!w) {
      alert("Pop-up blocked. Please allow pop-ups for this site in your browser, then click Print again.");
      return;
    }
    w.document.write(
      `<html><head><title>${sheetMode === "working" ? "Working" : "General"} Plan — ${meta.name}</title>` +
        `<style>@page{size:landscape}body{margin:0}svg{width:100%;height:auto}</style></head>` +
        `<body onload="window.print()">${all.join("")}</body></html>`
    );
    w.document.close();
  }

  // Top-right registration block (client req 2026-08-27, matching the GC-122
  // reference sheet exactly): GC-No, SHEET No, G.P./DSM No, a real
  // Approved/Director-of-Surveys signature block, and Surveyed-in/surveyor
  // details — replaces the old bare "Sheet N of M" caption and the informal
  // Approved box that used to sit at the bottom of the parcel-schedule panel.
  const regX = 796, regW = 190;

  // Right-side reference panel (client req 2026-08-27, §2e): Sheet Index,
  // Beacon Description, Splay Information, Ped Way — sits between the
  // registration block above (ends y=146) and the parcel schedule below.
  // Sheet Index is a single trivial entry for now (real multi-sheet splitting
  // is a later phase); the numeric lot range is derived straight from the
  // numbered COGO plots when their numbers are numeric.
  const panelX = 690, panelTop = 150;
  // One line per LAYOUT sheet (client req 2026-08-27, multi-sheet split) —
  // shown identically on every sheet so a reader can find any lot's sheet
  // from any page, matching the reference's own Sheet Index panel.
  const sheetIndexLines = layoutGroups.map((g, i) => {
    if (!g.length) return `SHEET ${i + 1}: 0 plot(s)`;
    const nums = g.map((p) => Number(p.number)).filter((n) => Number.isFinite(n));
    if (!nums.length) return `SHEET ${i + 1}: ${g.length} plot(s)`;
    return `SHEET ${i + 1}: Lots ${Math.min(...nums)}-${Math.max(...nums)}`;
  });
  const panelRows: { text: string; heading?: boolean }[] = [
    { text: "SHEET INDEX", heading: true },
    ...sheetIndexLines.map((text) => ({ text })),
    { text: "BEACON DESCRIPTION", heading: true },
    { text: meta.beaconDescription || "—" },
    { text: "SPLAY INFORMATION", heading: true },
    ...meta.splayEntries
      .filter((e) => e.corner.trim() || e.distance.trim())
      .map((e) => ({ text: `${e.corner || "—"}: ${e.distance || "—"}` })),
    { text: "PED WAY", heading: true },
    { text: meta.pedWay || "—" },
  ];
  const panelYs: number[] = [];
  {
    let y = panelTop;
    panelRows.forEach((row, i) => {
      if (row.heading && i > 0) y += 6;
      panelYs.push(y);
      y += row.heading ? 14 : 12;
    });
  }
  const panelBottom = panelYs.length ? panelYs[panelYs.length - 1] + 12 : panelTop;

  // Lot Numbers / Areas table (client req 2026-08-27, §2f): two side-by-side
  // "LOT NUMBERS | SQ. METRES" column-pairs (matching the reference sheet),
  // sorted by lot number (via the shared `sortedPlots` computed above,
  // sliced per sheet by `layoutGroups`), replacing the old single-column
  // capped schedule — fitting roughly twice as many rows in the same space.
  const lotTableTop = panelBottom + 16;
  const lotRowH = 14;
  // Row cap is computed from actual remaining room (not fixed) — the
  // reference panel above can grow (more splay entries, etc.) and push this
  // down, so a fixed cap could otherwise run the table off the bottom of the
  // sheet. Reserves room below for the TOTAL line, and for the Block Corner
  // Table only when there actually is one (no point shrinking the lot table
  // to make room for a section that won't render).
  const bcReserve = blockCorners.length > 0 ? 70 + blockCorners.length * 13 : 30;
  const rowsPerCol = Math.max(1, Math.floor((H - 20 - bcReserve - (lotTableTop + 34)) / lotRowH) + 1);
  const maxLotRows = rowsPerCol * 2;
  const colAx = 690, colBx = 835, sqmOffset = 65;
  const lotPairHeader = (x: number, y: number) => (
    <>
      <text x={x} y={y} fontSize={9.5} fontWeight={700} fill="#475569">LOT No.</text>
      <text x={x + sqmOffset} y={y} fontSize={9.5} fontWeight={700} fill="#475569">SQ. METRES</text>
    </>
  );
  const titleBlock = (no: number, label: string) => (
    <>
      <rect x={6} y={6} width={W - 12} height={H - 12} fill="none" stroke="#0f172a" strokeWidth={1.5} />
      <text x={W / 2} y={34} textAnchor="middle" fontSize={19} fontWeight={700} fill="#0f172a">{sheetMode === "working" ? "WORKING PLAN OF" : "GENERAL PLAN OF"} {meta.name}</text>
      <text x={W / 2} y={54} textAnchor="middle" fontSize={11} fill="#334155">{label}{meta.location ? ` — ${meta.location}` : ""}</text>

      <text x={regX + regW} y={15} textAnchor="end" fontSize={9} fontWeight={700} fill="#dc2626">GC-{meta.gcNo || "—"}</text>
      <rect x={regX} y={20} width={regW} height={126} fill="none" stroke="#0f172a" strokeWidth={0.6} />
      <text x={regX + regW / 2} y={32} textAnchor="middle" fontSize={9} fontWeight={700}>SHEET No - {no} of {sheetCount}</text>
      <line x1={regX} y1={37} x2={regX + regW} y2={37} stroke="#0f172a" strokeWidth={0.4} />
      <text x={regX + 6} y={48} fontSize={8} fill="#334155">G.P. No: {meta.gpNo || "—"}</text>
      <text x={regX + 6} y={60} fontSize={8} fill="#334155">DSM No: {meta.dsmNo || "—"}</text>
      <text x={regX + regW / 2} y={72} textAnchor="middle" fontSize={8.5}>Approved</text>
      <line x1={regX + 16} y1={90} x2={regX + regW - 14} y2={90} stroke="#0f172a" strokeWidth={0.4} />
      <text x={regX + regW / 2} y={100} textAnchor="middle" fontSize={7.5} fill="#334155">Director of Surveys and Mapping</text>
      <line x1={regX} y1={108} x2={regX + regW} y2={108} stroke="#0f172a" strokeWidth={0.4} />
      <text x={regX + 6} y={120} fontSize={8} fill="#334155">Surveyed in {meta.surveyedIn || "—"}</text>
      <text x={regX + 6} y={132} fontSize={8} fontWeight={600} fill="#0f172a">{meta.surveyor || "—"}</text>
      <text x={regX + regW - 6} y={132} textAnchor="end" fontSize={7} fill="#64748b">By me · Land Surveyor</text>

      <text x={W - 20} y={H - 16} textAnchor="end" fontSize={9} fill="#64748b">SR No: {meta.srNo || "—"}</text>
    </>
  );

  // Sheet renderer — one call per layout-sheet group (client req 2026-08-27,
  // multi-sheet split). Each group computes its own transform/gpPlots/
  // beacons/blockCorners from just its own plots; the reference panel and
  // Sheet Index are identical on every sheet; the outer-boundary traverse
  // table + grand total (whole-layout concepts) render only on sheet 1.
  function renderLayoutSheet(groupIdx: number) {
    const groupPlots = layoutGroups[groupIdx];
    const groupGpPlots: Plot[] = groupPlots.map((p) => ({ number: p.number, points: p.fig.points }));
    const groupUsedBeacons: GpBeacon[] = dedupePoints(groupGpPlots)
      .filter((p): p is { name: string; east: number; north: number } => !!p.name)
      .map((p) => ({ id: p.name, east: p.east, north: p.north }));
    const t = computeTransform(groupUsedBeacons);
    const groupSchedule = groupPlots.map((p, i) => ({ p, i }));
    const groupSortedPlots = groupPlots; // layoutGroups are already slices of sortedPlots
    const groupTotalHa = groupPlots.reduce((a, p) => a + (p.fig.area_ha || 0), 0);
    const groupBlockCorners = blockCorners.filter(
      (bc) => bc.east >= t.bounds.minX - 0.01 && bc.east <= t.bounds.maxX + 0.01 && bc.north >= t.bounds.minY - 0.01 && bc.north <= t.bounds.maxY + 0.01
    );
    const isFirstSheet = groupIdx === 0;
    // Only labels anchored within this sheet's own drawing bounds — a label
    // placed on a different sheet's own bounding box would otherwise project
    // to a nonsense position (or off-sheet) on this one.
    const inBounds = (tt: ManualText) =>
      tt.east >= t.bounds.minX - 1 && tt.east <= t.bounds.maxX + 1 && tt.north >= t.bounds.minY - 1 && tt.north <= t.bounds.maxY + 1;
    const sheetRoadLabels = meta.roadLabels.filter(inBounds);
    const sheetBoundaryLabels = displayBoundaryLabels.filter(inBounds);

    return (
      <svg
        key={groupIdx}
        ref={(el) => { refs.current[groupIdx] = el; }}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full bg-white"
        style={{ border: "1px solid #cbd5e1", cursor: addingRoadLabel ? "crosshair" : "default" }}
        onClick={handleCanvasClick}
      >
        {titleBlock(groupIdx + 1, `Layout of ${groupPlots.length} parcel(s)`)}
        {/* north arrow */}
        <g transform={`translate(${FX1 - 20},${FY0 + 16})`}>
          <line x1={0} y1={12} x2={0} y2={-10} stroke="#0f172a" strokeWidth={1.5} />
          <polygon points="0,-14 -5,-5 5,-5" fill="#0f172a" />
          <text x={0} y={26} textAnchor="middle" fontSize={10} fill="#0f172a">N</text>
        </g>
        {/* parcels */}
        {groupSchedule.map(({ p, i }) => {
          const pts = p.fig.points;
          if (pts.length < 3) return null;
          const d = pts.map((pp) => `${t.sx(pp.east)},${t.sy(pp.north)}`).join(" ");
          const cx = pts.reduce((a, pp) => a + t.sx(pp.east), 0) / pts.length;
          const cy = pts.reduce((a, pp) => a + t.sy(pp.north), 0) / pts.length;
          const col = PALETTE[i % PALETTE.length];
          return (
            <g key={p.number}>
              <polygon points={d} fill={col} fillOpacity={0.13} stroke={col} strokeWidth={1.4} />
              <text x={cx} y={cy} textAnchor="middle" fontSize={10} fontWeight={700} fill={col}>{p.number}</text>
            </g>
          );
        })}
        {groupUsedBeacons.map((b) => (
          <g key={b.id}>
            <circle cx={t.sx(b.east)} cy={t.sy(b.north)} r={2.6} fill="#0f172a" />
            <text x={t.sx(b.east) + 4} y={t.sy(b.north) - 3} fontSize={8} fill="#334155">{b.id}</text>
          </g>
        ))}
        {groupUsedBeacons.length === 0 && (
          <text x={(FX0 + FX1) / 2} y={(FY0 + FY1) / 2} textAnchor="middle" fontSize={11} fill="#cbd5e1">No plots numbered in COGO yet</text>
        )}
        {/* Road-width labels + REMAINDER OF CADASTRE boundary labels */}
        {sheetRoadLabels.map((tt) => (
          <text
            key={tt.id}
            x={t.sx(tt.east)}
            y={t.sy(tt.north)}
            textAnchor="middle"
            fontSize={8.5}
            fontWeight={600}
            fill={selectedLabel?.id === tt.id && selectedLabel.kind === "road" ? "#2563eb" : "#0f172a"}
            transform={tt.angle ? `rotate(${tt.angle} ${t.sx(tt.east)} ${t.sy(tt.north)})` : undefined}
            style={{ cursor: "move" }}
            onClick={(e) => { e.stopPropagation(); handleLabelClick(tt.id, "road"); }}
            onDoubleClick={(e) => { e.stopPropagation(); handleLabelDoubleClick(tt.id, "road", tt); }}
            onPointerDown={(e) => handleLabelPointerDown(tt.id, "road", e)}
            onPointerMove={(e) => handleLabelPointerMove(tt.id, "road", e)}
            onPointerUp={handleLabelPointerUp}
          >
            {tt.text}
          </text>
        ))}
        {sheetBoundaryLabels.map((tt) => (
          <text
            key={tt.id}
            x={t.sx(tt.east)}
            y={t.sy(tt.north)}
            textAnchor="middle"
            fontSize={7.5}
            fontStyle="italic"
            fill={selectedLabel?.id === tt.id && selectedLabel.kind === "boundary" ? "#2563eb" : "#64748b"}
            transform={tt.angle ? `rotate(${tt.angle} ${t.sx(tt.east)} ${t.sy(tt.north)})` : undefined}
            style={{ cursor: "move" }}
            onClick={(e) => { e.stopPropagation(); handleLabelClick(tt.id, "boundary"); }}
            onDoubleClick={(e) => { e.stopPropagation(); handleLabelDoubleClick(tt.id, "boundary", tt); }}
            onPointerDown={(e) => handleLabelPointerDown(tt.id, "boundary", e)}
            onPointerMove={(e) => handleLabelPointerMove(tt.id, "boundary", e)}
            onPointerUp={handleLabelPointerUp}
          >
            {tt.text}
          </text>
        ))}
        <text x={(FX0 + FX1) / 2} y={FY1 + 14} textAnchor="middle" fontSize={11} fontWeight={700}>SCALE 1:{meta.scale.toLocaleString()}</text>
        {/* Sheet Index / Beacon Description / Splay Information / Ped Way — same on every sheet */}
        {panelRows.map((row, i) => (
          <text
            key={i}
            x={panelX}
            y={panelYs[i]}
            fontSize={row.heading ? 10 : 8}
            fontWeight={row.heading ? 700 : 400}
            fill={row.heading ? "#0f172a" : "#334155"}
          >
            {row.text}
          </text>
        ))}
        {sheetMode === "general" ? (
          <>
            {/* Lot Numbers / Areas table (client req 2026-08-27, §2f) — this
                sheet's own lots only, two side-by-side "LOT No. | SQ. METRES"
                column-pairs, sorted by lot number. */}
            <text x={690} y={lotTableTop} fontSize={11} fontWeight={700} fill="#0f172a">LOT NUMBERS / AREAS</text>
            {lotPairHeader(colAx, lotTableTop + 16)}
            {lotPairHeader(colBx, lotTableTop + 16)}
            {groupSortedPlots.slice(0, rowsPerCol).map((p, k) => {
              const y = lotTableTop + 30 + k * lotRowH;
              return (
                <g key={p.number}>
                  <text x={colAx} y={y} fontSize={9} fill="#0f172a">{p.number || "(none)"}</text>
                  <text x={colAx + sqmOffset} y={y} fontSize={9} fill="#0f172a">{p.fig.area_m2.toFixed(2)}</text>
                </g>
              );
            })}
            {groupSortedPlots.slice(rowsPerCol, maxLotRows).map((p, k) => {
              const y = lotTableTop + 30 + k * lotRowH;
              return (
                <g key={p.number}>
                  <text x={colBx} y={y} fontSize={9} fill="#0f172a">{p.number || "(none)"}</text>
                  <text x={colBx + sqmOffset} y={y} fontSize={9} fill="#0f172a">{p.fig.area_m2.toFixed(2)}</text>
                </g>
              );
            })}
            <line x1={690} y1={lotTableTop + 30 + rowsPerCol * lotRowH} x2={970} y2={lotTableTop + 30 + rowsPerCol * lotRowH} stroke="#cbd5e1" />
            <text x={690} y={lotTableTop + 30 + rowsPerCol * lotRowH + 16} fontSize={10} fontWeight={700}>
              {layoutSheetCount > 1 ? "SHEET TOTAL" : "TOTAL AREA"} = {groupTotalHa.toFixed(4)} Ha
            </text>
            {groupSortedPlots.length > maxLotRows && (
              <text x={690} y={lotTableTop + 30 + rowsPerCol * lotRowH + 32} fontSize={9} fill="#94a3b8">
                +{groupSortedPlots.length - maxLotRows} more lot(s) on this sheet — see digital schedule
              </text>
            )}
            {/* Block Corner Table (client req 2026-08-27, §2g) — this sheet's
                own corners only; omitted entirely when none qualify, rather
                than printing an empty section. */}
            {groupBlockCorners.length > 0 && (() => {
              const bcTop = lotTableTop + 30 + rowsPerCol * lotRowH + (groupSortedPlots.length > maxLotRows ? 46 : 30);
              return (
                <>
                  <text x={690} y={bcTop} fontSize={11} fontWeight={700} fill="#0f172a">BLOCK CORNER TABLE</text>
                  <text x={690} y={bcTop + 15} fontSize={9} fontWeight={600}>SYSTEM {fmtSystem(config.coordinateSystem)} CO-ORDINATES</text>
                  <text x={690} y={bcTop + 28} fontSize={8} fill="#475569">CONSTANTS &nbsp; Y: +0.00 &nbsp; X: +0.00</text>
                  <text x={690} y={bcTop + 42} fontSize={9} fontWeight={600} fill="#475569">Point</text>
                  <text x={745} y={bcTop + 42} fontSize={9} fontWeight={600} fill="#475569">Y</text>
                  <text x={845} y={bcTop + 42} fontSize={9} fontWeight={600} fill="#475569">X</text>
                  {groupBlockCorners.map((bc, k) => {
                    const y = bcTop + 56 + k * 13;
                    return (
                      <g key={bc.id}>
                        <text x={690} y={y} fontSize={8.5} fill="#0f172a">{bc.id}</text>
                        <text x={745} y={y} fontSize={8.5} fill="#0f172a">{bc.east.toFixed(2)}</text>
                        <text x={845} y={y} fontSize={8.5} fill="#0f172a">{bc.north.toFixed(2)}</text>
                      </g>
                    );
                  })}
                </>
              );
            })()}
            {/* Bottom traverse table (client req 2026-08-27, §2h) — the WHOLE
                layout's outer boundary + grand total, sheet 1 only (it's not
                a per-sheet concept); other sheets point back to it. */}
            {isFirstSheet ? (
              outerSides.length > 0 ? (
                <>
                  <line x1={30} y1={FY1 + 30} x2={970} y2={FY1 + 30} stroke="#0f172a" strokeWidth={0.6} />
                  <text x={30} y={FY1 + 44} fontSize={10} fontWeight={700} fill="#0f172a">OUTER BOUNDARY — SIDES / DIRECTIONS / CO-ORDINATES</text>
                  <text x={30} y={FY1 + 58} fontSize={8.5} fontWeight={600} fill="#475569">Point</text>
                  <text x={110} y={FY1 + 58} fontSize={8.5} fontWeight={600} fill="#475569">Direction</text>
                  <text x={230} y={FY1 + 58} fontSize={8.5} fontWeight={600} fill="#475569">Distance (m)</text>
                  <text x={340} y={FY1 + 58} fontSize={8.5} fontWeight={600} fill="#475569">Y</text>
                  <text x={430} y={FY1 + 58} fontSize={8.5} fontWeight={600} fill="#475569">X</text>
                  {outerSides.slice(0, 8).map((s, k) => {
                    const y = FY1 + 72 + k * 12;
                    return (
                      <g key={k}>
                        <text x={30} y={y} fontSize={8} fill="#0f172a">{s.point}</text>
                        <text x={110} y={y} fontSize={8} fill="#0f172a">{s.bearing}</text>
                        <text x={230} y={y} fontSize={8} fill="#0f172a">{s.distance.toFixed(2)}</text>
                        <text x={340} y={y} fontSize={8} fill="#0f172a">{s.east.toFixed(2)}</text>
                        <text x={430} y={y} fontSize={8} fill="#0f172a">{s.north.toFixed(2)}</text>
                      </g>
                    );
                  })}
                  {outerSides.length > 8 && (
                    <text x={30} y={FY1 + 72 + 8 * 12 + 4} fontSize={8} fill="#94a3b8">+{outerSides.length - 8} more side(s) — see digital record</text>
                  )}
                  <text x={700} y={FY1 + 58} fontSize={12} fontWeight={700} fill="#0f172a">TOTAL AREA = {grandTotalHa.toFixed(4)} Ha</text>
                </>
              ) : (
                cogoPlots.length > 0 && (
                  <text x={30} y={FY1 + 58} fontSize={9} fill="#94a3b8">
                    Outer boundary not traced (plots don&apos;t form one simple connected layout) — TOTAL AREA = {grandTotalHa.toFixed(4)} Ha
                  </text>
                )
              )
            ) : (
              <text x={30} y={FY1 + 58} fontSize={9} fill="#94a3b8">Outer boundary traverse and total area — see Sheet 1.</text>
            )}
          </>
        ) : (() => {
          // ===== Working Plan variant (spec Part 3): no tables — an inset
          // reference-mark sketch + certification box instead, same pattern
          // as WorkingPlan.tsx's own inset/cert boxes (components/WorkingPlan.tsx). =====
          const insetBox = { x: 690, y: lotTableTop, w: 280, h: 140 };
          const insetPad = 20;
          const iSpanE = Math.max(t.bounds.maxX - t.bounds.minX, 1e-6);
          const iSpanN = Math.max(t.bounds.maxY - t.bounds.minY, 1e-6);
          const iFit = Math.min((insetBox.w - 2 * insetPad) / iSpanE, (insetBox.h - 2 * insetPad) / iSpanN);
          const iOffX = insetBox.x + (insetBox.w - iSpanE * iFit) / 2;
          const iOffY = insetBox.y + (insetBox.h - iSpanN * iFit) / 2;
          const iX = (e: number) => iOffX + (e - t.bounds.minX) * iFit;
          const iY = (n: number) => iOffY + (t.bounds.maxY - n) * iFit;
          const insetPolygons = groupSchedule
            .map(({ p }) => p.fig.points)
            .filter((pts) => pts.length >= 2)
            .map((pts) => pts.map((pp) => `${iX(pp.east)},${iY(pp.north)}`).join(" "));
          const refDots = refMarksGp.map((r) => ({
            x: Math.min(insetBox.x + insetBox.w - 8, Math.max(insetBox.x + 8, iX(r.east))),
            y: Math.min(insetBox.y + insetBox.h - 8, Math.max(insetBox.y + 8, iY(r.north))),
            label: r.name || "RM",
          }));
          const cert = { x: 650, y: FY1 + 20, w: 320, h: 90 };
          return (
            <>
              <rect x={insetBox.x} y={insetBox.y} width={insetBox.w} height={insetBox.h} fill="white" stroke="#16a34a" strokeWidth={1.2} />
              <text x={insetBox.x + insetBox.w / 2} y={insetBox.y - 4} textAnchor="middle" fontSize={8.5} fill="#16a34a">INSET NOT TO SCALE</text>
              {insetPolygons.map((poly, i) => (
                <polygon key={i} points={poly} fill="none" stroke="#0f172a" strokeWidth={1} strokeLinejoin="round" />
              ))}
              {refDots.map((d, i) => (
                <g key={i}>
                  <circle cx={d.x} cy={d.y} r={2.2} fill="#dc2626" />
                  <text x={d.x + 5} y={d.y + 3} fontSize={7} fill="#dc2626">{d.label}</text>
                </g>
              ))}
              <rect x={cert.x} y={cert.y} width={cert.w} height={cert.h} fill="none" stroke="#0f172a" strokeWidth={0.7} />
              <text x={cert.x + 10} y={cert.y + 16} fontSize={9} fill="#0f172a">Surveyed by me in accordance with the provisions of THE</text>
              <text x={cert.x + 10} y={cert.y + 30} fontSize={9} fill="#0f172a">LAND SURVEY ACT and the regulations framed thereunder.</text>
              <text x={cert.x + 10} y={cert.y + 52} fontSize={9} fill="#0f172a">DATE: {meta.surveyedIn || "—"}</text>
              <text x={cert.x + 10} y={cert.y + 74} fontSize={9} fill="#0f172a">LAND SURVEYOR: {meta.surveyor || "—"}</text>
            </>
          );
        })()}
      </svg>
    );
  }

  const coordSheet = (chunk: GpBeacon[], idx: number) => {
    // 230 (not the old 300) so a full 3-column sheet's rightmost values stay
    // clear of the registration block at x=796+ — that block now renders on
    // every sheet via the shared titleBlock(), not just the layout sheet.
    const colW = 230;
    const cols = Math.min(3, Math.ceil(chunk.length / 16) || 1);
    const perCol = Math.ceil(chunk.length / cols);
    return (
      <svg key={idx} ref={(el) => { refs.current[layoutSheetCount + idx] = el; }} viewBox={`0 0 ${W} ${H}`} className="w-full bg-white" style={{ border: "1px solid #cbd5e1" }}>
        {titleBlock(layoutSheetCount + idx + 1, "Beacon coordinate schedule")}
        {Array.from({ length: cols }).map((_, c) => {
          const x0 = 30 + c * colW;
          const part = chunk.slice(c * perCol, (c + 1) * perCol);
          return (
            <g key={c}>
              <text x={x0} y={88} fontSize={10} fontWeight={600} fill="#475569">Beacon</text>
              <text x={x0 + 70} y={88} fontSize={10} fontWeight={600} fill="#475569">East (Y)</text>
              <text x={x0 + 150} y={88} fontSize={10} fontWeight={600} fill="#475569">North (X)</text>
              {part.map((b, r) => {
                const y = 104 + r * 13.5;
                return (
                  <g key={b.id}>
                    <text x={x0} y={y} fontSize={9} fill="#0f172a">{b.id}</text>
                    <text x={x0 + 70} y={y} fontSize={9} fill="#0f172a">{b.east.toFixed(2)}</text>
                    <text x={x0 + 150} y={y} fontSize={9} fill="#0f172a">{b.north.toFixed(2)}</text>
                  </g>
                );
              })}
            </g>
          );
        })}
        <text x={30} y={H - 16} fontSize={9} fill="#64748b">System {displayCrs(config.coordinateSystem)}</text>
      </svg>
    );
  };

  return (
    <div className="space-y-4">
      <Card title="General Plan details">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Layout / township name"><Input value={meta.name} onChange={set("name")} /></Field>
          <Field label="Location"><Input value={meta.location} onChange={set("location")} placeholder="e.g. Mogoditshane" /></Field>
          <Field label="Surveyor"><Input value={meta.surveyor} onChange={set("surveyor")} /></Field>
          <Field label="G.P. No."><Input value={meta.gpNo} onChange={set("gpNo")} /></Field>
          <Field label="Scale 1:"><Input type="number" value={meta.scale} onChange={set("scale")} /></Field>
          <Field label="GC No. (compilation code)"><Input value={meta.gcNo} onChange={set("gcNo")} placeholder="e.g. 122" /></Field>
          <Field label="DSM No."><Input value={meta.dsmNo} onChange={set("dsmNo")} placeholder="e.g. 1244/2026" /></Field>
          <Field label="SR No."><Input value={meta.srNo} onChange={set("srNo")} placeholder="e.g. 966/2026" /></Field>
          <Field label="Surveyed in"><Input value={meta.surveyedIn} onChange={set("surveyedIn")} placeholder="e.g. February 2026" /></Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="inline-flex overflow-hidden rounded-lg border border-slate-200">
            <button
              type="button"
              onClick={() => setSheetMode("general")}
              className={`px-3 py-1.5 text-sm font-medium ${sheetMode === "general" ? "bg-brand text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
            >
              General Plan
            </button>
            <button
              type="button"
              onClick={() => setSheetMode("working")}
              className={`px-3 py-1.5 text-sm font-medium ${sheetMode === "working" ? "bg-brand text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
            >
              Working Plan
            </button>
          </span>
          <span className="text-xs text-slate-400">
            {sheetMode === "general"
              ? "Full sheet with Lot Numbers, Block Corner and traverse tables."
              : "Drawing + descriptions only, with an inset sketch and certification box — no tables."}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button onClick={download}>⬇ Download sheet SVG</Button>
          {sheet < layoutSheetCount && <Button variant="ghost" onClick={downloadDxf}>⬇ Download DXF</Button>}
          <Button variant="ghost" onClick={printAll}>Print all sheets / PDF</Button>
          <span className="ml-2 inline-flex items-center gap-2 text-sm">
            <Button variant="ghost" onClick={() => setSheet((x) => Math.max(0, x - 1))} disabled={sheet === 0}>← Prev</Button>
            <span className="text-slate-600">Sheet {sheet + 1} of {sheetCount}</span>
            <Button variant="ghost" onClick={() => setSheet((x) => Math.min(sheetCount - 1, x + 1))} disabled={sheet >= sheetCount - 1}>Next →</Button>
          </span>
        </div>
      </Card>

      <Card title="Sheet reference panel">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Beacon description"><Input value={meta.beaconDescription} onChange={set("beaconDescription")} placeholder="e.g. ALL: 12MM IRON PEG" /></Field>
          <Field label="Ped way"><Input value={meta.pedWay} onChange={set("pedWay")} placeholder="e.g. All: 3m" /></Field>
          <Field label="Parent cadastre (for REMAINDER OF CADASTRE labels)"><Input value={meta.parentCadastre} onChange={set("parentCadastre")} placeholder="e.g. 243" /></Field>
        </div>
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium text-slate-500">Splay information (corner → distance; untick isn't needed, just leave blank rows out)</div>
          <div className="space-y-1.5">
            {meta.splayEntries.map((e, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={e.corner}
                  onChange={(ev) => setSplayEntry(i, { corner: ev.target.value })}
                  placeholder="e.g. A,B,B2,B3 or All Others"
                  className="flex-1 rounded border border-slate-200 px-2 py-1 text-sm"
                />
                <input
                  value={e.distance}
                  onChange={(ev) => setSplayEntry(i, { distance: ev.target.value })}
                  placeholder="e.g. 5m"
                  className="w-24 rounded border border-slate-200 px-2 py-1 text-sm"
                />
                <button
                  type="button"
                  onClick={() => removeSplayEntry(i)}
                  className="text-slate-400 hover:text-red-600"
                  aria-label="Remove splay entry"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <button type="button" onClick={addSplayEntry} className="mt-2 text-xs font-medium text-brand underline">
            + Add corner
          </button>
        </div>
      </Card>

      <Card title={`${sheetMode === "working" ? "Working" : "General"} Plan — Sheet ${sheet + 1}`}>
        {sheet < layoutSheetCount && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Button
              variant={addingRoadLabel ? "primary" : "ghost"}
              onClick={() => {
                setAddingRoadLabel((v) => !v);
                setSelectedLabel(null);
              }}
            >
              {addingRoadLabel ? "Click where it should go…" : "Add Road Label"}
            </Button>
            {selectedLabel && (
              <Button variant="ghost" onClick={deleteSelectedLabel}>✕ Delete selected label</Button>
            )}
            <span className="text-xs text-slate-400">Drag a label to move it; double-click to edit its text.</span>
          </div>
        )}
        {/* Render all sheets (so refs exist for print-all); show only the active one. */}
        <div className="relative mx-auto max-w-5xl">
          {layoutGroups.map((_, idx) => (
            <div key={idx} style={{ display: sheet === idx ? "block" : "none" }}>{renderLayoutSheet(idx)}</div>
          ))}
          {coordChunks.map((chunk, idx) => (
            <div key={idx} style={{ display: sheet === layoutSheetCount + idx ? "block" : "none" }}>{coordSheet(chunk, idx)}</div>
          ))}
          {textPrompt && sheet < layoutSheetCount && (
            <div
              className="absolute z-10 w-56 -translate-x-1/2 rounded-lg border border-slate-200 bg-white p-3 shadow-lg"
              style={{ left: `${(textPrompt.x / W) * 100}%`, top: `${(textPrompt.y / H) * 100}%` }}
            >
              <div className="mb-2 text-xs font-semibold text-brand-dark">{textPrompt.id ? "Edit Label" : "Add Label"}</div>
              <input
                autoFocus
                value={textPrompt.value}
                onChange={(e) => setTextPrompt((tp) => (tp ? { ...tp, value: e.target.value } : tp))}
                onKeyDown={(e) => e.key === "Enter" && commitTextPrompt()}
                placeholder="e.g. ROAD 15m"
                className="mb-2 w-full rounded border border-slate-200 px-2 py-1 text-sm"
              />
              <div className="mb-2 flex items-center gap-2 text-xs text-slate-500">
                Angle
                <input
                  type="number"
                  value={textPrompt.angle}
                  onChange={(e) => setTextPrompt((tp) => (tp ? { ...tp, angle: Number(e.target.value) || 0 } : tp))}
                  className="w-16 rounded border border-slate-200 px-2 py-1 text-sm"
                />
                °
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setTextPrompt(null)}>Cancel</Button>
                <Button onClick={commitTextPrompt}>{textPrompt.id ? "Save" : "Add"}</Button>
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
