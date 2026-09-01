"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "@/lib/store";
import { Button, Card, Field, Input } from "@/components/ui";
import { displayCrs } from "@/lib/crsOptions";
import { dedupePoints, findOuterBoundary, formatLotRange, sameWorldPoint, type Plot } from "@/lib/plots";
import { comparePointNames } from "@/lib/reportFormats";
import { fmtCoord, fmtSystem, toDotted } from "@/lib/diagramLayout";
import { inverse } from "@/lib/server/geometry";
import { formatDms } from "@/lib/server/angles";
import { type ManualText } from "@/components/SgDiagram";
import { writeDxf, type ImportedDrawing } from "@/lib/dxf";

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
  const { cogoPlots, config, setConfig, generalPlanInput, setGeneralPlanInput, importResult } = useStore();

  const refs = useRef<(SVGSVGElement | null)[]>([]);
  const [sheet, setSheet] = useState(0);
  // Zoom for the sheet preview only (client req 2026-09-01: "zoom this GP
  // only with a scroll button without moving the whole window") — a plain
  // CSS transform on the preview box, independent of the browser's own
  // page zoom/scroll.
  const [gpZoom, setGpZoom] = useState(1);
  const GP_ZOOM_MIN = 0.4, GP_ZOOM_MAX = 3;
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
  // "LOTS 14183-14608" (client req 2026-08-30, matching the GC-122/WP_CH
  // reference sheets' title exactly) — the WHOLE layout's range, not just
  // whichever sheet is currently showing, same source `cogoPlots` the rest
  // of this module already reads.
  const lotRangeText = useMemo(() => formatLotRange(cogoPlots.map((p) => p.number)), [cogoPlots]);
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
    parentLotNumber: string; tribalArea: string; parentDsmNo: string;
    beaconDescription: string; pedWay: string; splayEntries: { corner: string; distance: string }[];
    roadLabels: ManualText[]; boundaryLabels: ManualText[];
    titleOffset: { dx: number; dy: number; scale?: number };
    panelOffset: { dx: number; dy: number };
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
    // Extra title lines matching the GC-122/WP_CH reference exactly (client
    // req 2026-08-30) — each is OPTIONAL and only adds its own line when
    // filled in, so a project that never sets these keeps today's shorter
    // title unchanged. "PORTIONS OF LOT {parentLotNumber} {name}" / "SITUATE
    // AT {location} IN THE {tribalArea} TRIBAL AREA" / (General Plan only)
    // "VIDE DIAGRAM DSM NO. {parentDsmNo} ANNEXED TO".
    parentLotNumber: "", // e.g. "14182"
    tribalArea: "",      // e.g. "GHANZI"
    parentDsmNo: "",     // e.g. "1243/2026"
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
    // Select/move for the right-side reference panel + Lot Numbers/Block
    // Corner tables (client req 2026-09-01: "i should be able to drag this
    // also") — same dx/dy offset mechanism as titleOffset above, minus the
    // resize handles (only dragging was asked for here).
    panelOffset: { dx: 0, dy: 0 } as { dx: number; dy: number },
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
  // independently fitted/scaled to its own subset of plots. 40 (the original
  // value) split a real ~500-lot subdivision into 25+ sparse sheets instead
  // of the reference GC-122 sheet's own 2 dense ones (~213-260 lots each,
  // client req 2026-08-30) — each sheet is a fixed-size page that already
  // fit-to-bounds scales to whatever it's given (via computeTransform), so
  // there's no rendering reason to cap this low; raised to match what the
  // reference actually does with a real subdivision.
  const PLOTS_PER_SHEET = 300;
  const sortedPlots = useMemo(
    () => [...cogoPlots].sort((a, b) => comparePointNames(a.number, b.number)),
    [cogoPlots]
  );
  const layoutGroups = useMemo(() => {
    if (!sortedPlots.length) return [[] as typeof sortedPlots];
    // BALANCED split, not a fixed cap-then-remainder slice (client req
    // 2026-09-01: "jese Sheet 2 mein hai... same Sheet 1 mein bhi hona
    // chahiye" — 327 lots at a 300 cap produced 300 + 27, so Sheet 1's
    // density-tiered font/line-weight (tuned per-sheet from its own plot
    // count) came out visibly smaller/denser than Sheet 2's, even though
    // both are the same layout). Same number of sheets as before (still
    // driven by PLOTS_PER_SHEET), but every sheet gets as close to an equal
    // share of the total as possible, matching the reference's own fairly
    // even split (257/169 lots across its 2 sheets, not one packed sheet
    // and one nearly-empty one).
    const sheetsNeeded = Math.ceil(sortedPlots.length / PLOTS_PER_SHEET);
    const perSheet = Math.ceil(sortedPlots.length / sheetsNeeded);
    const groups: (typeof sortedPlots)[] = [];
    for (let i = 0; i < sortedPlots.length; i += perSheet) groups.push(sortedPlots.slice(i, i + perSheet));
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
  // Extra title lines (client req 2026-08-30, matching the GC-122/WP_CH
  // reference exactly — "PORTIONS OF LOT .../VIDE DIAGRAM DSM NO. .../
  // SITUATE AT ... TRIBAL AREA") each push the drawing area down by one
  // line so they never overlap it; a project that leaves these fields blank
  // keeps today's shorter title and FY0 stays exactly 90 as before.
  const extraTitleLines: string[] = [];
  if (meta.parentLotNumber.trim()) extraTitleLines.push(`PORTIONS OF LOT ${meta.parentLotNumber.trim()} ${meta.name}`);
  if (sheetMode === "general" && meta.parentDsmNo.trim()) extraTitleLines.push(`VIDE DIAGRAM DSM NO. ${meta.parentDsmNo.trim()} ANNEXED TO`);
  if (meta.tribalArea.trim()) extraTitleLines.push(`SITUATE AT ${(meta.location || meta.name).trim()} IN THE ${meta.tribalArea.trim()} TRIBAL AREA`);
  // Scale moved up into the heading itself (client req 2026-08-31, matching
  // the GC-122/WP_CH reference — "SCALE 1:1000" is the title's own last
  // line, not a separate caption under the drawing) — always shown, unlike
  // the three lines above which only appear once their field is filled in.
  extraTitleLines.push(`SCALE 1:${meta.scale.toLocaleString()}`);
  const TITLE_EXTRA_LINE_H = 13;
  // "OF" now runs on its own line under the main "GENERAL PLAN"/"WORKING
  // PLAN" heading (client req 2026-09-01 redline), pushing the "LOTS ...
  // {name}" line down from y=54 to y=66 — FY0's base shifts by the same 12
  // units so the drawing area still starts exactly as far below the title
  // as it did before this line moved.
  const TITLE_OF_Y = 49, TITLE_LINE2_Y = 66;
  const FX0 = 30, FY0 = 102 + extraTitleLines.length * TITLE_EXTRA_LINE_H, FX1 = 660, FY1 = H - 150;
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
  // "REMAINDER OF CADASTRE"-style boundary labels stayed manual-only after
  // the earlier auto-suggestion feature was removed for producing too many
  // false positives (client req 2026-08-28) — but no "Add Boundary Label"
  // button was ever added to replace it, so meta.boundaryLabels had no way
  // to ever get a first entry at all (client req 2026-08-31: "REMAINDER OF
  // CADASTRE" missing — it wasn't just unlabelled, it was unreachable).
  const [addingBoundaryLabel, setAddingBoundaryLabel] = useState(false);
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

  // Select/move for the right-side reference panel (Sheet Index/Beacon
  // Description/Splay/Ped Way + Lot Numbers/Block Corner tables) — client
  // req 2026-09-01: "i should be able to drag this also", same pattern as
  // the title block above, minus resize (only dragging was asked for).
  const [panelSelected, setPanelSelected] = useState(false);
  const [draggingPanel, setDraggingPanel] = useState<{ startSx: number; startSy: number; origDx: number; origDy: number } | null>(null);
  const panelDragMovedRef = useRef(false);
  function handlePanelClick(e: ReactMouseEvent<SVGElement>) {
    e.stopPropagation();
    if (panelDragMovedRef.current) { panelDragMovedRef.current = false; return; }
    setPanelSelected((s) => !s);
  }
  function handlePanelPointerDown(e: ReactPointerEvent<SVGElement>) {
    if (!panelSelected) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = toSvgPoint(e);
    setDraggingPanel({ startSx: p.x, startSy: p.y, origDx: meta.panelOffset.dx, origDy: meta.panelOffset.dy });
  }
  function handlePanelPointerMove(e: ReactPointerEvent<SVGElement>) {
    if (!draggingPanel) return;
    const p = toSvgPoint(e);
    const dx = p.x - draggingPanel.startSx, dy = p.y - draggingPanel.startSy;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) panelDragMovedRef.current = true;
    setMeta((m) => ({ ...m, panelOffset: { dx: draggingPanel.origDx + dx, dy: draggingPanel.origDy + dy } }));
  }
  function handlePanelPointerUp() {
    setDraggingPanel(null);
  }
  function cancelPanelDrag() {
    if (!draggingPanel) return;
    setMeta((m) => ({ ...m, panelOffset: { dx: draggingPanel.origDx, dy: draggingPanel.origDy } }));
    setDraggingPanel(null);
  }
  useEffect(() => {
    if (!draggingPanel) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") cancelPanelDrag(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingPanel]);

  useEffect(() => {
    if (!textPrompt && !addingRoadLabel && !addingBoundaryLabel) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setTextPrompt(null);
      setAddingRoadLabel(false);
      setAddingBoundaryLabel(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [textPrompt, addingRoadLabel, addingBoundaryLabel]);

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
    if (addingBoundaryLabel) {
      const p = toSvgPoint(e);
      // Pre-fills the wording when the parent lot is known (client req
      // 2026-08-31) — still requires the user to click a real position and
      // confirm/edit in the prompt, same manual placement as before.
      const suggested = meta.parentLotNumber.trim() ? `REMAINDER OF CADASTRE ${meta.parentLotNumber.trim()}` : "";
      setTextPrompt({ id: null, kind: "boundary", x: p.x, y: p.y, value: suggested, angle: 0 });
      setAddingBoundaryLabel(false);
      return;
    }
    setSelectedLabel(null);
    setTitleSelected(false);
    setPanelSelected(false);
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
        // Points back toward the plot's own centroid — INSIDE the lot
        // (client req 2026-08-31 redline: "move the distance and bearing
        // text to inside" — it previously pointed outward, away from the
        // centroid, sitting past the boundary in the road/margin).
        if (pE * (mE - cE) + pN * (mN - cN) > 0) { pE = -pE; pN = -pN; }
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

    text(W / 2, 34, `${sheetMode === "working" ? "WORKING" : "GENERAL"} PLAN`, 19, "middle");
    text(W / 2, TITLE_OF_Y, "OF", 11, "middle");
    text(
      W / 2, TITLE_LINE2_Y,
      lotRangeText
        ? `LOTS ${lotRangeText} ${meta.name}`
        : `Layout of ${layoutGroups[activeGroupIdx].length} parcel(s)${meta.name ? ` ${meta.name}` : ""}${meta.location ? ` — ${meta.location}` : ""}`,
      11, "middle"
    );
    extraTitleLines.forEach((ln, i) => text(W / 2, TITLE_LINE2_Y + (i + 1) * TITLE_EXTRA_LINE_H, ln, 10, "middle"));
    // Registration box (GC-No/SHEET-No/DSM-No/Surveyed-in/By-me/Land-Surveyor)
    // stays in sync with the SVG preview above — General Plan only, absent
    // from the real Working Plan reference sheet.
    if (sheetMode === "general") {
      text(regX, 18, `GC-${meta.gcNo || "—"}`, 9);
      text(regX + regW, 18, `SHEET No - ${activeGroupIdx + 1} of ${sheetCount}`, 9, "end");
      text(regX + 6, regY + 24, `DSM No: ${meta.dsmNo || "—"}`, 9.5);
      text(regX + 6, regY + 100, "Surveyed in", 8);
      text(regX + regW - 6, regY + 100, meta.surveyedIn || "—", 8, "end");
      text(regX + 6, regY + 114, "By me", 8);
      text(regX + regW - 6, regY + 114, meta.surveyor || "—", 8, "end");
      text(regX + regW - 6, regY + 126, "Land Surveyor", 7, "end");
    }
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
  // Bigger + labelled (client req 2026-09-01, redline circling the top/left
  // ticks: "increase size of grid marks and add labels") — a plain unlabelled
  // tick doesn't tell a reader what coordinate it's actually at; the
  // reference sheet's own grid marks carry their real Y/X (east/north)
  // value. 10 -> 16 for the tick length itself.
  const TICK = 16; // grid-tick length (client req 2026-09-01: "increase size of grid marks" — was 10)
  const GRID_LABEL_FS = 6.5;
  /** One row of evenly-spaced tick marks along a border edge, projecting
   *  outward (into the margin) rather than inward onto the drawing.
   *  `worldAt`, when given, labels each tick with the real Y (east, on
   *  horizontal top/bottom edges) or X (north, on vertical left/right
   *  edges) coordinate at that position — same "Y"/"X" naming the Block
   *  Corner Table already uses for this coordinate system. */
  function edgeTicks(
    fixed: number, from: number, to: number, count: number, horizontal: boolean, out: number,
    worldAt?: (px: number, py: number) => { east: number; north: number }
  ) {
    const lines = [];
    for (let i = 0; i <= count; i++) {
      const t = from + ((to - from) * i) / count;
      const x1 = horizontal ? t : fixed, y1 = horizontal ? fixed : t;
      const x2 = horizontal ? t : fixed + out, y2 = horizontal ? fixed + out : t;
      lines.push(<line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#0f172a" strokeWidth={1} />);
      if (worldAt) {
        const w = worldAt(x1, y1);
        const val = Math.round(horizontal ? w.east : w.north);
        const labelText = `${horizontal ? "Y" : "X"}+${val}`;
        // Client req 2026-09-02 (screenshot, circling the labels): these sit
        // INSIDE the frame, right at the tick, not out in the margin the
        // border itself sits in — `out`'s own sign already points that way
        // (the tick's INWARD direction into the frame). Vertical-edge labels
        // are rotated to run parallel to the border, matching the reference.
        const dir = out > 0 ? 1 : -1;
        const lx = horizontal ? t : fixed + dir * 8;
        const ly = horizontal ? fixed + dir * 8 : t;
        lines.push(
          <text
            key={`l${i}`}
            x={lx} y={ly}
            fontSize={GRID_LABEL_FS}
            textAnchor="middle"
            fill="#475569"
            transform={horizontal ? undefined : `rotate(-90 ${lx} ${ly})`}
          >
            {labelText}
          </text>
        );
      }
    }
    return lines;
  }

  // Top-right registration block (client req 2026-08-27, matching the GC-122
  // reference sheet exactly): GC-No, SHEET No, G.P./DSM No, a real
  // Approved/Director-of-Surveys signature block, and Surveyed-in/surveyor
  // details — replaces the old bare "Sheet N of M" caption and the informal
  // Approved box that used to sit at the bottom of the parcel-schedule panel.
  // A true 10cm-by-10cm square sitting exactly at the frame's own top-right
  // corner (client req 2026-08-31 redline: "make the corner box 10cm by
  // 10cm, place the box exactly at the corner") — previously a wide
  // rectangle with a small gap from the corner. GC-No/SHEET No move out of
  // the box entirely, onto one line directly above it (same redline: "move
  // GC number" / "move sheet numbering" — the reference has both above the
  // box, not GC above and Sheet No as the box's own first row).
  const regSize = 145;
  const regX = FRAME_R - regSize, regY = FRAME_Y;
  const regW = regSize;

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
  // The Sheet Index lists one line per layout sheet — unbounded, it pushed
  // everything below it (Lot Numbers table, Block Corner Table) off the
  // bottom of the sheet once a layout produced many sheets (client req
  // 2026-08-30). Capped, with the rest summarised on one line.
  const MAX_SHEET_INDEX_LINES = 10;
  const shownSheetIndex =
    sheetIndexLines.length > MAX_SHEET_INDEX_LINES
      ? [
          ...sheetIndexLines.slice(0, MAX_SHEET_INDEX_LINES - 1),
          `… +${sheetIndexLines.length - (MAX_SHEET_INDEX_LINES - 1)} more sheet(s)`,
        ]
      : sheetIndexLines;
  // "SHEET INDEX" is a General Plan thing only — verified against the real
  // WP_CH.pdf reference text (client req 2026-09-01): it never appears on
  // the Working Plan reference sheet at all, only Beacon Description/Splay
  // Information/Ped Way do.
  const panelRows: { text: string; heading?: boolean }[] = [
    ...(sheetMode === "general" ? [{ text: "SHEET INDEX", heading: true }, ...shownSheetIndex.map((text) => ({ text }))] : []),
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
  // Both right-hand tables have to end above the bottom band (the outer-
  // boundary traverse on sheet 1, its back-reference on the others), not just
  // above the page edge — client req 2026-08-30: at real subdivision density
  // the Block Corner Table ran straight off the sheet.
  const rightColTop = lotTableTop + 34;
  const rightColBottom = FY1 + 20;
  const rightColH = Math.max(0, rightColBottom - rightColTop);
  const BC_ROW_H = 13;
  // What the Block Corner Table would need if every beacon were listed,
  // clamped to at most half the column so the Lot Areas table above always
  // keeps usable room no matter how many beacons the layout produces.
  const bcReserve =
    usedBeacons.length > 0
      ? Math.min(70 + usedBeacons.length * BC_ROW_H, Math.floor(rightColH * 0.5))
      : 30;
  // Room the lot table needs BELOW its last row: the "SHEET TOTAL" line
  // (+16) and, when the sheet holds more lots than fit, the "+N more" note
  // (+32). Without reserving these the table's own footer ran past the frame
  // even when the rows themselves fit (client req 2026-08-30).
  const LOT_FOOTER_H = 36;
  const rowsPerCol = Math.max(1, Math.floor((rightColH - bcReserve - LOT_FOOTER_H) / lotRowH));
  const maxLotRows = rowsPerCol * 2;
  // Bordered grid — outer box, header underline, and a vertical rule between
  // every column, matching the reference sheet's own boxed "LOT AREAS" table
  // exactly (client req 2026-09-01, screenshot: "put lot areas in a table
  // like that" — was plain floating text with no lines at all before).
  const tblL = 685, tblR = 975;
  const vA = 758, vMid = 832, vB = 906; // vertical divider x-positions
  const lotAR = vA - 6, sqmAR = vMid - 6, lotBR = vB - 6, sqmBR = tblR - 6; // right-aligned column edges
  const lotPairHeader = (lotColR: number, sqmColR: number, y: number) => (
    <>
      <text x={lotColR} y={y} textAnchor="end" fontSize={9.5} fontWeight={700} fill="#475569">LOT No.</text>
      <text x={sqmColR} y={y} textAnchor="end" fontSize={9.5} fontWeight={700} fill="#475569">SQ. METRES</text>
    </>
  );
  // `worldAt` (only supplied by renderLayoutSheet, which has an actual
  // fit-to-bounds transform to invert — the coordinate-schedule appendix
  // sheet below has no drawing to correlate a grid label to, so its own
  // ticks stay unlabelled) labels just the top and left edges' ticks with
  // their real Y/X coordinate (client req 2026-09-01 redline, circling
  // exactly those two edges: "increase size of grid marks and add
  // labels") — bottom/right stay plain ticks, since a bottom-edge label
  // near the sheet's own right end would collide with "SR No" there.
  const titleBlock = (no: number, label: string, worldAt?: (px: number, py: number) => { east: number; north: number }) => (
    <>
      {/* Grid tick marks along the border, projecting INWARD into the frame
          (client req 2026-08-28: "check grid marks on frame", then "Grids
          must be inside the frame and be visible" — the first version had
          these pointing outward into the page margin, which the client
          confirmed is wrong). */}
      {/* Top and right edges stop short of the registration box's own
          footprint (client req 2026-08-31: "remove the grid markers" once
          the box sits exactly at that corner — tick marks and the box border
          would otherwise land on top of each other). Count scaled down to
          match the shorter span so spacing stays even. */}
      {/* Full-length ticks in Working Plan mode (client req 2026-09-01) — the
          gap that avoids the registration box's footprint only makes sense
          when that box is actually drawn (General Plan only, see below). */}
      {sheetMode === "general"
        ? edgeTicks(FRAME_Y, FRAME_X, regX, 12, true, TICK, worldAt)
        : edgeTicks(FRAME_Y, FRAME_X, FRAME_R, 14, true, TICK, worldAt)}
      {edgeTicks(FRAME_B, FRAME_X, FRAME_R, 14, true, -TICK)}
      {edgeTicks(FRAME_X, FRAME_Y, FRAME_B, 10, false, TICK, worldAt)}
      {sheetMode === "general"
        ? edgeTicks(FRAME_R, regY + regSize, FRAME_B, 8, false, -TICK)
        : edgeTicks(FRAME_R, FRAME_Y, FRAME_B, 10, false, -TICK)}
      <rect x={FRAME_X} y={FRAME_Y} width={FRAME_R - FRAME_X} height={FRAME_B - FRAME_Y} fill="none" stroke="#0f172a" strokeWidth={1.5} />
      {/* Title heading — select/move/resize (client req 2026-08-28: "ye
          client khud drag kar ke kahi bi place kar sake ur resize bi kar
          sake"), same offset pattern as WorkingPlan.tsx's own title block. */}
      {(() => {
        const ts = meta.titleOffset.scale ?? 1;
        const tBoxTop = 18, tBoxBottom = TITLE_LINE2_Y + 8 + extraTitleLines.length * TITLE_EXTRA_LINE_H, tBoxHalfW = 200;
        // "LOTS 14183-14608 CHARLESHILL" once plots are numbered — layout
        // name sits on THIS line, next to the lot range (client req
        // 2026-09-01 redline: "move CharlesHill to be next to Plot
        // numbers"), matching the GC-122 reference exactly. Falls back to
        // the original "Layout of N parcel(s)" wording (still with the name
        // appended) when there's nothing numbered yet to range over.
        const line2 = lotRangeText
          ? `LOTS ${lotRangeText} ${meta.name}`
          : `${label}${meta.name ? ` ${meta.name}` : ""}${meta.location ? ` — ${meta.location}` : ""}`;
        return (
          <g
            transform={`translate(${meta.titleOffset.dx},${meta.titleOffset.dy})`}
            style={{ cursor: titleSelected ? "move" : "pointer" }}
            onClick={handleTitleClick}
            onPointerDown={handleTitlePointerDown}
            onPointerMove={handleTitlePointerMove}
            onPointerUp={handleTitlePointerUp}
          >
            {/* "OF" on its own line under the main heading (client req
                2026-09-01 redline: "move Of to be under General Plan"),
                matching the GC-122/WP_CH reference exactly instead of
                running "GENERAL PLAN OF {name}" together on one line. */}
            <text x={W / 2} y={34} textAnchor="middle" fontSize={19 * ts} fontWeight={700} fill={titleSelected ? "#dc2626" : "#0f172a"}>
              {sheetMode === "working" ? "WORKING PLAN" : "GENERAL PLAN"}
            </text>
            <text x={W / 2} y={TITLE_OF_Y} textAnchor="middle" fontSize={11 * ts} fill={titleSelected ? "#dc2626" : "#334155"}>
              OF
            </text>
            <text x={W / 2} y={TITLE_LINE2_Y} textAnchor="middle" fontSize={11 * ts} fill={titleSelected ? "#dc2626" : "#334155"}>
              {line2}
            </text>
            {extraTitleLines.map((ln, i) => (
              <text key={i} x={W / 2} y={TITLE_LINE2_Y + (i + 1) * TITLE_EXTRA_LINE_H} textAnchor="middle" fontSize={10 * ts} fill={titleSelected ? "#dc2626" : "#334155"}>
                {ln}
              </text>
            ))}
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

      {/* GC-No/SHEET-No/DSM-No/Approved/Director-of-Surveys registration box
          is a GENERAL PLAN thing only — verified against the real WP_CH.pdf
          reference text (client req 2026-09-01, "100% samples jese format
          chahiye... na kuch extra ho"): none of "GC", "DSM No", "Approved",
          "Director of Surveys", or "SHEET No" appear anywhere on the
          Working Plan reference sheet at all. A Working Plan is the
          surveyor's own working sketch (covered by the certification box
          below in "working" mode instead); only the formally REGISTERED
          General Plan carries the government approval block. */}
      {sheetMode === "general" && (
        <>
          {/* GC-No and SHEET No sit OUTSIDE the box, side by side directly above
              it (client req 2026-08-31 redline: "move GC number" / "move sheet
              numbering" — the box itself now starts with DSM No, not a Sheet No
              row). */}
          <text x={regX} y={18} fontSize={9} fontWeight={700} fill="#dc2626">GC-{meta.gcNo || "—"}</text>
          <text x={regX + regW} y={18} textAnchor="end" fontSize={9} fontWeight={700} fill="#0f172a">SHEET No - {no} of {sheetCount}</text>
          {/* Matched to the GC-122 reference exactly (client req 2026-08-28,
              screenshot circling this whole box): no "G.P. No." row here (that
              field stays editable for other diagrams' own cross-reference, just
              not printed in this box); a real blank gap — not a drawn line —
              between "Approved" and "Director of Surveys and Mapping" for the
              actual signature; "Surveyed in"/"By me" each pair a label on the
              left with its value right-aligned on the same row, and "Land
              Surveyor" sits alone on the row under the surveyor's name. */}
          <rect x={regX} y={regY} width={regW} height={regSize} fill="none" stroke="#0f172a" strokeWidth={0.6} />
          <text x={regX + 6} y={regY + 24} fontSize={9.5} fontWeight={700} fill="#0f172a">DSM No: {meta.dsmNo || "—"}</text>
          <line x1={regX} y1={regY + 30} x2={regX + regW} y2={regY + 30} stroke="#0f172a" strokeWidth={0.4} />
          <text x={regX + 6} y={regY + 46} fontSize={8.5} fontWeight={700} fill="#0f172a">Approved</text>
          <text x={regX + 6} y={regY + 76} fontSize={7.5} fontWeight={700} fill="#0f172a">Director of Surveys and Mapping</text>
          <line x1={regX} y1={regY + 86} x2={regX + regW} y2={regY + 86} stroke="#0f172a" strokeWidth={0.4} />
          <text x={regX + 6} y={regY + 100} fontSize={8} fontWeight={700} fill="#0f172a">Surveyed in</text>
          <text x={regX + regW - 6} y={regY + 100} textAnchor="end" fontSize={8} fontWeight={700} fill="#0f172a">{meta.surveyedIn || "—"}</text>
          <text x={regX + 6} y={regY + 114} fontSize={8} fontWeight={700} fill="#0f172a">By me</text>
          <text x={regX + regW - 6} y={regY + 114} textAnchor="end" fontSize={8} fontWeight={600} fill="#0f172a">{meta.surveyor || "—"}</text>
          <text x={regX + regW - 6} y={regY + 126} textAnchor="end" fontSize={7} fontWeight={700} fill="#0f172a">Land Surveyor</text>
        </>
      )}

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
        style={{ border: "1px solid #cbd5e1", cursor: addingRoadLabel || addingBoundaryLabel ? "crosshair" : "default" }}
        onClick={handleCanvasClick}
      >
        {titleBlock(groupIdx + 1, `Layout of ${groupPlots.length} parcel(s)`, t.screenToWorld)}
        {/* north arrow */}
        <g transform={`translate(${FX1 - 20},${FY0 + 16})`}>
          <line x1={0} y1={12} x2={0} y2={-10} stroke="#0f172a" strokeWidth={1.5} />
          <polygon points="0,-14 -5,-5 5,-5" fill="#0f172a" />
          <text x={0} y={26} textAnchor="middle" fontSize={10} fill="#0f172a">N</text>
        </g>
        {/* parcels — plain black outline, no fill (client req 2026-08-31:
            "colorful ku hai ur simple lines ku nahi" — matching the GC-122
            reference's own monochrome line drawing exactly, not a colour
            per lot). Line/plot-number weight both shrink as more plots
            share one sheet — a 1.4px line and 10px label sized for a
            handful of large lots turns into a solid black smear once
            hundreds of small lots share the same sheet. */}
        {groupSchedule.map(({ p, i }) => {
          const pts = p.fig.points;
          if (pts.length < 3) return null;
          const d = pts.map((pp) => `${t.sx(pp.east, pp.north)},${t.sy(pp.east, pp.north)}`).join(" ");
          const cx = pts.reduce((a, pp) => a + t.sx(pp.east, pp.north), 0) / pts.length;
          const cy = pts.reduce((a, pp) => a + t.sy(pp.east, pp.north), 0) / pts.length;
          // Reduced again (client req 2026-09-01: "counting numbers ka font
          // bara hai") — still legible at real density without dominating
          // the tiny lot cells the way the previous tiers still did.
          const plotFS = groupPlots.length > 150 ? 3 : groupPlots.length > 60 ? 4.5 : groupPlots.length > 20 ? 6 : 8;
          const lineW = groupPlots.length > 150 ? 0.5 : groupPlots.length > 60 ? 0.7 : 1;
          return (
            <g key={p.number}>
              <polygon points={d} fill="none" stroke="#0f172a" strokeWidth={lineW} strokeLinejoin="round" />
              <text x={cx} y={cy} textAnchor="middle" fontSize={plotFS} fontWeight={700} fill="#0f172a">{p.number}</text>
            </g>
          );
        })}
        {/* Beacon/point IDs are NEVER printed on the drawing itself in the
            reference sheet (client req 2026-08-31, confirmed against
            SHEET1_CH.pdf) — only the lot number centred in each polygon and
            the side-length/bearing labels along the edges. That real
            coordinate/ID data belongs solely in the Block Corner Table
            below. Previously rendered here as a dot + decluttered label +
            leader line; removed entirely rather than just hidden — the
            leader lines (drawn whenever a label had to be nudged away from
            its point) were themselves the "diagonal crosshatch" artefact
            reported crossing through multiple lots at real density, so
            this fixes both the point-ID clutter and that artefact at once. */}
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
            handlers unlike the manual labels above. Font shrinks with how
            many of these are on the sheet (client req 2026-08-31: this was
            the actual biggest source of clutter in the reported screenshot
            — a fixed 7px size wasn't scaled at all, unlike the beacon/plot-
            number labels fixed earlier — at real density hundreds of these
            crowded the whole sheet regardless of how small the OTHER labels
            were made). Line gap between the distance/bearing pair scales
            down with it so they don't collide once the font shrinks. */}
        {(() => {
          // Verified against the real 376-lot file (client req 2026-08-31,
          // "shared-edge labels drawn twice"): the shared-edge exclusion
          // above already produces zero duplicate/near-duplicate positions
          // — the reported pile-up was genuine density (600+ distinct
          // road-facing edges across the layout), not a dedup bug.
          //
          // A declutter pass was added on top of that (now reverted) —
          // passing an inflated fontSize to approximate the stacked
          // distance+bearing pair's real height also inflated the WIDTH
          // estimate declutterLabels derives from the same number (client
          // req 2026-08-31 follow-up: labels showing up "floating" tens of
          // metres from any real edge). With every candidate box reading
          // far wider than the actual text, ordinary crowding made the ring
          // search keep escalating outward past nearby collisions into
          // empty space well away from the true anchor. Reverted to plain
          // anchored rendering at the real edge midpoint — the font-size
          // tiering (further reduced here, client req 2026-08-31 "reduce
          // font size generally") is what actually resolves legibility at
          // density; decluttering wasn't needed and wasn't safe as wired.
          const dimFS = sheetDimLabels.length > 150 ? 2.2 : sheetDimLabels.length > 60 ? 3 : 4.5;
          const dimGap = dimFS + 1.5;
          return sheetDimLabels.map((d) => {
            const lx = t.sx(d.east, d.north), ly = t.sy(d.east, d.north);
            return (
              <g key={d.id} transform={`rotate(${d.angle + rotation} ${lx} ${ly})`}>
                <text x={lx} y={ly} textAnchor="middle" fontSize={dimFS} fill="#334155">{d.distance}</text>
                <text x={lx} y={ly + dimGap} textAnchor="middle" fontSize={dimFS} fill="#334155">{d.bearing}</text>
              </g>
            );
          });
        })()}
        {/* Sheet Index / Beacon Description / Splay Information / Ped Way,
            plus (General Plan mode) the Lot Numbers/Areas and Block Corner
            tables below it — select/move as one group (client req
            2026-09-01: "i should be able to drag this also"), same pattern
            as the title heading above. */}
        <g
          transform={`translate(${meta.panelOffset.dx},${meta.panelOffset.dy})`}
          style={{ cursor: panelSelected ? "move" : "pointer" }}
          onClick={handlePanelClick}
          onPointerDown={handlePanelPointerDown}
          onPointerMove={handlePanelPointerMove}
          onPointerUp={handlePanelPointerUp}
        >
          {panelSelected && (
            <rect
              x={panelX - 10} y={panelTop - 20}
              width={300} height={Math.max(panelBottom, rightColBottom) - panelTop + 30}
              fill="none" stroke="#dc2626" strokeWidth={0.8} strokeDasharray="2 2"
              style={{ pointerEvents: "none" }}
            />
          )}
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
        {sheetMode === "general" && (
          <>
            {/* Lot Areas table (client req 2026-08-27, §2f; bordered grid
                added 2026-09-01 to match the reference sheet's own boxed
                table exactly) — this sheet's own lots only, two side-by-side
                "LOT No. | SQ. METRES" column-pairs, sorted by lot number. */}
            <text x={690} y={lotTableTop} fontSize={11} fontWeight={700} fill="#0f172a">LOT AREAS</text>
            {(() => {
              const boxTop = lotTableTop + 5;
              const headerRuleY = lotTableTop + 20;
              const boxBottom = lotTableTop + 30 + rowsPerCol * lotRowH;
              return (
                <>
                  <rect x={tblL} y={boxTop} width={tblR - tblL} height={boxBottom - boxTop} fill="none" stroke="#0f172a" strokeWidth={0.7} />
                  <line x1={tblL} y1={headerRuleY} x2={tblR} y2={headerRuleY} stroke="#0f172a" strokeWidth={0.7} />
                  <line x1={vA} y1={boxTop} x2={vA} y2={boxBottom} stroke="#94a3b8" strokeWidth={0.5} />
                  <line x1={vMid} y1={boxTop} x2={vMid} y2={boxBottom} stroke="#0f172a" strokeWidth={0.7} />
                  <line x1={vB} y1={boxTop} x2={vB} y2={boxBottom} stroke="#94a3b8" strokeWidth={0.5} />
                </>
              );
            })()}
            {lotPairHeader(lotAR, sqmAR, lotTableTop + 16)}
            {lotPairHeader(lotBR, sqmBR, lotTableTop + 16)}
            {groupSortedPlots.slice(0, rowsPerCol).map((p, k) => {
              const y = lotTableTop + 30 + k * lotRowH;
              return (
                <g key={p.number}>
                  <text x={lotAR} y={y} textAnchor="end" fontSize={9} fill="#0f172a">{p.number || "(none)"}</text>
                  <text x={sqmAR} y={y} textAnchor="end" fontSize={9} fill="#0f172a">{p.fig.area_m2.toFixed(2)}</text>
                </g>
              );
            })}
            {groupSortedPlots.slice(rowsPerCol, maxLotRows).map((p, k) => {
              const y = lotTableTop + 30 + k * lotRowH;
              return (
                <g key={p.number}>
                  <text x={lotBR} y={y} textAnchor="end" fontSize={9} fill="#0f172a">{p.number || "(none)"}</text>
                  <text x={sqmBR} y={y} textAnchor="end" fontSize={9} fill="#0f172a">{p.fig.area_m2.toFixed(2)}</text>
                </g>
              );
            })}
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
            {/* Block Corner Table (client req 2026-08-27, §2g; corrected
                2026-09-01 — client screenshot of the real reference sheet:
                "Block corner table shows coordinates of all points/beacons
                used to make polygons", not a special 3-plots-meet subset.
                findBlockCorners()/the on-drawing "BC1"/"BC2" markers were
                both built on that wrong assumption before any reference for
                this specific table existed to check against, and have been
                removed — this now lists every beacon actually used to build
                this sheet's own lots, same set `groupUsedBeacons` already
                computes for the drawing itself. */}
            {groupUsedBeacons.length > 0 && (() => {
              const bcTop = lotTableTop + 30 + rowsPerCol * lotRowH + (groupSortedPlots.length > maxLotRows ? 46 : 30);
              // Only as many rows as actually fit above the bottom band —
              // this table was previously uncapped and ran off the sheet once
              // a real layout produced more beacons than fit (client req
              // 2026-08-30). Same "+N more … see digital schedule" overflow
              // note the Lot Areas table above uses — every beacon still
              // appears in full on the paginated Coordinate Schedule pages.
              const bcRowsFit = Math.max(0, Math.floor((rightColBottom - (bcTop + 56)) / BC_ROW_H));
              // Not even the heading fits — drop the section entirely rather
              // than spilling it past the frame; the coordinates stay in the
              // DXF and the digital record either way.
              if (bcTop + 56 > rightColBottom) return null;
              const bcSorted = [...groupUsedBeacons].sort((a, b) => comparePointNames(a.id, b.id));
              const bcOverflow = bcSorted.length > bcRowsFit;
              const bcShown = bcSorted.slice(0, Math.max(0, bcOverflow ? bcRowsFit - 1 : bcRowsFit));
              return (
                <>
                  <text x={690} y={bcTop} fontSize={11} fontWeight={700} fill="#0f172a">BLOCK CORNER TABLE</text>
                  <text x={690} y={bcTop + 15} fontSize={9} fontWeight={600}>SYSTEM {fmtSystem(config.coordinateSystem)} CO-ORDINATES (metres)</text>
                  <text x={745} y={bcTop + 28} fontSize={9} fontWeight={600} fill="#475569">Y</text>
                  <text x={845} y={bcTop + 28} fontSize={9} fontWeight={600} fill="#475569">X</text>
                  <text x={690} y={bcTop + 42} fontSize={8} fill="#475569">CONSTANTS</text>
                  <text x={745} y={bcTop + 42} fontSize={8} fill="#475569">+0,00</text>
                  <text x={845} y={bcTop + 42} fontSize={8} fill="#475569">+0,00</text>
                  {bcShown.map((b, k) => {
                    const y = bcTop + 56 + k * BC_ROW_H;
                    return (
                      <g key={b.id}>
                        <text x={690} y={y} fontSize={8.5} fill="#0f172a">{b.id}</text>
                        <text x={745} y={y} fontSize={8.5} fill="#0f172a">{fmtCoord(b.east)}</text>
                        <text x={845} y={y} fontSize={8.5} fill="#0f172a">{fmtCoord(b.north)}</text>
                      </g>
                    );
                  })}
                  {bcSorted.length > bcShown.length && (
                    <text x={690} y={bcTop + 56 + bcShown.length * BC_ROW_H} fontSize={8} fill="#94a3b8">
                      +{bcSorted.length - bcShown.length} more beacon(s) — see digital schedule
                    </text>
                  )}
                </>
              );
            })()}
          </>
        )}
        </g>
        {/* Bottom traverse table (client req 2026-08-27, §2h) — the WHOLE
            layout's outer boundary + grand total, sheet 1 only (it's not a
            per-sheet concept); other sheets point back to it. NOT part of
            the draggable panel group above — this is a full-width bottom
            band, not the right-side column. */}
        {sheetMode === "general" ? (
          <>
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
                // The outer-boundary traverse table itself needs one clean
                // connected ring to walk — when the layout doesn't form one
                // (a gap, an unmatched edge), just the total area still
                // prints, without the technical explanation of why the
                // table above it is empty (client req 2026-08-31: crossed
                // out on the reference redline, "remove the other
                // statement").
                cogoPlots.length > 0 && (
                  <text x={30} y={FY1 + 58} fontSize={12} fontWeight={700} fill="#0f172a">
                    TOTAL AREA = {grandTotalHa.toFixed(4)} Ha
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
          <Field label="Portions of Lot (parent lot no.)"><Input value={meta.parentLotNumber} onChange={set("parentLotNumber")} placeholder="e.g. 14182" /></Field>
          <Field label="Tribal area"><Input value={meta.tribalArea} onChange={set("tribalArea")} placeholder="e.g. GHANZI" /></Field>
          {sheetMode === "general" && (
            <Field label="Vide diagram DSM No. (parent diagram)"><Input value={meta.parentDsmNo} onChange={set("parentDsmNo")} placeholder="e.g. 1243/2026" /></Field>
          )}
        </div>
        <p className="mt-1 text-xs text-slate-400">
          Fill in "Portions of Lot" / "Tribal area" / "Vide diagram DSM No." to add the matching title lines
          ("LOTS {lotRangeText || "…"} {meta.name}" / "PORTIONS OF LOT {meta.parentLotNumber || "…"} {meta.name}" /
          "SITUATE AT {meta.location || meta.name} IN THE {meta.tribalArea || "…"} TRIBAL AREA") — leave any of them
          blank to keep today's shorter title.
        </p>
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
            {/* Distinguishes the drawing sheets from the coordinate-schedule
                appendix pages (client req 2026-08-31) — "Sheet 1 of 12" reads
                as 12 drawing sheets when really it's 1 layout sheet + 11
                beacon-coordinate list pages (every distinct beacon needs a
                row somewhere; COORDS_PER_SHEET=48 rows/page), which isn't a
                pagination bug, just an unlabelled appendix. */}
            <span className="text-slate-600">
              {sheet < layoutSheetCount
                ? `Layout Sheet ${sheet + 1} of ${layoutSheetCount}`
                : `Coordinate Schedule ${sheet - layoutSheetCount + 1} of ${coordChunks.length}`}
            </span>
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
                setAddingBoundaryLabel(false);
                setSelectedLabel(null);
              }}
            >
              {addingRoadLabel ? "Click where it should go…" : "Add Road Label"}
            </Button>
            <Button
              variant={addingBoundaryLabel ? "primary" : "ghost"}
              onClick={() => {
                setAddingBoundaryLabel((v) => !v);
                setAddingRoadLabel(false);
                setSelectedLabel(null);
              }}
              title='For labels like "REMAINDER OF CADASTRE 243" along a boundary — pre-fills the parent lot number from "Portions of Lot" above if set'
            >
              {addingBoundaryLabel ? "Click where it should go…" : "Add Boundary Label"}
            </Button>
            {selectedLabel && (
              <Button variant="ghost" onClick={deleteSelectedLabel}>✕ Delete selected label</Button>
            )}
            <Button
              variant="ghost"
              onClick={() => setConfig({ displayRotation: ((config.displayRotation ?? 0) + 90) % 360 })}
              title="Each sheet is scaled to fill the page as much as possible, but a real subdivision's own shape (taller than wide, or vice versa) doesn't always match the landscape page — rotating the drawing 90° at a time can close that gap and use more of the sheet."
            >
              Rotate 90°
            </Button>
            {/* Zoom (client req 2026-09-01: "zoom this GP only with a scroll
                button without moving the whole window") — mouse wheel over
                the sheet below zooms just this preview; +/- and Reset here
                do the same without needing to hover the sheet first. */}
            <span className="mx-1 h-5 w-px bg-slate-200" />
            <Button variant="ghost" onClick={() => setGpZoom((z) => Math.max(GP_ZOOM_MIN, +(z - 0.15).toFixed(2)))}>−</Button>
            <span className="w-12 text-center text-xs text-slate-600">{Math.round(gpZoom * 100)}%</span>
            <Button variant="ghost" onClick={() => setGpZoom((z) => Math.min(GP_ZOOM_MAX, +(z + 0.15).toFixed(2)))}>+</Button>
            {gpZoom !== 1 && (
              <Button variant="ghost" onClick={() => setGpZoom(1)}>Reset zoom</Button>
            )}
            <span className="text-xs text-slate-400">Drag a label to move it; double-click to edit its text. Scroll over the sheet to zoom.</span>
          </div>
        )}
        {/* Render all sheets (so refs exist for print-all); show only the active one.
            Scroll-wheel zoom is scoped to this box — preventDefault on the wheel
            event stops it from also scrolling the page itself (client req
            2026-09-01: "without moving the whole window"). overflow-auto lets the
            user pan around the sheet with the browser's own scrollbars once
            zoomed past what fits. */}
        <div
          className="overflow-auto rounded border border-slate-100"
          style={{ maxHeight: "82vh" }}
          onWheel={(e) => {
            e.preventDefault();
            setGpZoom((z) => Math.max(GP_ZOOM_MIN, Math.min(GP_ZOOM_MAX, +(z + (e.deltaY < 0 ? 0.1 : -0.1)).toFixed(2))));
          }}
        >
        <div className="relative mx-auto max-w-5xl" style={{ transform: `scale(${gpZoom})`, transformOrigin: "top center" }}>
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
        </div>
      </Card>
    </div>
  );
}
