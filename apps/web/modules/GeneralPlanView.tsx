"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "@/lib/store";
import { Button, Card, Field, Input } from "@/components/ui";
import { displayCrs } from "@/lib/crsOptions";
import { dedupePoints, findBlockCorners, findOuterBoundary, sameWorldPoint, type Plot } from "@/lib/plots";
import { declutterLabels } from "@/lib/labelLayout";
import { comparePointNames } from "@/lib/reportFormats";
import { fmtSystem, toDotted } from "@/lib/diagramLayout";
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
    roadLabels: ManualText[]; boundaryLabels: ManualText[];
    titleOffset: { dx: number; dy: number; scale?: number };
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
    // Manually-placed road-width labels ("ROAD 15m" etc.) — client req
    // 2026-08-27, spec Part 4. Free text anchored in real east/north so it
    // stays put across pan/zoom/rescale, same as Diagrams' manual notes.
    roadLabels: [] as ManualText[],
    // Boundary labels (e.g. "REMAINDER OF CADASTRE 243") — placed manually
    // only, same Add Text tool as roadLabels (client req 2026-08-28: an
    // earlier auto-suggestion for every unmatched edge produced too much
    // false-positive clutter, since there's no data to tell a road-facing
    // edge apart from an actual remainder-facing one).
    boundaryLabels: [] as ManualText[],
    // Select/move/resize for the title heading (client req 2026-08-28: "ye
    // client khud drag kar ke kahi bi place kar sake ur resize bi kar
    // sake") — same dx/dy/scale-offset pattern as WorkingPlan.tsx's own
    // title-block treatment.
    titleOffset: { dx: 0, dy: 0 } as { dx: number; dy: number; scale?: number },
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
  // Shared display rotation (client req 2026-08-28) — applied AFTER the
  // fit-to-bounds projection below, spinning the drawing around the centre
  // of its own frame, same order/convention as CogoWorkspace.tsx's toScreen.
  // Deliberately screen-space only: every TABLE/DXF value elsewhere in this
  // file (Block Corner Table, outer-boundary traverse, coordinate schedule,
  // DXF export) reads real east/north straight from `cogoPlots`, untouched —
  // only where shapes/labels are DRAWN moves, never the numbers a legal
  // document depends on.
  const rotation = config.displayRotation ?? 0;
  // Horizontal mirror (client req 2026-08-28) — rotation alone can never fix
  // a mirrored shape, so this covers that case too; same shared, persisted,
  // display-only setting CogoWorkspace's Flip button uses.
  const flip = config.displayFlip ?? false;
  const rotPivotX = (FX0 + FX1) / 2, rotPivotY = (FY0 + FY1) / 2;
  const rotRad = (rotation * Math.PI) / 180;
  const cosR = Math.cos(rotRad), sinR = Math.sin(rotRad);
  /** Fit-to-box transform for one sheet's own subset of beacons — each
   *  layout sheet is scaled independently to its own plots (client req
   *  2026-08-27: real geographic alignment across sheets isn't available
   *  without a cut-line concept, so each sheet is instead kept legible on
   *  its own, same as the reference's per-sheet layout). */
  // `rotationOverride`/`flipOverride` let a caller opt OUT of the live
  // display transform — used by DXF export below, which must stay a true
  // north-up, unmirrored drawing (its boundary polylines already read raw
  // east/north; text() must agree, or title/label text would land off
  // relative to a boundary that isn't transformed the same way).
  function computeTransform(beacons: GpBeacon[], rotationOverride: number = rotation, flipOverride: boolean = flip) {
    const xs = beacons.map((b) => b.east);
    const ys = beacons.map((b) => b.north);
    const minX = xs.length ? Math.min(...xs) : 0, maxX = xs.length ? Math.max(...xs) : 0;
    const minY = ys.length ? Math.min(...ys) : 0, maxY = ys.length ? Math.max(...ys) : 0;
    const spanX = maxX - minX || 1, spanY = maxY - minY || 1;
    const s = Math.min((FX1 - FX0 - 2 * pad) / spanX, (FY1 - FY0 - 2 * pad) / spanY);
    const ox = FX0 + ((FX1 - FX0) - s * spanX) / 2;
    const oyOff = ((FY1 - FY0) - s * spanY) / 2;
    // Order matches CogoWorkspace.tsx exactly: fit -> flip (mirror x around
    // the frame's own centre) -> rotate.
    const sx0 = (e: number) => {
      const x = ox + (e - minX) * s;
      return flipOverride ? 2 * rotPivotX - x : x;
    };
    const sy0 = (n: number) => FY1 - oyOff - (n - minY) * s;
    const rRad = (rotationOverride * Math.PI) / 180;
    const cR = Math.cos(rRad), sR = Math.sin(rRad);
    // sx/sy now take BOTH east and north — a rotation couples the two axes,
    // so (unlike the old single-argument versions) neither can be computed
    // from its own coordinate alone once `rotationOverride` is nonzero.
    const sx = (e: number, n: number) => {
      if (!rotationOverride) return sx0(e);
      return rotPivotX + (sx0(e) - rotPivotX) * cR - (sy0(n) - rotPivotY) * sR;
    };
    const sy = (e: number, n: number) => {
      if (!rotationOverride) return sy0(n);
      return rotPivotY + (sx0(e) - rotPivotX) * sR + (sy0(n) - rotPivotY) * cR;
    };
    // Inverse of sx/sy — screen (viewBox) point back to real east/north, for
    // placing/dragging labels the same way the boundary itself is fixed to
    // real survey coordinates rather than raw pixels (client req 2026-08-27,
    // same reasoning as Diagrams.tsx's `transformRef`); un-rotates and
    // un-flips first when either display transform is active.
    const screenToWorld = (px: number, py: number) => {
      let x = px, y = py;
      if (rotationOverride) {
        const dx = px - rotPivotX, dy = py - rotPivotY;
        x = rotPivotX + dx * cR + dy * sR;
        y = rotPivotY - dx * sR + dy * cR;
      }
      if (flipOverride) x = 2 * rotPivotX - x;
      return { east: (x - ox) / s + minX, north: minY + (FY1 - oyOff - y) / s };
    };
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

  // Select/move/resize for the title heading (client req 2026-08-28: "ye
  // client khud drag kar ke kahi bi place kar sake ur resize bi kar sake") —
  // same dx/dy/scale-offset pattern WorkingPlan.tsx already uses for its own
  // title block, tracked here directly since GeneralPlanView draws its
  // title inline rather than through a child component's props.
  const [titleSelected, setTitleSelected] = useState(false);
  const [draggingTitle, setDraggingTitle] = useState<{ startSx: number; startSy: number; origDx: number; origDy: number } | null>(null);
  const titleDragMovedRef = useRef(false);
  function handleTitleClick(e: ReactMouseEvent<SVGElement>) {
    e.stopPropagation();
    if (titleDragMovedRef.current) { titleDragMovedRef.current = false; return; }
    setTitleSelected((s) => !s);
  }
  function handleTitlePointerDown(e: ReactPointerEvent<SVGElement>) {
    if (!titleSelected) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = toSvgPoint(e);
    setDraggingTitle({ startSx: p.x, startSy: p.y, origDx: meta.titleOffset.dx, origDy: meta.titleOffset.dy });
  }
  function handleTitlePointerMove(e: ReactPointerEvent<SVGElement>) {
    if (!draggingTitle) return;
    const p = toSvgPoint(e);
    const dx = p.x - draggingTitle.startSx, dy = p.y - draggingTitle.startSy;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) titleDragMovedRef.current = true;
    setMeta((m) => ({ ...m, titleOffset: { ...m.titleOffset, dx: draggingTitle.origDx + dx, dy: draggingTitle.origDy + dy } }));
  }
  function handleTitlePointerUp() {
    setDraggingTitle(null);
  }
  function cancelTitleDrag() {
    if (!draggingTitle) return;
    setMeta((m) => ({ ...m, titleOffset: { ...m.titleOffset, dx: draggingTitle.origDx, dy: draggingTitle.origDy } }));
    setDraggingTitle(null);
  }
  function handleTitleResize(delta: number) {
    setMeta((m) => ({ ...m, titleOffset: { ...m.titleOffset, scale: Math.max(0.4, Math.min(3, (m.titleOffset.scale ?? 1) + delta)) } }));
  }
  useEffect(() => {
    if (!draggingTitle) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") cancelTitleDrag(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingTitle]);

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
    setTitleSelected(false);
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
    const p = { x: sx(tt.east, tt.north), y: sy(tt.east, tt.north) };
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
    setLabelArray(selectedLabel.kind, labelArray(selectedLabel.kind).filter((tt) => tt.id !== selectedLabel.id));
    setSelectedLabel(null);
  }

  // "REMAINDER OF CADASTRE" boundary labels are placed manually only (client
  // req 2026-08-28: "delete this remainder of Cadastre. I will add it
  // manually with Add text option") — the earlier auto-suggestion (one
  // guessed for every unmatched plot edge) produced too much clutter/false
  // positives, since an unmatched edge is just as likely to be road-facing
  // as remainder-facing and there's no data to tell them apart. `meta.
  // boundaryLabels` is now the only source, same manual "road" kind Add
  // Text tool the user already places road-width labels with.
  const displayBoundaryLabels = meta.boundaryLabels;

  /** Screen-space rotation so a label runs along its edge (same convention
   *  as CogoWorkspace.tsx's segLabelAngle — sy is north-up, so the north
   *  delta's sign flips for screen angle; clamped to ±90° to stay upright
   *  regardless of which endpoint is "a" and which is "b"). */
  function edgeLabelAngle(a: { east: number; north: number }, b: { east: number; north: number }): number {
    // flip mirrors the screen-x sense (client req 2026-08-28), which negates
    // the angle measured from horizontal — negate the east delta to match.
    const dE = b.east - a.east;
    let deg = (Math.atan2(-(b.north - a.north), flip ? -dE : dE) * 180) / Math.PI;
    if (deg > 90) deg -= 180;
    if (deg < -90) deg += 180;
    return deg;
  }
  interface EdgeDimLabel { id: string; east: number; north: number; angle: number; distance: string; bearing: string }
  // Distance/bearing labels along each ROAD-FACING edge (client req
  // 2026-08-28, screenshot: "distance and bearings are placed nicely like
  // that" — rotated along the edge, distance over bearing, dotted DMS).
  // Reuses the SAME unmatched-edge detection as the REMAINDER labels above
  // — an edge with no matching neighbour plot is either road-facing or
  // backs onto remainder land, and the reference labels both the same way;
  // a shared internal edge between two adjoining lots is left unlabeled to
  // avoid clutter (client's own choice among the options offered).
  // Auto-computed and purely visual — not draggable/editable like the
  // manual road/boundary labels above. Stores real east/north (like
  // `autoBoundaryLabels` above), NOT screen coordinates — this covers every
  // plot across every layout sheet, and only the per-sheet renderer knows
  // which sheet's own fit-to-bounds transform (`t.sx`/`t.sy`) to project
  // through, same reasoning as `displayBoundaryLabels`.
  const edgeDimensionLabels = useMemo<EdgeDimLabel[]>(() => {
    const out: EdgeDimLabel[] = [];
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
        const mE = (a.east + b.east) / 2, mN = (a.north + b.north) / 2;
        const dE = b.east - a.east, dN = b.north - a.north;
        const segLen = Math.hypot(dE, dN) || 1;
        let pE = -dN / segLen, pN = dE / segLen;
        if (pE * (mE - cE) + pN * (mN - cN) < 0) { pE = -pE; pN = -pN; }
        const off = Math.min(14, Math.max(3, segLen * 0.08)); // just off the line, matching the reference's tight offset
        const [brg, dist] = inverse({ east: a.east, north: a.north }, { east: b.east, north: b.north });
        out.push({
          id: `dim-${plot.number}-${i}`,
          east: mE + pE * off,
          north: mN + pN * off,
          angle: edgeLabelAngle(a, b),
          distance: dist.toFixed(2),
          bearing: toDotted(formatDms(brg)),
        });
      }
    }
    return out;
  }, [gpPlots, flip]);

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
    // The exported DXF now matches whatever the live preview is rotated/
    // flipped to (client req 2026-08-28: "DXF main rotation working nahi
    // kar raha") — SURVEY VALUES are still never altered (this file's own
    // Lot Numbers/Block Corner/traverse tables and every other export path
    // still read true east/north straight from `cogoPlots`); only THIS
    // export's geometry is re-expressed in "as displayed" coordinates.
    //
    // `baseT` has no rotation/flip — it's used only to convert a FIXED
    // SCREEN position (title/label text) into world units, and as the
    // "plain linear inverse" half of the round-trip below. `liveT` carries
    // whatever rotation/flip is currently active. For a DATA point (e,n),
    // projecting it through liveT.sx/sy (world -> as-displayed screen) and
    // then back through baseT.screenToWorld (screen -> world, skipping any
    // un-rotation) yields a "fake" world coordinate that a plain north-up
    // DXF viewer will draw in exactly the same place/orientation the live
    // preview shows.
    const baseT = computeTransform(activeUsedBeacons, 0, false);
    const liveT = computeTransform(activeUsedBeacons);
    const toExportWorld = (e: number, n: number) => baseT.screenToWorld(liveT.sx(e, n), liveT.sy(e, n));
    const metresPerUnit = (() => {
      const a = baseT.screenToWorld(0, 0), b = baseT.screenToWorld(1, 0);
      return Math.hypot(b.east - a.east, b.north - a.north) || 1;
    })();
    const notes: ImportedDrawing["texts"] = [];
    const polylines: ImportedDrawing["polylines"] = [];
    const beaconPoints: ImportedDrawing["points"] = [];

    function text(x: number, y: number, s: string, heightUnits: number, anchor?: "middle" | "end") {
      if (!s) return;
      const p = baseT.screenToWorld(x, y);
      notes.push({ x: p.east, y: p.north, text: s, height: heightUnits * metresPerUnit, layer: "SHEET", anchor });
    }

    text(W / 2, 34, `${sheetMode === "working" ? "WORKING" : "GENERAL"} PLAN OF ${meta.name}`, 19, "middle");
    text(W / 2, 54, `Layout of ${layoutGroups[activeGroupIdx].length} parcel(s)${meta.location ? ` — ${meta.location}` : ""}`, 11, "middle");
    text(regX + regW, 18, `GC-${meta.gcNo || "—"}`, 9, "end");
    text(regX + 6, 60, `DSM No: ${meta.dsmNo || "—"}`, 8);
    text(regX + 6, 129, "Surveyed in", 8);
    text(regX + regW - 6, 129, meta.surveyedIn || "—", 8, "end");
    text(regX + 6, 142, "By me", 8);
    text(regX + regW - 6, 142, meta.surveyor || "—", 8, "end");
    text(regX + regW - 6, 153, "Land Surveyor", 7, "end");
    text(W - 20, H - 16, `SR No: ${meta.srNo || "—"}`, 9, "end");

    const groupGpPlots: Plot[] = layoutGroups[activeGroupIdx].map((p) => ({ number: p.number, points: p.fig.points }));
    for (const p of groupGpPlots) {
      if (p.points.length < 2) continue;
      polylines.push({
        pts: p.points.map((pp) => { const w = toExportWorld(pp.east, pp.north); return { x: w.east, y: w.north }; }),
        closed: p.points.length >= 3,
        layer: "BOUNDARY",
      });
    }
    for (const b of activeUsedBeacons) {
      const w = toExportWorld(b.east, b.north);
      beaconPoints.push({ x: w.east, y: w.north, label: b.id, layer: "BEACONS" });
    }
    const bounds = computeTransform(activeUsedBeacons).bounds;
    const inBounds = (tt: ManualText) =>
      tt.east >= bounds.minX - 1 && tt.east <= bounds.maxX + 1 && tt.north >= bounds.minY - 1 && tt.north <= bounds.maxY + 1;
    for (const tt of meta.roadLabels.filter(inBounds)) {
      const w = toExportWorld(tt.east, tt.north);
      notes.push({ x: w.east, y: w.north, text: tt.text, height: 8.5 * metresPerUnit, layer: "ROADS" });
    }
    for (const tt of displayBoundaryLabels.filter(inBounds)) {
      const w = toExportWorld(tt.east, tt.north);
      notes.push({ x: w.east, y: w.north, text: tt.text, height: 7.5 * metresPerUnit, layer: "BOUNDARY_LABELS" });
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

  // Outer page frame (client req 2026-08-28, GC-122 reference audit): the
  // reference has a real margin between the page edge and the drawn border
  // — grid tick marks and "GC-122"/"SR No" live OUT THERE, not inside the
  // border. The old frame sat only 6 units in from the page edge, leaving no
  // room for any of that, so GC-No/SR-No were accidentally rendering INSIDE
  // the border instead of outside it like the reference. FRAME_R/FRAME_B are
  // the border's right/bottom edges.
  const FRAME_M = 24, FRAME_X = FRAME_M, FRAME_Y = FRAME_M, FRAME_R = W - FRAME_M, FRAME_B = H - FRAME_M;
  const TICK = 7; // grid-tick length, projecting outward from the border into the margin
  /** One row of evenly-spaced tick marks along a border edge, projecting
   *  outward (into the margin) rather than inward onto the drawing. */
  function edgeTicks(fixed: number, from: number, to: number, count: number, horizontal: boolean, out: number) {
    const lines = [];
    for (let i = 0; i <= count; i++) {
      const t = from + ((to - from) * i) / count;
      lines.push(
        horizontal
          ? <line key={i} x1={t} y1={fixed} x2={t} y2={fixed + out} stroke="#0f172a" strokeWidth={0.6} />
          : <line key={i} x1={fixed} y1={t} x2={fixed + out} y2={t} stroke="#0f172a" strokeWidth={0.6} />
      );
    }
    return lines;
  }

  // Top-right registration block (client req 2026-08-27, matching the GC-122
  // reference sheet exactly): GC-No, SHEET No, G.P./DSM No, a real
  // Approved/Director-of-Surveys signature block, and Surveyed-in/surveyor
  // details — replaces the old bare "Sheet N of M" caption and the informal
  // Approved box that used to sit at the bottom of the parcel-schedule panel.
  // Sized to sit inside the wider frame above (right edge 6 units short of
  // FRAME_R, client req 2026-08-28).
  const regX = 790, regW = 180;

  // Right-side reference panel (client req 2026-08-27, §2e): Sheet Index,
  // Beacon Description, Splay Information, Ped Way — sits between the
  // registration block above (ends y=146) and the parcel schedule below.
  // Sheet Index is a single trivial entry for now (real multi-sheet splitting
  // is a later phase); the numeric lot range is derived straight from the
  // numbered COGO plots when their numbers are numeric.
  const panelX = 690, panelTop = 167; // registration block above now ends at y=163
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
      {/* Grid tick marks along the border, projecting INWARD into the frame
          (client req 2026-08-28: "check grid marks on frame", then "Grids
          must be inside the frame and be visible" — the first version had
          these pointing outward into the page margin, which the client
          confirmed is wrong). */}
      {edgeTicks(FRAME_Y, FRAME_X, FRAME_R, 14, true, TICK)}
      {edgeTicks(FRAME_B, FRAME_X, FRAME_R, 14, true, -TICK)}
      {edgeTicks(FRAME_X, FRAME_Y, FRAME_B, 10, false, TICK)}
      {edgeTicks(FRAME_R, FRAME_Y, FRAME_B, 10, false, -TICK)}
      <rect x={FRAME_X} y={FRAME_Y} width={FRAME_R - FRAME_X} height={FRAME_B - FRAME_Y} fill="none" stroke="#0f172a" strokeWidth={1.5} />
      {/* Title heading — select/move/resize (client req 2026-08-28: "ye
          client khud drag kar ke kahi bi place kar sake ur resize bi kar
          sake"), same offset pattern as WorkingPlan.tsx's own title block. */}
      {(() => {
        const ts = meta.titleOffset.scale ?? 1;
        const tBoxTop = 18, tBoxBottom = 62, tBoxHalfW = 200;
        return (
          <g
            transform={`translate(${meta.titleOffset.dx},${meta.titleOffset.dy})`}
            style={{ cursor: titleSelected ? "move" : "pointer" }}
            onClick={handleTitleClick}
            onPointerDown={handleTitlePointerDown}
            onPointerMove={handleTitlePointerMove}
            onPointerUp={handleTitlePointerUp}
          >
            <text x={W / 2} y={34} textAnchor="middle" fontSize={19 * ts} fontWeight={700} fill={titleSelected ? "#dc2626" : "#0f172a"}>
              {sheetMode === "working" ? "WORKING PLAN OF" : "GENERAL PLAN OF"} {meta.name}
            </text>
            <text x={W / 2} y={54} textAnchor="middle" fontSize={11 * ts} fill={titleSelected ? "#dc2626" : "#334155"}>
              {label}{meta.location ? ` — ${meta.location}` : ""}
            </text>
            {titleSelected && (
              <>
                <rect
                  x={W / 2 - tBoxHalfW} y={tBoxTop} width={tBoxHalfW * 2} height={tBoxBottom - tBoxTop}
                  fill="none" stroke="#dc2626" strokeWidth={0.8} strokeDasharray="2 2"
                  style={{ pointerEvents: "none" }}
                />
                <g style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); handleTitleResize(0.1); }}>
                  <circle cx={W / 2 + tBoxHalfW + 12} cy={tBoxTop + 14} r={7} fill="white" stroke="#dc2626" strokeWidth={1} />
                  <text x={W / 2 + tBoxHalfW + 12} y={tBoxTop + 17} textAnchor="middle" fontSize={10} fill="#dc2626">+</text>
                </g>
                <g style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); handleTitleResize(-0.1); }}>
                  <circle cx={W / 2 + tBoxHalfW + 12} cy={tBoxTop + 32} r={7} fill="white" stroke="#dc2626" strokeWidth={1} />
                  <text x={W / 2 + tBoxHalfW + 12} y={tBoxTop + 35} textAnchor="middle" fontSize={10} fill="#dc2626">−</text>
                </g>
              </>
            )}
          </g>
        );
      })()}

      {/* "GC-No" sits OUTSIDE the border, in the top margin (client req
          2026-08-28: "check what's within the frame and what is outside") —
          everything below (SHEET No/DSM No/Approved/Director/Surveyed in)
          stays INSIDE it. */}
      <text x={regX + regW} y={18} textAnchor="end" fontSize={9} fontWeight={700} fill="#dc2626">GC-{meta.gcNo || "—"}</text>
      {/* Matched to the GC-122 reference exactly (client req 2026-08-28,
          screenshot circling this whole box): no "G.P. No." row here (that
          field stays editable for other diagrams' own cross-reference, just
          not printed in this box); a real blank gap — not a drawn line —
          between "Approved" and "Director of Surveys and Mapping" for the
          actual signature; "Surveyed in"/"By me" each pair a label on the
          left with its value right-aligned on the same row, and "Land
          Surveyor" sits alone on the row under the surveyor's name. */}
      <rect x={regX} y={30} width={regW} height={133} fill="none" stroke="#0f172a" strokeWidth={0.6} />
      <text x={regX + regW / 2} y={42} textAnchor="middle" fontSize={9} fontWeight={700}>SHEET No - {no} of {sheetCount}</text>
      <line x1={regX} y1={47} x2={regX + regW} y2={47} stroke="#0f172a" strokeWidth={0.4} />
      <text x={regX + 6} y={61} fontSize={9.5} fontWeight={700} fill="#0f172a">DSM No: {meta.dsmNo || "—"}</text>
      <line x1={regX} y1={66} x2={regX + regW} y2={66} stroke="#0f172a" strokeWidth={0.4} />
      <text x={regX + 6} y={80} fontSize={8.5} fontWeight={700} fill="#0f172a">Approved</text>
      <text x={regX + 6} y={108} fontSize={7.5} fontWeight={700} fill="#0f172a">Director of Surveys and Mapping</text>
      <line x1={regX} y1={116} x2={regX + regW} y2={116} stroke="#0f172a" strokeWidth={0.4} />
      <text x={regX + 6} y={129} fontSize={8} fontWeight={700} fill="#0f172a">Surveyed in</text>
      <text x={regX + regW - 6} y={129} textAnchor="end" fontSize={8} fontWeight={700} fill="#0f172a">{meta.surveyedIn || "—"}</text>
      <text x={regX + 6} y={142} fontSize={8} fontWeight={700} fill="#0f172a">By me</text>
      <text x={regX + regW - 6} y={142} textAnchor="end" fontSize={8} fontWeight={600} fill="#0f172a">{meta.surveyor || "—"}</text>
      <text x={regX + regW - 6} y={153} textAnchor="end" fontSize={7} fontWeight={700} fill="#0f172a">Land Surveyor</text>

      {/* SR No sits OUTSIDE the border too (client req 2026-08-28: "SR number
          outside frame") — y=H-16 already clears FRAME_B (H-24) now that the
          margin is wide enough to hold it. */}
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
    const sheetDimLabels = edgeDimensionLabels.filter((d) => inBounds({ id: d.id, east: d.east, north: d.north, text: "" }));

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
          const d = pts.map((pp) => `${t.sx(pp.east, pp.north)},${t.sy(pp.east, pp.north)}`).join(" ");
          const cx = pts.reduce((a, pp) => a + t.sx(pp.east, pp.north), 0) / pts.length;
          const cy = pts.reduce((a, pp) => a + t.sy(pp.east, pp.north), 0) / pts.length;
          const col = PALETTE[i % PALETTE.length];
          return (
            <g key={p.number}>
              <polygon points={d} fill={col} fillOpacity={0.13} stroke={col} strokeWidth={1.4} />
              <text x={cx} y={cy} textAnchor="middle" fontSize={10} fontWeight={700} fill={col}>{p.number}</text>
            </g>
          );
        })}
        {(() => {
          // Decluttered (client req 2026-08-30) — a sheet with dozens/hundreds
          // of lots (e.g. Auto-Detect Rectangular Lots on a real subdivision)
          // has that many boundary beacons close together; a fixed +4,-3
          // offset per label then piles every one on top of the next. Every
          // beacon's dot still always renders regardless of what happens to
          // its label.
          const placements = declutterLabels(
            groupUsedBeacons.map((b) => ({
              id: b.id,
              x: t.sx(b.east, b.north),
              y: t.sy(b.east, b.north),
              text: b.id,
              fontSize: 8,
              preferDx: 4,
              preferDy: -3,
            }))
          );
          const byId = new Map(placements.map((pl) => [pl.id, pl]));
          return groupUsedBeacons.map((b) => {
            const bx = t.sx(b.east, b.north), by = t.sy(b.east, b.north);
            const pl = byId.get(b.id);
            return (
              <g key={b.id}>
                <circle cx={bx} cy={by} r={2.6} fill="#0f172a" />
                {pl?.leader && <line x1={bx} y1={by} x2={pl.labelX} y2={pl.labelY} stroke="#cbd5e1" strokeWidth={0.5} />}
                {!pl?.hidden && (
                  <text x={pl?.labelX ?? bx + 4} y={pl?.labelY ?? by - 3} fontSize={8} fill="#334155">{b.id}</text>
                )}
              </g>
            );
          });
        })()}
        {groupUsedBeacons.length === 0 && (
          <text x={(FX0 + FX1) / 2} y={(FY0 + FY1) / 2} textAnchor="middle" fontSize={11} fill="#cbd5e1">No plots numbered in COGO yet</text>
        )}
        {/* Road-width labels + REMAINDER OF CADASTRE boundary labels */}
        {sheetRoadLabels.map((tt) => (
          <text
            key={tt.id}
            x={t.sx(tt.east, tt.north)}
            y={t.sy(tt.east, tt.north)}
            textAnchor="middle"
            fontSize={8.5}
            fontWeight={600}
            fill={selectedLabel?.id === tt.id && selectedLabel.kind === "road" ? "#2563eb" : "#0f172a"}
            transform={(flip ? -(tt.angle || 0) : (tt.angle || 0)) + rotation ? `rotate(${(flip ? -(tt.angle || 0) : (tt.angle || 0)) + rotation} ${t.sx(tt.east, tt.north)} ${t.sy(tt.east, tt.north)})` : undefined}
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
            x={t.sx(tt.east, tt.north)}
            y={t.sy(tt.east, tt.north)}
            textAnchor="middle"
            fontSize={7.5}
            fontStyle="italic"
            fill={selectedLabel?.id === tt.id && selectedLabel.kind === "boundary" ? "#2563eb" : "#64748b"}
            transform={(flip ? -(tt.angle || 0) : (tt.angle || 0)) + rotation ? `rotate(${(flip ? -(tt.angle || 0) : (tt.angle || 0)) + rotation} ${t.sx(tt.east, tt.north)} ${t.sy(tt.east, tt.north)})` : undefined}
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
        {/* Distance/bearing labels along road-facing edges (client req
            2026-08-28) — auto-computed, not draggable, so no click/pointer
            handlers unlike the manual labels above. */}
        {sheetDimLabels.map((d) => (
          <g key={d.id} transform={`rotate(${d.angle + rotation} ${t.sx(d.east, d.north)} ${t.sy(d.east, d.north)})`}>
            <text x={t.sx(d.east, d.north)} y={t.sy(d.east, d.north)} textAnchor="middle" fontSize={7} fill="#334155">{d.distance}</text>
            <text x={t.sx(d.east, d.north)} y={t.sy(d.east, d.north) + 9} textAnchor="middle" fontSize={7} fill="#334155">{d.bearing}</text>
          </g>
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
