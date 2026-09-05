"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useStore } from "@/lib/store";
import { Button, Card, Field, Input } from "@/components/ui";
import { displayCrs } from "@/lib/crsOptions";
import { dedupePoints, dropClosingDuplicate, findOuterBoundary, formatLotRange, sameWorldPoint, type Plot } from "@/lib/plots";
import { comparePointNames } from "@/lib/reportFormats";
import { fmtCoord, fmtSystem, toDotted } from "@/lib/diagramLayout";
import { inverse } from "@/lib/server/geometry";
import { formatDms } from "@/lib/server/angles";
import { type ManualText } from "@/components/SgDiagram";
import { writeDxf, type ImportedDrawing } from "@/lib/dxf";

const COORDS_PER_SHEET = 48;
const W = 1000;
const H = 707; // A4 landscape ratio
// This sheet represents a real A0 page: W (1000 SVG units) = 118.9cm =
// 1189mm of actual paper width. Used to draw at a true chosen plan scale
// (client req 2026-09-02) instead of always fitting the box.
const UNITS_PER_MM = W / 1189;
// Main-drawing text sized as a GROUND distance, drawn through the same true
// plan-scale factor (`t.s`, from computeTransform) the plots themselves are
// drawn through — client req 2026-09-04 (round 2): a fixed print-mm size
// (the first attempt, keyed to UNITS_PER_MM alone) stayed the same absolute
// size no matter what plan scale (meta.scale) was chosen, so it looked
// right at one scale and oversized/undersized at any other: "I think the
// text should be propossional to the polygon. ones i change scale, text
// should also change scale with polygons." Multiplying a ground-metre
// constant by `t.s` keeps text at a CONSTANT proportion to the plots'
// own drawn size at every scale, the same way the plots' own edges do —
// `fontSize(scale) = GROUND_M * t.s(scale)`, exactly how `t.sx`/`t.sy`
// convert a ground distance into this sheet's SVG units for the geometry
// itself. (The earlier, since-superseded density tiering this replaced is
// documented on the two call-site comments below.)
const LOT_NUMBER_GROUND_M = 1.8;
const EDGE_TEXT_GROUND_M = 1.3;
// Floors under the ground-metre sizing above (client req 2026-09-04, round
// 3: "itna zoom karne ke baad bi nahi dikh raha text" — a real subdivision
// spanning a wide geographic area within one sheet can still legitimately
// need a very small true-scale factor even at a sane, valid plan scale, at
// which point pure ground-metre proportionality shrinks text toward
// invisible. These floors keep every label legible no matter how small the
// sheet's own drawn scale gets, at the cost of exact proportionality only
// in that extreme case.
const MIN_LOT_NUMBER_FS = 3;
const MIN_EDGE_TEXT_FS = 2.2;
// Section headings (SHEET INDEX / BEACON DESCRIPTION / SPLAY INFORMATION /
// PED WAY / LOT AREAS / BLOCK CORNER TABLE) a size step above their own
// body/value text (client req 2026-09-05, screenshot arrowing each one:
// "Maybe make headings 2m") — same ground-metre-times-true-scale formula,
// just a bigger ground distance and its own proportionally bigger floor so
// it doesn't collapse to the SAME floor as the body text it's meant to
// stand out from once the scale factor gets small enough that floors
// dominate (the common case at a normal plan scale).
const PANEL_HEADING_GROUND_M = 2;
const MIN_PANEL_HEADING_FS = 3.5;
// Title heading/subheading (client req 2026-09-05: "General Plan= make 13,
// All other information under =make 10 (By Default.) They will change
// propositionally with Scale" — replacing the previous fixed 19/11/10
// sizes, none of which tracked plan scale at all, only the user's own
// manual title +/- resize). Same ground-metre-floor pattern as the panel
// text above; the ground-metre side only matters at a very fine plan
// scale, same as everywhere else it's used.
const MIN_TITLE_FS = 13;
const TITLE_GROUND_M = 8;
const MIN_SUBTITLE_FS = 10;
const SUBTITLE_GROUND_M = 6;

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
  // Pan (client req 2026-09-02: "pan with down press the scroll button") —
  // press-and-hold the mouse's middle/scroll-wheel button and drag, the same
  // convention CAD viewers use. Drives the zoom box's own scrollLeft/Top
  // directly rather than a separate offset state, since overflow-auto
  // already gives it real scrollable range once gpZoom > 1.
  const panBoxRef = useRef<HTMLDivElement | null>(null);
  const panStartRef = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  function handlePanMouseDown(e: ReactMouseEvent<HTMLDivElement>) {
    if (e.button !== 1) return; // middle button only — left click still selects/places labels normally
    e.preventDefault();
    const box = panBoxRef.current;
    if (!box) return;
    panStartRef.current = { x: e.clientX, y: e.clientY, scrollLeft: box.scrollLeft, scrollTop: box.scrollTop };
    setIsPanning(true);
  }
  useEffect(() => {
    if (!isPanning) return;
    function onMove(e: MouseEvent) {
      const start = panStartRef.current;
      const box = panBoxRef.current;
      if (!start || !box) return;
      box.scrollLeft = start.scrollLeft - (e.clientX - start.x);
      box.scrollTop = start.scrollTop - (e.clientY - start.y);
    }
    function onUp() {
      panStartRef.current = null;
      setIsPanning(false);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isPanning]);
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
    () => cogoPlots.map((p) => ({ number: p.number, points: dropClosingDuplicate(p.fig.points) })),
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
    panelOffsets: Record<string, { dx: number; dy: number }>;
    panelScales: Record<string, number>;
    lotTableCols: number;
    gridSpacingM: number;
  }> | null;
  const [meta, setMeta] = useState({
    name: config.name && config.name !== "Untitled Survey" ? config.name.toUpperCase() : "TOWNSHIP LAYOUT",
    location: "",
    surveyor: config.surveyor ? config.surveyor.toUpperCase() : "",
    gpNo: "",
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
    // Select/move for the right-side reference panel sections + Lot Areas/
    // Block Corner tables — EACH ONE independently (client req 2026-09-02:
    // "group these features independently... dont just group all of them" —
    // an earlier round moved everything as one block, which the client
    // corrected). Keyed by section id ("sheetIndex"/"beaconDesc"/"splay"/
    // "pedWay"/"lotAreas"/"blockCorner"); a section with no entry here just
    // renders at its default (un-dragged) position.
    panelOffsets: {} as Record<string, { dx: number; dy: number }>,
    // Per-section resize (client req 2026-09-04: "i also want to be able to
    // click and resize this" — same section ids as panelOffsets above,
    // scale factor around each section's own top-left corner so resizing
    // doesn't also drift its position).
    panelScales: {} as Record<string, number>,
    // How many "LOT No. | SQ. METRES" column-pairs the Lot Areas table uses
    // (client req 2026-09-02: "user should choose whether they want 1/2/3/4
    // columns") — was always exactly 2 (or 1 when everything fit in one).
    lotTableCols: 2,
    // Grid-mark spacing along the frame border, in real metres (client req
    // 2026-09-03: "the grid numbering should be multiples of 50. The grid
    // must space by 50m by default and the user can also choose if they
    // want to space by 100 or 200") — ticks used to just split the edge
    // into a fixed COUNT of even pixel intervals, landing on whatever
    // (non-round) coordinate happened to fall there; now they land on
    // actual round real-world multiples of this value instead.
    gridSpacingM: 50,
    ...(savedGp ?? {}),
    // Sanitises a scale value already saved from BEFORE the scale-field
    // fix above (client req 2026-09-04, round 3 — a huge "108" plot-number
    // label overflowing the whole sheet: the deferred-commit fix stops the
    // Scale field committing a garbage MID-TYPE value going forward, but a
    // project saved WHILE it was still showing "SCALE 1:2" keeps loading
    // that same 2 back in on every open, since it's a perfectly valid
    // positive number as far as the loader is concerned). No real plan
    // scale is ever this fine — floors it back to the sane default instead
    // of trusting a saved value under 1:50.
    scale: savedGp?.scale && savedGp.scale >= 50 ? savedGp.scale : 2000,
  });
  const set = (k: keyof typeof meta) => (v: string) => setMeta((m) => ({ ...m, [k]: v }));
  // "Scale 1:" is edited as its own local text buffer, committed to
  // meta.scale only on blur/Enter (client req 2026-09-04, ROUND 2 — the
  // first fix only stopped an EMPTY field collapsing to 0; a fully
  // controlled numeric input committing every keystroke straight into
  // meta.scale is the deeper problem, since the drawing renders at TRUE
  // scale off that same live number: typing "2000" digit by digit
  // transiently renders at 1:2, then 1:20, then 1:200, each one a
  // wildly wrong scale that can leave every plot far outside the visible
  // frame — exactly the "SCALE 1:2" / empty-looking sheet in the client's
  // follow-up screenshot, "still pots nahi dikh rahay"). Deferring the
  // commit means only a finished, deliberate value ever drives a render.
  const [scaleText, setScaleText] = useState(String(meta.scale));
  useEffect(() => setScaleText(String(meta.scale)), [meta.scale]);
  function commitScale() {
    const n = Number(scaleText);
    // Same >=50 floor the saved-data sanitiser above uses (client req
    // 2026-09-04, round 3) — blocks a deliberately-typed absurd value like
    // "10" from reproducing the giant-text-off-the-page bug live, not just
    // an already-corrupted saved one.
    if (Number.isFinite(n) && n >= 50) setMeta((m) => ({ ...m, scale: n }));
    else setScaleText(String(meta.scale));
  }
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
  const TITLE_EXTRA_LINE_H = 10; // client req 2026-09-05: "inke darmayan bi space reduce karo" (13 -> 10)
  // "OF" now runs on its own line under the main "GENERAL PLAN"/"WORKING
  // PLAN" heading (client req 2026-09-01 redline), pushing the "LOTS ...
  // {name}" line down from y=54 to y=66 — FY0's base shifts by the same 12
  // units so the drawing area still starts exactly as far below the title
  // as it did before this line moved.
  // Real A0 print margins (client req 2026-09-02, annotated drawing: outer
  // line = standard A0 paper 118.9 x 84.1cm, inner line = the drawn frame,
  // 7.5cm top/bottom/left, 23cm right — the wider right margin is this
  // reference's own convention, presumably for a binding/plotter edge).
  // UNITS_PER_CM converts real cm straight into this sheet's own SVG units
  // (W = 1000 units = 118.9cm, same basis UNITS_PER_MM above already uses).
  const UNITS_PER_CM = W / 118.9;
  const FRAME_MARGIN_TOP_CM = 7.5, FRAME_MARGIN_BOTTOM_CM = 7.5, FRAME_MARGIN_LEFT_CM = 7.5, FRAME_MARGIN_RIGHT_CM = 23;
  const FRAME_X = FRAME_MARGIN_LEFT_CM * UNITS_PER_CM;
  const FRAME_Y = FRAME_MARGIN_TOP_CM * UNITS_PER_CM;
  const FRAME_R = W - FRAME_MARGIN_RIGHT_CM * UNITS_PER_CM;
  const FRAME_B = H - FRAME_MARGIN_BOTTOM_CM * UNITS_PER_CM;
  // Old uniform 24-unit margin this whole template was previously laid out
  // against — every other absolute position below (drawing box, panel,
  // tables, title) is remapped from that old frame into the new one via
  // mapX/mapY, preserving each element's own relative position/spacing
  // instead of hand-recomputing dozens of numbers by hand. Row/line HEIGHTS
  // (lotRowH, BC_ROW_H, TITLE_EXTRA_LINE_H, panel row heights) stay
  // unscaled on purpose — those are font-driven, not frame-driven, and
  // shrinking them would make text disproportionately small relative to
  // its own row.
  const OLD_FRAME_X = 24, OLD_FRAME_Y = 24, OLD_FRAME_R = 976, OLD_FRAME_B = 683;
  const FRAME_SCALE_X = (FRAME_R - FRAME_X) / (OLD_FRAME_R - OLD_FRAME_X);
  const FRAME_SCALE_Y = (FRAME_B - FRAME_Y) / (OLD_FRAME_B - OLD_FRAME_Y);
  const mapX = (x: number) => FRAME_X + (x - OLD_FRAME_X) * FRAME_SCALE_X;
  const mapY = (y: number) => FRAME_Y + (y - OLD_FRAME_Y) * FRAME_SCALE_Y;
  // Client req 2026-09-02: "general plan heading ke niche se space kam karni
  // hai" — the gaps right under "GENERAL PLAN" (and before the drawing
  // starts) were previously frame-scaled positions (mapY(49), mapY(66),
  // mapY(102)), which compound the same way the rest of the template does;
  // these three specifically are now tight, fixed row-height offsets from
  // TITLE_Y1 instead, matching how every OTHER line-height in this file
  // (lotRowH, BC_ROW_H, TITLE_EXTRA_LINE_H itself) is already treated as
  // font-driven, not frame-driven. Optional lines (Portions of Lot/Tribal
  // Area) still only add their own row, and only their own space, when
  // actually filled in — extraTitleLines already only contains an entry
  // for a field that's set (see where it's built above), so FY0 never
  // reserves room for a subheading that isn't there.
  const TITLE_Y1 = mapY(34);
  const TITLE_OF_Y = TITLE_Y1 + 10, TITLE_LINE2_Y = TITLE_OF_Y + 10; // client req 2026-09-05: "inke darmayan bi space reduce karo" (13/14 -> 10/10)
  const FX0 = mapX(30), FY0 = TITLE_LINE2_Y + 22 + extraTitleLines.length * TITLE_EXTRA_LINE_H, FX1 = mapX(660), FY1 = mapY(H - 150);
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
    const fitScale = Math.min((FX1 - FX0 - 2 * pad) / spanX, (FY1 - FY0 - 2 * pad) / spanY);
    // Draw at the actual chosen scale (client req 2026-09-02: "when i change
    // the scale, then also the scale of the drawing changes, like you did
    // with the diagram") — same convention diagramLayout.ts's own
    // `10000 / meta.scale` already uses for the single-lot Diagram, adapted
    // to THIS sheet's own units (an A0 sheet: W SVG units = 118.9cm of real
    // paper, not that file's separate "10 units/mm" space). At plan scale
    // 1:N, 1 real metre draws as (1000/N) mm on paper; UNITS_PER_MM converts
    // that to this sheet's own SVG units. Falls back to fit-to-box only when
    // no scale has been set (matching the diagram's own fallback). A real
    // subdivision's true-scale extent can be larger than the drawing box —
    // same as a real printed A0 sheet, the scale is chosen so the whole
    // layout fits; if it doesn't, the sheet's own zoom-out/pan controls
    // (client req 2026-09-01/02) reach the rest, same as the diagram relies
    // on its own canvas pan/zoom for an oversized true-scale drawing.
    const s = meta.scale > 0 ? (1000 / meta.scale) * UNITS_PER_MM : fitScale;
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
    return { sx, sy, screenToWorld, bounds, s };
  }
  /** Sheet currently on screen, clamped to a valid layout-sheet index —
   *  drives which sheet's own transform the interaction handlers (click to
   *  place/edit a label) use, since only one sheet is visible at a time. */
  const activeGroupIdx = Math.min(sheet, layoutSheetCount - 1);
  const activeUsedBeacons = useMemo<GpBeacon[]>(
    () =>
      dedupePoints(layoutGroups[activeGroupIdx].map((p) => ({ number: p.number, points: dropClosingDuplicate(p.fig.points) })))
        .filter((p): p is { name: string; east: number; north: number } => !!p.name)
        .map((p) => ({ id: p.name, east: p.east, north: p.north })),
    [layoutGroups, activeGroupIdx]
  );
  const { sx, sy, screenToWorld } = computeTransform(activeUsedBeacons);

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

  // Select/move for the right-side reference panel — EACH section (Sheet
  // Index, Beacon Description, Splay Information, Ped Way, Lot Areas table,
  // Block Corner table) independently (client req 2026-09-02, correcting an
  // earlier round that moved them all as one block: "group these features
  // independently... dont just group all of them"). One selection/drag
  // state shared across all sections, keyed by section id, same pattern as
  // the title block above minus resize.
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);
  const [draggingPanel, setDraggingPanel] = useState<{ id: string; startSx: number; startSy: number; origDx: number; origDy: number } | null>(null);
  const panelDragMovedRef = useRef(false);
  function panelOffsetOf(id: string) {
    return meta.panelOffsets[id] ?? { dx: 0, dy: 0 };
  }
  function handlePanelClick(id: string, e: ReactMouseEvent<SVGElement>) {
    e.stopPropagation();
    if (panelDragMovedRef.current) { panelDragMovedRef.current = false; return; }
    setSelectedPanelId((s) => (s === id ? null : id));
  }
  function handlePanelPointerDown(id: string, e: ReactPointerEvent<SVGElement>) {
    if (selectedPanelId !== id) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = toSvgPoint(e);
    const orig = panelOffsetOf(id);
    setDraggingPanel({ id, startSx: p.x, startSy: p.y, origDx: orig.dx, origDy: orig.dy });
  }
  function handlePanelPointerMove(id: string, e: ReactPointerEvent<SVGElement>) {
    if (!draggingPanel || draggingPanel.id !== id) return;
    const p = toSvgPoint(e);
    const dx = p.x - draggingPanel.startSx, dy = p.y - draggingPanel.startSy;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) panelDragMovedRef.current = true;
    setMeta((m) => ({ ...m, panelOffsets: { ...m.panelOffsets, [id]: { dx: draggingPanel.origDx + dx, dy: draggingPanel.origDy + dy } } }));
  }
  function handlePanelPointerUp() {
    setDraggingPanel(null);
  }
  function cancelPanelDrag() {
    if (!draggingPanel) return;
    setMeta((m) => ({ ...m, panelOffsets: { ...m.panelOffsets, [draggingPanel.id]: { dx: draggingPanel.origDx, dy: draggingPanel.origDy } } }));
    setDraggingPanel(null);
  }
  useEffect(() => {
    if (!draggingPanel) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") cancelPanelDrag(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingPanel]);
  function panelScaleOf(id: string) {
    return meta.panelScales[id] ?? 1;
  }
  function handlePanelResize(id: string, delta: number) {
    setMeta((m) => ({
      ...m,
      panelScales: { ...m.panelScales, [id]: Math.max(0.5, Math.min(2.5, (m.panelScales[id] ?? 1) + delta)) },
    }));
  }
  /** One independently draggable + resizable panel section, keyed by id —
   *  used by every right-side panel group below instead of each repeating
   *  its own drag props + hit-rect + selection outline + resize buttons
   *  (client req 2026-09-04: "i also want to be able to click and resize
   *  this"). `box` is that section's own bounding rect in LOCAL (pre-scale)
   *  coordinates — content is scaled around box's top-left corner so
   *  resizing never also shifts the section's drag position. Resize
   *  buttons live in the outer (translate-only) group so their own size
   *  stays constant regardless of the section's current scale. */
  function panelResizable(id: string, box: { x: number; y: number; w: number; h: number }, content: ReactNode) {
    const off = panelOffsetOf(id);
    const scale = panelScaleOf(id);
    const selected = selectedPanelId === id;
    const rightEdge = box.x + box.w * scale;
    return (
      <g
        key={id}
        transform={`translate(${off.dx},${off.dy})`}
        style={{ cursor: selected ? "move" : "pointer" }}
        onClick={(e: ReactMouseEvent<SVGElement>) => handlePanelClick(id, e)}
        onPointerDown={(e: ReactPointerEvent<SVGElement>) => handlePanelPointerDown(id, e)}
        onPointerMove={(e: ReactPointerEvent<SVGElement>) => handlePanelPointerMove(id, e)}
        onPointerUp={handlePanelPointerUp}
      >
        <g transform={`translate(${box.x * (1 - scale)},${box.y * (1 - scale)}) scale(${scale})`}>
          {/* Invisible hit-area covering the section's own box (client req
              2026-09-02) — an SVG <g> has no geometry of its own, so a
              click landing in the blank space between sparse text/table
              grid lines would otherwise fall through to the canvas below.
              fill="transparent" (not "none") keeps it clickable. */}
          <rect x={box.x} y={box.y} width={box.w} height={box.h} fill="transparent" />
          {selected && (
            <rect
              x={box.x} y={box.y} width={box.w} height={box.h}
              fill="none" stroke="#dc2626" strokeWidth={0.8 / scale} strokeDasharray={`${2 / scale} ${2 / scale}`}
              style={{ pointerEvents: "none" }}
            />
          )}
          {content}
        </g>
        {selected && (
          <>
            <g style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); handlePanelResize(id, 0.1); }}>
              <circle cx={rightEdge + 12} cy={box.y + 14} r={7} fill="white" stroke="#dc2626" strokeWidth={1} />
              <text x={rightEdge + 12} y={box.y + 17} textAnchor="middle" fontSize={10} fill="#dc2626">+</text>
            </g>
            <g style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); handlePanelResize(id, -0.1); }}>
              <circle cx={rightEdge + 12} cy={box.y + 32} r={7} fill="white" stroke="#dc2626" strokeWidth={1} />
              <text x={rightEdge + 12} y={box.y + 35} textAnchor="middle" fontSize={10} fill="#dc2626">−</text>
            </g>
          </>
        )}
      </g>
    );
  }

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
    setSelectedPanelId(null);
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

    text(W / 2, TITLE_Y1, `${sheetMode === "working" ? "WORKING" : "GENERAL"} PLAN`, MIN_TITLE_FS, "middle");
    text(W / 2, TITLE_OF_Y, "OF", MIN_SUBTITLE_FS, "middle");
    text(
      W / 2, TITLE_LINE2_Y,
      lotRangeText
        ? `LOTS ${lotRangeText} ${meta.name}`
        : `Layout of ${layoutGroups[activeGroupIdx].length} parcel(s)${meta.name ? ` ${meta.name}` : ""}${meta.location ? ` — ${meta.location}` : ""}`,
      MIN_SUBTITLE_FS, "middle"
    );
    extraTitleLines.forEach((ln, i) => text(W / 2, TITLE_LINE2_Y + (i + 1) * TITLE_EXTRA_LINE_H, ln, MIN_SUBTITLE_FS, "middle"));
    // Registration box (GC-No/SHEET-No/DSM-No/Surveyed-in/By-me/Land-Surveyor)
    // stays in sync with the SVG preview above — General Plan only, absent
    // from the real Working Plan reference sheet.
    if (sheetMode === "general") {
      text(regX, mapY(18), `GC-${meta.gcNo || "—"}`, 7);
      text(regX + regW, mapY(18), `SHEET No - ${activeGroupIdx + 1} of ${sheetCount}`, 7, "end");
      text(regX + 6 * regScale, regY + 24 * regScale, `DSM No: ${meta.dsmNo || "—"}`, 9.5 * regScale);
      text(regX + 6 * regScale, regY + 100 * regScale, "Surveyed in", 8 * regScale);
      text(regX + regW - 6 * regScale, regY + 100 * regScale, meta.surveyedIn || "—", 8 * regScale, "end");
      text(regX + 6 * regScale, regY + 114 * regScale, "By me", 8 * regScale);
      text(regX + regW - 6 * regScale, regY + 138 * regScale, meta.surveyor || "—", 8 * regScale, "end");
      text(regX + regW - 6 * regScale, regY + 150 * regScale, "Land Surveyor", 7 * regScale, "end");
    }
    text(mapX(W - 20), mapY(H - 16), `SR No: ${meta.srNo || "—"}`, 9, "end");

    const groupGpPlots: Plot[] = layoutGroups[activeGroupIdx].map((p) => ({ number: p.number, points: dropClosingDuplicate(p.fig.points) }));
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
  // border. FRAME_R/FRAME_B are the border's right/bottom edges (defined
  // above FX0 etc. now, alongside mapX/mapY — see that block's own comment).
  // Bigger + labelled (client req 2026-09-01, redline circling the top/left
  // ticks: "increase size of grid marks and add labels") — a plain unlabelled
  // tick doesn't tell a reader what coordinate it's actually at; the
  // reference sheet's own grid marks carry their real Y/X (east/north)
  // value. 10 -> 16 for the tick length itself.
  const TICK = 16; // grid-tick length (client req 2026-09-01: "increase size of grid marks" — was 10)
  const GRID_LABEL_FS = 3; // client req 2026-09-05: "lines ka font kam karo" (4 -> 3)
  // Grid spacing, clamped to the 3 real choices offered (client req
  // 2026-09-03) — a stray/legacy meta value never breaks the tick math.
  const gridSpacingM = [50, 100, 200].includes(meta.gridSpacingM) ? meta.gridSpacingM : 50;
  /** One row of tick marks along a border edge, projecting outward (into
   *  the margin) rather than inward onto the drawing. When `worldAt` is
   *  given, ticks land on actual round real-world multiples of
   *  `gridSpacingM` (client req 2026-09-03: "the grid numbering should be
   *  multiples of 50... user can also choose 100 or 200") instead of an
   *  even pixel split of the edge — `worldAt` at the edge's own two
   *  endpoints gives the real coordinate range it spans; every round
   *  multiple of the spacing within that range gets a tick, placed by
   *  linearly interpolating along the edge (correct even under display
   *  rotation, since a straight edge maps to a straight edge under any
   *  such transform). Falls back to a fixed 6-tick even split when there's
   *  no transform to invert (the coordinate-schedule appendix pages, which
   *  have no drawing for a coordinate grid to correlate to). Each tick is
   *  labelled with the real Y (east, on horizontal top/bottom edges) or X
   *  (north, on vertical left/right edges) — same "Y"/"X" naming the Block
   *  Corner Table already uses for this coordinate system. */
  function edgeTicks(
    fixed: number, from: number, to: number, horizontal: boolean, out: number,
    worldAt?: (px: number, py: number) => { east: number; north: number }
  ) {
    const lines: ReactNode[] = [];
    const dir = out > 0 ? 1 : -1;
    function drawTick(key: string | number, t: number, labelText: string | null) {
      const x1 = horizontal ? t : fixed, y1 = horizontal ? fixed : t;
      const x2 = horizontal ? t : fixed + out, y2 = horizontal ? fixed + out : t;
      lines.push(<line key={key} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#0f172a" strokeWidth={1} />);
      if (labelText != null) {
        // Same fix, both axes (client req 2026-09-05: "top ur bottom walao
        // ko bi karo" — extended the left/right fix above to top/bottom
        // too). The label sits on a DIFFERENT axis entirely from its own
        // tick — offset a fixed gap to the side of it, rather than further
        // along the same line the tick occupies — which is what actually
        // guarantees no crossing at any label length, since the two no
        // longer share a coordinate axis to cross on. The other coordinate
        // stays near the tick's own start (just past the border), running
        // in the tick's own inward direction, not past its far tip.
        // Vertical edges (left/right): tick is HORIZONTAL at y=t, so the
        // label's own perpendicular offset is in y (sits above the tick).
        // Horizontal edges (top/bottom): tick is VERTICAL at x=t, rotated
        // labels (client req 2026-09-04, "inline with the grid line"), so
        // the perpendicular offset is in x instead (sits beside the tick).
        const GRID_LABEL_GAP = 3; // client req 2026-09-05: "lables ki jo lines hain ur jo numbers hain inke darmayan space reduce karo" (6 -> 3)
        let lx: number, ly: number, anchor: "start" | "end";
        if (horizontal) {
          lx = t - GRID_LABEL_GAP;
          ly = fixed + dir * 4;
          anchor = dir > 0 ? "end" : "start";
        } else {
          lx = fixed + dir * 4;
          ly = t - GRID_LABEL_GAP;
          anchor = dir > 0 ? "start" : "end";
        }
        lines.push(
          <text
            key={`l${key}`}
            x={lx} y={ly}
            fontSize={GRID_LABEL_FS}
            textAnchor={anchor}
            fill="#475569"
            transform={horizontal ? `rotate(-90 ${lx} ${ly})` : undefined}
          >
            {labelText}
          </text>
        );
      }
    }
    if (!worldAt) {
      const count = 6;
      for (let i = 0; i <= count; i++) drawTick(i, from + ((to - from) * i) / count, null);
      return lines;
    }
    const wFrom = worldAt(horizontal ? from : fixed, horizontal ? fixed : from);
    const wTo = worldAt(horizontal ? to : fixed, horizontal ? fixed : to);
    const vFrom = horizontal ? wFrom.east : wFrom.north;
    const vTo = horizontal ? wTo.east : wTo.north;
    const vMin = Math.min(vFrom, vTo), vMax = Math.max(vFrom, vTo);
    const first = Math.ceil(vMin / gridSpacingM) * gridSpacingM;
    // Safety cap (client req 2026-09-03's own spacing choice can combine
    // with a very zoomed-out true scale — computeTransform's own client
    // req 2026-09-02 — to make the frame's own full-width real-world span
    // huge; a tiny spacing over a huge span would otherwise spam hundreds
    // of ticks). Silently truncates rather than auto-widening the user's
    // own chosen spacing.
    const MAX_TICKS = 40;
    // Skipped this close to either end of the edge — the frame's own
    // corner, where the border already turns a right angle right there —
    // (client req 2026-09-05, screenshot with an X over the top-left
    // corner: "delete the grid marks which are very close to the corner").
    const CORNER_MARGIN = 25;
    for (let v = first, n = 0; v <= vMax && n < MAX_TICKS; v += gridSpacingM, n++) {
      const frac = (v - vFrom) / (vTo - vFrom || 1);
      const t = from + (to - from) * frac;
      if (Math.abs(t - from) < CORNER_MARGIN || Math.abs(t - to) < CORNER_MARGIN) continue;
      drawTick(v, t, `${horizontal ? "Y" : "X"}+${Math.round(v)}`);
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
  // Grew to 164 for a while (client req 2026-09-02: "the surveyor must sign
  // there... move [the name] and Land Surveyor a bit down to create space")
  // — the printed name sat directly on the same line as "By me" with no
  // room for an actual pen signature between them. Client req 2026-09-05
  // put a ruler on it and re-drew the exact 10cm-by-10cm redline this box
  // started from: "make sure its 10cm by 10 cm". True size now, via the
  // same UNITS_PER_CM conversion the frame margins use — regScale below
  // shrinks the box's own internal row spacing/font sizes by the same
  // ratio this is smaller than the old 164, so the layout (including the
  // 2026-09-02 signature gap) stays proportionally the same, just smaller,
  // instead of overflowing the now-smaller box.
  const regSize = 10 * UNITS_PER_CM;
  const regScale = regSize / 164;
  const regX = FRAME_R - regSize, regY = FRAME_Y;
  const regW = regSize;

  // Right-side reference panel (client req 2026-08-27, §2e): Sheet Index,
  // Beacon Description, Splay Information, Ped Way — sits between the
  // registration block above (ends y=146) and the parcel schedule below.
  // Sheet Index is a single trivial entry for now (real multi-sheet splitting
  // is a later phase); the numeric lot range is derived straight from the
  // numbered COGO plots when their numbers are numeric.
  // panelTop derived straight from the registration box's own bottom edge
  // (regY + regSize) rather than an independent magic number — the box
  // grew taller for signature room (client req 2026-09-02) and a fixed
  // literal here would silently start overlapping it again the next time
  // regSize changes.
  const panelX = mapX(690), panelTop = regY + regSize + 15;
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
  //
  // Each section is its OWN independently-draggable group (client req
  // 2026-09-02, correcting an earlier round that moved the whole panel as
  // one block: "group these features independently... dont just group all
  // of them") — laid out sequentially top-to-bottom for its DEFAULT
  // (un-dragged) position, same flow the old single merged list used, but
  // each section's own `startY` is a separate anchor a per-section
  // panelOffsets[id] can move independently of the others.
  interface PanelSection { id: string; rows: { text: string; heading?: boolean }[] }
  const panelSections: PanelSection[] = [
    ...(sheetMode === "general"
      ? [{ id: "sheetIndex", rows: [{ text: "SHEET INDEX", heading: true }, ...shownSheetIndex.map((text) => ({ text }))] }]
      : []),
    { id: "beaconDesc", rows: [{ text: "BEACON DESCRIPTION", heading: true }, { text: meta.beaconDescription || "—" }] },
    {
      id: "splay",
      rows: [
        { text: "SPLAY INFORMATION", heading: true },
        ...meta.splayEntries
          .filter((e) => e.corner.trim() || e.distance.trim())
          .map((e) => ({ text: `${e.corner || "—"}: ${e.distance || "—"}` })),
      ],
    },
    { id: "pedWay", rows: [{ text: "PED WAY", heading: true }, { text: meta.pedWay || "—" }] },
  ];
  let panelCursorY = panelTop;
  const panelSectionLayouts = panelSections.map((section, si) => {
    if (si > 0) panelCursorY += 3; // client req 2026-09-05: "inke daramayan space ur reduce karo" (6 -> 3)
    const rowYs = section.rows.map((row) => {
      const y = panelCursorY;
      // Heading's own line-height reduced (client req 2026-09-05,
      // screenshot bracketing the gap under each of "SHEET INDEX"/"BEACON
      // DESCRIPTION"/"SPLAY INFORMATION"/"PED WAY": "inke darmaaya space
      // reduce karo heading ur text ke darmayan" — this value is the gap
      // BEFORE the row that follows it, so a heading row's own 14 is what
      // set the distance down to its own content line beneath it). Content-
      // row and between-section spacing left untouched, per "kuch bi
      // disturb na karna."
      panelCursorY += row.heading ? 10 : 12;
      return y;
    });
    return { ...section, rowYs };
  });
  const panelBottom = panelCursorY + 6;

  // Lot Numbers / Areas table (client req 2026-08-27, §2f): two side-by-side
  // "LOT NUMBERS | SQ. METRES" column-pairs (matching the reference sheet),
  // sorted by lot number (via the shared `sortedPlots` computed above,
  // sliced per sheet by `layoutGroups`), replacing the old single-column
  // capped schedule — fitting roughly twice as many rows in the same space.
  const lotTableTop = panelBottom + 16;
  // Row height is DEFAULT_LOT_ROW_H unless a sheet's own lot count needs it
  // shrunk to fit within the user's chosen column count (see the per-sheet
  // block below, client req 2026-09-03) — no longer a fixed component-level
  // value. Row cap is computed from actual remaining room (not fixed) — the
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
  const BC_ROW_H = 9; // client req 2026-09-05: "reduce spacing... make them close like that" (13 -> 9)
  // What the Block Corner Table would need if every beacon were listed,
  // clamped to at most half the column so the Lot Areas table above always
  // keeps usable room no matter how many beacons the layout produces.
  const bcReserve =
    usedBeacons.length > 0
      ? Math.min(70 + usedBeacons.length * BC_ROW_H, Math.floor(rightColH * 0.5))
      : 30;
  // Room the lot table needs below its last row (client req 2026-09-02: the
  // "SHEET TOTAL"/"TOTAL AREA" line and the "+N more lot(s)... see digital
  // schedule" note both removed — screenshot, both crossed out, "ye jo show
  // ho raha hai ye hattana hai bs" — a small fixed gap is all that's left
  // to reserve here now, not room for either line's own text).
  const LOT_FOOTER_H = 12;
  const availableLotH = Math.max(0, rightColH - bcReserve - LOT_FOOTER_H);
  const DEFAULT_LOT_ROW_H = 10, MIN_LOT_ROW_H = 6; // client req 2026-09-05: "reduce table and spacing" (14 -> 10, matching the Block Corner Table's own just-tightened row spacing)
  // How many "LOT No. | SQ. METRES" column-pairs (client req 2026-09-02:
  // "for tables i think the user should choose whether they want 1/2/3/4
  // columns" — was always fixed at 2, or 1 when everything fit in one).
  // A STYLE preference for how wide to spread lots that already fit — see
  // usedLotCols below (client req 2026-09-03) for why it's never a hard cap
  // that can drop real lots from the table.
  const lotTableCols = Math.max(1, Math.min(4, Math.round(meta.lotTableCols) || 2));
  // Bordered grid — outer box, header underline, and a vertical rule between
  // every column, matching the reference sheet's own boxed "LOT AREAS" table
  // exactly (client req 2026-09-01, screenshot: "put lot areas in a table
  // like that" — was plain floating text with no lines at all before).
  const tblL = mapX(685), tblR = mapX(975);
  /** Column-pair geometry for `cols` columns spread across the table's own
   *  fixed width — a function of `cols` (not a fixed component-level
   *  value) because a sheet can end up needing MORE columns than
   *  lotTableCols configures (client req 2026-09-03, see usedLotCols
   *  below); whatever that real count turns out to be, the columns must
   *  still fit inside tblL..tblR, never overflow past it.
   *  Capped at half the table width when only 1-2 columns are actually
   *  needed (client req 2026-09-03, screenshot: a 1-column table stretched
   *  "LOT No." and "SQ. METRES" apart across the WHOLE table width — a
   *  reasonable column-pair width never exceeds what the original
   *  2-column layout already used comfortably). Each pair's own "LOT No."
   *  sub-column gets ~42% of the pair's width, "SQ. METRES" the rest —
   *  same proportion the original fixed 2-column layout used. Left-
   *  aligned (client req 2026-09-03: "these table values should be left
   *  align" — was right-aligned against each sub-column's own right edge,
   *  which read as a dead gap in the middle of a wide pair). */
  function computeLotColBounds(cols: number) {
    // Each column-pair's own width no longer grows just because fewer
    // columns were picked (client req 2026-09-05, two screenshots: "jab
    // option 2 per click karta hon tu inki width ziadah hoti hai ur jab 4
    // per karta hon tu width theak hoti hai" — width used to be the full
    // table width split among `cols` pairs, so 2 columns each got roughly
    // twice the width 4 columns did). Width is now computed as if there
    // were always at least 4 pairs sharing the table's width, so picking
    // 1-3 columns keeps each pair the same size 4 columns already gets
    // right — it just uses fewer of them (and a narrower total table),
    // not wider ones.
    const pairW = Math.min((tblR - tblL) / 2, (tblR - tblL) / Math.max(cols, 4)) * 0.7;
    return Array.from({ length: cols }, (_, i) => {
      const left = tblL + i * pairW;
      const right = tblL + (i + 1) * pairW;
      const divider = left + pairW * 0.42;
      return { left, right, divider, lotColL: left + 6, sqmColL: divider + 6 };
    });
  }
  /** Header/value text sized (and, past 2 columns, abbreviated) to what each
   *  column-pair's own width can actually hold at `cols` columns (client
   *  req 2026-09-02, screenshot: picking 4 columns made "LOT No."/
   *  "SQ. METRES" overlap the next column-pair — the fixed 9.5px header
   *  was sized for a 2-column pair ~113 units wide, not a 4-column one
   *  ~57 units wide). Verified against the real column widths at each
   *  tier before picking these. A function of the sheet's own ACTUAL
   *  column count, not the configured preference, since a sheet can end
   *  up rendering more/narrower columns than configured (see usedLotCols). */
  function lotFontsFor(cols: number) {
    return {
      headerFS: cols >= 4 ? 6.5 : cols === 3 ? 7.5 : 9.5,
      valueFS: cols >= 4 ? 7 : cols === 3 ? 8 : 9,
      lotLabel: cols >= 4 ? "LOT" : "LOT No.",
      sqmLabel: cols >= 3 ? "SQ.M" : "SQ. METRES",
    };
  }
  function lotPairHeader(lotColL: number, sqmColL: number, y: number, headerFS: number, lotLabel: string, sqmLabel: string) {
    return (
      <>
        <text x={lotColL} y={y} textAnchor="start" fontSize={headerFS} fontWeight={700} fill="#475569">{lotLabel}</text>
        <text x={sqmColL} y={y} textAnchor="start" fontSize={headerFS} fontWeight={700} fill="#475569">{sqmLabel}</text>
      </>
    );
  }
  // `worldAt` (only supplied by renderLayoutSheet, which has an actual
  // fit-to-bounds transform to invert — the coordinate-schedule appendix
  // sheet below has no drawing to correlate a grid label to, so its own
  // ticks stay unlabelled) labels just the top and left edges' ticks with
  // their real Y/X coordinate (client req 2026-09-01 redline, circling
  // exactly those two edges: "increase size of grid marks and add
  // labels") — bottom/right stay plain ticks, since a bottom-edge label
  // near the sheet's own right end would collide with "SR No" there.
  const titleBlock = (
    no: number,
    label: string,
    worldAt?: (px: number, py: number) => { east: number; north: number },
    scaleFactor?: number
  ) => (
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
          when that box is actually drawn (General Plan only, see below).
          All four edges now labelled (client req 2026-09-02: "right and
          bottom per labels ku nahi hai... left and top per hain" — was
          deliberately top/left only, to stay clear of the registration box
          and SR No; both sit outside the frame's own margin now (client req
          2026-09-02's earlier A0-resize work), so there's no collision
          labelling all four edges the same way. */}
      {sheetMode === "general"
        ? edgeTicks(FRAME_Y, FRAME_X, regX, true, TICK, worldAt)
        : edgeTicks(FRAME_Y, FRAME_X, FRAME_R, true, TICK, worldAt)}
      {edgeTicks(FRAME_B, FRAME_X, FRAME_R, true, -TICK, worldAt)}
      {edgeTicks(FRAME_X, FRAME_Y, FRAME_B, false, TICK, worldAt)}
      {sheetMode === "general"
        ? edgeTicks(FRAME_R, regY + regSize, FRAME_B, false, -TICK, worldAt)
        : edgeTicks(FRAME_R, FRAME_Y, FRAME_B, false, -TICK, worldAt)}
      <rect x={FRAME_X} y={FRAME_Y} width={FRAME_R - FRAME_X} height={FRAME_B - FRAME_Y} fill="none" stroke="#0f172a" strokeWidth={1.5} />
      {/* Title heading — select/move/resize (client req 2026-08-28: "ye
          client khud drag kar ke kahi bi place kar sake ur resize bi kar
          sake"), same offset pattern as WorkingPlan.tsx's own title block. */}
      {(() => {
        const ts = meta.titleOffset.scale ?? 1;
        // Base sizes proportional to plan scale (client req 2026-09-05:
        // "General Plan= make 13, All other information under =make 10
        // (By Default.) They will change propositionally with Scale"),
        // with the user's own manual title +/- (ts) still composing on top
        // — same two-layer pattern the registration box uses (regScale for
        // the base size, panelResizable's own scale for on-demand zoom).
        const titleFS = Math.max(MIN_TITLE_FS, TITLE_GROUND_M * (scaleFactor ?? 0)) * ts;
        const subtitleFS = Math.max(MIN_SUBTITLE_FS, SUBTITLE_GROUND_M * (scaleFactor ?? 0)) * ts;
        const tBoxTop = mapY(18), tBoxBottom = TITLE_LINE2_Y + 8 + extraTitleLines.length * TITLE_EXTRA_LINE_H, tBoxHalfW = 200;
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
            <text x={W / 2} y={TITLE_Y1} textAnchor="middle" fontSize={titleFS} fontWeight={700} fill={titleSelected ? "#dc2626" : "#0f172a"}>
              {sheetMode === "working" ? "WORKING PLAN" : "GENERAL PLAN"}
            </text>
            <text x={W / 2} y={TITLE_OF_Y} textAnchor="middle" fontSize={subtitleFS} fill={titleSelected ? "#dc2626" : "#334155"}>
              OF
            </text>
            <text x={W / 2} y={TITLE_LINE2_Y} textAnchor="middle" fontSize={subtitleFS} fill={titleSelected ? "#dc2626" : "#334155"}>
              {line2}
            </text>
            {extraTitleLines.map((ln, i) => (
              <text key={i} x={W / 2} y={TITLE_LINE2_Y + (i + 1) * TITLE_EXTRA_LINE_H} textAnchor="middle" fontSize={subtitleFS} fill={titleSelected ? "#dc2626" : "#334155"}>
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
          <text x={regX} y={mapY(18)} fontSize={7} fontWeight={700} fill="#dc2626">GC-{meta.gcNo || "—"}</text>
          <text x={regX + regW} y={mapY(18)} textAnchor="end" fontSize={7} fontWeight={700} fill="#0f172a">SHEET No - {no} of {sheetCount}</text>
          {/* Matched to the GC-122 reference exactly (client req 2026-08-28,
              screenshot circling this whole box): no "G.P. No." row here (that
              field stays editable for other diagrams' own cross-reference, just
              not printed in this box); a real blank gap — not a drawn line —
              between "Approved" and "Director of Surveys and Mapping" for the
              actual signature; "Surveyed in"/"By me" each pair a label on the
              left with its value right-aligned on the same row, and "Land
              Surveyor" sits alone on the row under the surveyor's name. */}
          {/* Independently click-to-select + resize, same pattern as the
              6 right-panel sections (client req 2026-09-05: "i also like
              that feature... he want that feature for zoom in and zoom
              out when he click on that" — asked, of the options offered,
              specifically for this registration box). panelResizable's own
              scale composes with regScale above — regScale keeps the box
              at a true 10cm by default, this adds an on-demand +/- on top
              of that once the client clicks it. */}
          {panelResizable("registrationBox", { x: regX, y: regY, w: regW, h: regSize }, (
            <>
              <rect x={regX} y={regY} width={regW} height={regSize} fill="none" stroke="#0f172a" strokeWidth={0.6} />
              <text x={regX + 6 * regScale} y={regY + 24 * regScale} fontSize={9.5 * regScale} fontWeight={700} fill="#0f172a">DSM No: {meta.dsmNo || "—"}</text>
              <line x1={regX} y1={regY + 30 * regScale} x2={regX + regW} y2={regY + 30 * regScale} stroke="#0f172a" strokeWidth={0.4} />
              <text x={regX + 6 * regScale} y={regY + 46 * regScale} fontSize={8.5 * regScale} fontWeight={700} fill="#0f172a">Approved</text>
              <text x={regX + 6 * regScale} y={regY + 76 * regScale} fontSize={7.5 * regScale} fontWeight={700} fill="#0f172a">Director of Surveys and Mapping</text>
              <line x1={regX} y1={regY + 86 * regScale} x2={regX + regW} y2={regY + 86 * regScale} stroke="#0f172a" strokeWidth={0.4} />
              <text x={regX + 6 * regScale} y={regY + 100 * regScale} fontSize={8 * regScale} fontWeight={700} fill="#0f172a">Surveyed in</text>
              <text x={regX + regW - 6 * regScale} y={regY + 100 * regScale} textAnchor="end" fontSize={8 * regScale} fontWeight={700} fill="#0f172a">{meta.surveyedIn || "—"}</text>
              {/* "By me" own row, then a real blank gap before the printed name —
                  same convention as the Approved/Director gap above — for the
                  surveyor's actual pen signature (client req 2026-09-02,
                  screenshot: "the surveyor must sign there... move [the name]
                  and Land Surveyor a bit down to create space"). Was
                  cramming the name onto the same line as "By me" with no room
                  to sign at all. */}
              <text x={regX + 6 * regScale} y={regY + 114 * regScale} fontSize={8 * regScale} fontWeight={700} fill="#0f172a">By me</text>
              <text x={regX + regW - 6 * regScale} y={regY + 138 * regScale} textAnchor="end" fontSize={8 * regScale} fontWeight={600} fill="#0f172a">{meta.surveyor || "—"}</text>
              <text x={regX + regW - 6 * regScale} y={regY + 150 * regScale} textAnchor="end" fontSize={7 * regScale} fontWeight={700} fill="#0f172a">Land Surveyor</text>
            </>
          ))}
        </>
      )}

      {/* SR No sits OUTSIDE the border too (client req 2026-08-28: "SR number
          outside frame") — y=H-16 already clears FRAME_B (H-24) now that the
          margin is wide enough to hold it. */}
      <text x={mapX(W - 20)} y={mapY(H - 16)} textAnchor="end" fontSize={9} fill="#64748b">SR No: {meta.srNo || "—"}</text>
    </>
  );

  // Sheet renderer — one call per layout-sheet group (client req 2026-08-27,
  // multi-sheet split). Each group computes its own transform/gpPlots/
  // beacons/blockCorners from just its own plots; the reference panel and
  // Sheet Index are identical on every sheet; the outer-boundary traverse
  // table + grand total (whole-layout concepts) render only on sheet 1.
  function renderLayoutSheet(groupIdx: number) {
    const groupPlots = layoutGroups[groupIdx];
    const groupGpPlots: Plot[] = groupPlots.map((p) => ({ number: p.number, points: dropClosingDuplicate(p.fig.points) }));
    const groupUsedBeacons: GpBeacon[] = dedupePoints(groupGpPlots)
      .filter((p): p is { name: string; east: number; north: number } => !!p.name)
      .map((p) => ({ id: p.name, east: p.east, north: p.north }));
    const t = computeTransform(groupUsedBeacons);
    // Right-side panel + Lot Areas + Block Corner Table text, all sized the
    // same as the drawing's own plot numbers (client req 2026-09-05,
    // screenshot circling the whole panel + both tables: "Make all text
    // 1.8. and propotional to scalling") — same ground-metre-times-true-
    // scale formula as LOT_NUMBER_GROUND_M on the drawing itself, so this
    // text now scales right along with the plots when the plan scale
    // changes, instead of staying a fixed pixel size regardless of scale.
    const panelFS = Math.max(MIN_LOT_NUMBER_FS, LOT_NUMBER_GROUND_M * t.s);
    const panelHeadingFS = Math.max(MIN_PANEL_HEADING_FS, PANEL_HEADING_GROUND_M * t.s);
    const groupSchedule = groupPlots.map((p, i) => ({ p, i }));
    const groupSortedPlots = groupPlots; // layoutGroups are already slices of sortedPlots
    // Lot Areas table sizing — the column count is now the user's picked
    // value, ALWAYS, full stop (client req 2026-09-04, screenshots of the
    // picker set to 2 vs 4 rendering near-identically: "number of columns
    // are not working with options !! just simpley changing the size of the
    // text not the number of columns" — a PRIOR "grow columns as a last
    // resort" escape hatch, meant to avoid unreadable text, ended up
    // silently overriding the picker almost every time a sheet had enough
    // lots to need it, which is exactly what the client is now reporting).
    // rowsPerCol is derived from the ACTUAL lot count (`Math.ceil`), so
    // every lot always gets a row regardless of column count — no lot is
    // ever dropped, the same guarantee the old escape hatch existed to
    // protect, but without needing to override the user's choice to do it.
    // Row height shrinks toward MIN_LOT_ROW_H (now an UNCONDITIONAL floor —
    // the old version only floored it inside the since-removed escape-hatch
    // branch, so picking the picker's own max of 4 columns could shrink
    // text past that floor into near-invisible sub-1pt text with no clamp
    // at all, which is the "just changing the size of the text" half of the
    // same screenshot). If even the floor doesn't make everything fit, the
    // table legitimately runs taller than its usual box — same trade-off
    // already accepted for the Block Corner Table below, and the section is
    // independently draggable/resizable so the client can reposition or
    // shrink it by hand rather than losing rows or legibility to an
    // auto-override.
    const totalLots = groupSortedPlots.length;
    const usedLotCols = totalLots === 0 ? 0 : lotTableCols;
    const rowsPerCol = usedLotCols === 0 ? 0 : Math.ceil(totalLots / usedLotCols);
    const lotRowH = rowsPerCol === 0 ? DEFAULT_LOT_ROW_H : Math.max(MIN_LOT_ROW_H, Math.min(DEFAULT_LOT_ROW_H, availableLotH / rowsPerCol));
    const usedLotRows = rowsPerCol;
    const lotColBounds = computeLotColBounds(usedLotCols);
    // Header/value size now comes from panelFS (client req 2026-09-05, "make
    // all text 1.8 and proportional to scaling") — lotFontsFor still supplies
    // the per-column-count LABEL TEXT ("LOT No." vs "LOT" etc., abbreviated
    // once a narrow column has no room for the long form), just not its own
    // font sizes any more. Value font still can't exceed what the (now
    // possibly shrunk) row height has room for — otherwise a row height
    // squeezed down toward MIN_LOT_ROW_H would render text taller than its
    // own row, overlapping the next one.
    const lotLabels = lotFontsFor(usedLotCols);
    const lotFonts = { headerFS: panelFS, valueFS: Math.min(panelFS, lotRowH * 0.65), lotLabel: lotLabels.lotLabel, sqmLabel: lotLabels.sqmLabel };
    const lotBoxRight = usedLotCols > 0 ? lotColBounds[usedLotCols - 1].right : tblL;
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
        // overflow: visible (client req 2026-09-02) — a true-scale drawing
        // (see computeTransform's own `s`) can extend past this sheet's
        // nominal 0..W/0..H box; without this it would be silently clipped
        // at that boundary instead of staying reachable via the zoom/pan
        // controls above.
        style={{ border: "1px solid #cbd5e1", overflow: "visible", cursor: addingRoadLabel || addingBoundaryLabel ? "crosshair" : "default" }}
        onClick={handleCanvasClick}
      >
        {titleBlock(groupIdx + 1, `Layout of ${groupPlots.length} parcel(s)`, t.screenToWorld, t.s)}
        {/* North arrow — shifted right (client req 2026-09-02: "iss arrow ko
            thora right shift karo... N symbol ko bhi sath karna") since it
            was overlapping the title's "...TRIBAL AREA" line. Independently
            click-to-select + draggable + resizable (client req 2026-09-05:
            "I want to be able to move (select and drag) the north arrow and
            also resize") — same panelResizable pattern as every other panel
            element, coordinates baked absolute (rather than the group's own
            local translate this replaces) so panelResizable's own pivot
            math anchors correctly on the arrow's own top-left. */}
        {(() => {
          const northX = FX1 + 15, northY = FY0 + 16;
          const northBox = { x: northX - 10, y: northY - 18, w: 20, h: 48 };
          return panelResizable("northArrow", northBox, (
            <>
              <line x1={northX} y1={northY + 12} x2={northX} y2={northY - 10} stroke="#0f172a" strokeWidth={1.5} />
              <polygon points={`${northX},${northY - 14} ${northX - 5},${northY - 5} ${northX + 5},${northY - 5}`} fill="#0f172a" />
              <text x={northX} y={northY + 26} textAnchor="middle" fontSize={10} fill="#0f172a">N</text>
            </>
          ));
        })()}
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
          const lineW = groupPlots.length > 150 ? 0.5 : groupPlots.length > 60 ? 0.7 : 1;
          return (
            <g key={p.number}>
              <polygon points={d} fill="none" stroke="#0f172a" strokeWidth={lineW} strokeLinejoin="round" />
              <text x={cx} y={cy} textAnchor="middle" fontSize={Math.max(MIN_LOT_NUMBER_FS, LOT_NUMBER_GROUND_M * t.s)} fontWeight={700} fill="#0f172a">{p.number}</text>
            </g>
          );
        })}
        {groupUsedBeacons.length === 0 && (
          <text x={(FX0 + FX1) / 2} y={(FY0 + FY1) / 2} textAnchor="middle" fontSize={11} fill="#cbd5e1">No plots numbered in COGO yet</text>
        )}
        {/* Block corner circles + their real point names on the drawing
            itself (client req 2026-09-03, screenshot circling every lot
            corner: "Block corner circles and their names should also
            appear in the General plan" — supersedes an earlier decision to
            keep beacon IDs off the drawing entirely and in the Block
            Corner Table only). A small hollow circle at each beacon this
            sheet's lots actually use (same set the Block Corner Table
            lists), with its real name (e.g. "L1677") at a small FIXED
            offset — not the dynamic declutter/leader-line approach the
            earlier, removed version used, since that was the actual cause
            of a previously-reported "diagonal crosshatch" artefact through
            dense lots; density-tiered sizing keeps it legible instead.
            `showDot`/name both hide past an extreme density where even a
            tiny hollow circle would just merge into visual noise, same
            threshold the point markers elsewhere in the app already use. */}
        {(() => {
          const n = groupUsedBeacons.length;
          if (n > 250) return null;
          // Reduced further (client req 2026-09-05: "also reduce block
          // corner circles"), all three tiers scaled down by the same 0.7x
          // ratio from the previous round so density-based shrinking still
          // behaves the same relative to each other.
          const r = n > 150 ? 0.42 : n > 60 ? 0.6533 : 0.9333;
          const cornerFS = Math.max(MIN_EDGE_TEXT_FS, EDGE_TEXT_GROUND_M * t.s);
          const off = cornerFS + 2;
          return groupUsedBeacons.map((b) => {
            const bx = t.sx(b.east, b.north), by = t.sy(b.east, b.north);
            return (
              <g key={b.id}>
                <circle cx={bx} cy={by} r={r} fill="white" stroke="#0f172a" strokeWidth={Math.max(0.4, r * 0.35)} />
                <text x={bx + off} y={by - off / 2} fontSize={cornerFS} fill="#334155">{b.id}</text>
              </g>
            );
          });
        })()}
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
          // tiering is gone — text size now tracks the true plan scale
          // instead (see EDGE_TEXT_GROUND_M above), same as the plots.
          const dimFS = Math.max(MIN_EDGE_TEXT_FS, EDGE_TEXT_GROUND_M * t.s);
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
        {/* Sheet Index / Beacon Description / Splay Information / Ped Way —
            each an INDEPENDENTLY draggable + resizable group (client req
            2026-09-02, correcting an earlier round that moved the whole
            panel as one block: "group these features independently... dont
            just group all of them"; resize added 2026-09-04: "i also want
            to be able to click and resize this"). Same select/drag/resize
            interaction as the title heading, via panelResizable. */}
        {panelSectionLayouts.map((section) => {
          const secX = panelX - 8, secY = section.rowYs[0] - 12;
          const secW = 230 * FRAME_SCALE_X, secH = section.rowYs[section.rowYs.length - 1] - section.rowYs[0] + 18;
          return panelResizable(section.id, { x: secX, y: secY, w: secW, h: secH }, (
            <>
              {section.rows.map((row, i) => (
                <text
                  key={i}
                  x={panelX}
                  y={section.rowYs[i]}
                  // Capped against this row's own fixed line-height (10 for a
                  // heading row, 12 otherwise — panelSectionLayouts' own
                  // spacing) so a very fine plan scale can't grow the font
                  // past what that fixed spacing has room for.
                  fontSize={row.heading ? Math.min(panelHeadingFS, 10 * 0.65) : Math.min(panelFS, 12 * 0.65)}
                  fontWeight={row.heading ? 700 : 400}
                  fill={row.heading ? "#0f172a" : "#334155"}
                >
                  {row.text}
                </text>
              ))}
            </>
          ));
        })}
        {sheetMode === "general" && (
          <>
            {/* Lot Areas table (client req 2026-08-27, §2f; bordered grid
                added 2026-09-01 to match the reference sheet's own boxed
                table exactly). Sized to the ACTUAL number of lots on this
                sheet (client req 2026-09-02, screenshot crossing out a big
                empty second column-pair and empty rows below a 5-lot sheet:
                "the table should only cater for available data") — the box,
                its right edge, and its row count all shrink to fit; the
                second "LOT No. | SQ. METRES" column-pair only appears (and
                only then does the box widen to the full table width) once
                there are actually more lots than fit in one column. */}
            {groupSortedPlots.length > 0 && (() => {
              const laX = tblL - 8, laY = lotTableTop - 20;
              const laW = lotBoxRight - tblL + 16;
              const laH = lotTableTop + 30 + usedLotRows * lotRowH + LOT_FOOTER_H - lotTableTop + 20;
              const boxTop = lotTableTop + 5;
              const headerRuleY = lotTableTop + 16; // client req 2026-09-05: "heading wali row... uski height bi kam karo" (20 -> 16)
              const boxBottom = lotTableTop + 30 + usedLotRows * lotRowH;
              return panelResizable("lotAreas", { x: laX, y: laY, w: laW, h: laH }, (
                <>
                  <text x={panelX} y={lotTableTop} fontSize={panelHeadingFS} fontWeight={700} fill="#0f172a">LOT AREAS</text>
                  <rect x={tblL} y={boxTop} width={lotBoxRight - tblL} height={boxBottom - boxTop} fill="none" stroke="#0f172a" strokeWidth={0.7} />
                  <line x1={tblL} y1={headerRuleY} x2={lotBoxRight} y2={headerRuleY} stroke="#0f172a" strokeWidth={0.7} />
                  {lotColBounds.slice(0, usedLotCols).map((col, c) => (
                    <g key={c}>
                      {lotPairHeader(col.lotColL, col.sqmColL, lotTableTop + 13, lotFonts.headerFS, lotFonts.lotLabel, lotFonts.sqmLabel)}
                      <line x1={col.divider} y1={boxTop} x2={col.divider} y2={boxBottom} stroke="#94a3b8" strokeWidth={0.5} />
                      {c > 0 && <line x1={col.left} y1={boxTop} x2={col.left} y2={boxBottom} stroke="#0f172a" strokeWidth={0.7} />}
                      {/* Row dividers (client req 2026-09-05: "block corner
                          table ur lot Area table dono ke rows ke divider
                          nahi hain?? fix karo") — one between each pair of
                          consecutive rows, at the midpoint of their two
                          baselines. */}
                      {Array.from({ length: Math.max(0, Math.min(rowsPerCol, groupSortedPlots.length - c * rowsPerCol) - 1) }).map((_, ri) => {
                        const ly = lotTableTop + 30 + (ri + 0.5) * lotRowH;
                        return <line key={`rd${ri}`} x1={col.left} y1={ly} x2={col.right} y2={ly} stroke="#cbd5e1" strokeWidth={0.4} />;
                      })}
                      {groupSortedPlots.slice(c * rowsPerCol, (c + 1) * rowsPerCol).map((p, k) => {
                        const y = lotTableTop + 30 + k * lotRowH;
                        return (
                          <g key={p.number}>
                            <text x={col.lotColL} y={y} textAnchor="start" fontSize={lotFonts.valueFS} fill="#0f172a">{p.number || "(none)"}</text>
                            <text x={col.sqmColL} y={y} textAnchor="start" fontSize={lotFonts.valueFS} fill="#0f172a">{p.fig.area_m2.toFixed(2)}</text>
                          </g>
                        );
                      })}
                    </g>
                  ))}
                </>
              ));
            })()}
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
              // No "SHEET TOTAL"/"+N more" lines to clear below the table any
              // more (client req 2026-09-02, both removed) — just a small
              // fixed gap before the Block Corner Table's own heading.
              const bcTop = lotTableTop + 30 + usedLotRows * lotRowH + 24;
              // EVERY beacon this sheet uses gets a row — no "+N more … see
              // digital schedule" truncation any more (client req
              // 2026-09-04, reference screenshot of the real GC document's
              // own block corner page: "All block corner should appear in
              // the table like below" — a single continuous list, not cut
              // short). A table that runs past the frame's usual bottom band
              // is expected at real subdivision density; the section is now
              // independently draggable/resizable (added this same session)
              // so the client can reposition/shrink it to fit rather than
              // losing rows to an auto-truncated note.
              const bcSorted = [...groupUsedBeacons].sort((a, b) => comparePointNames(a.id, b.id));
              const bcShown = bcSorted;
              const bcBottom = bcTop + 49 + bcShown.length * BC_ROW_H;
              const bcHitX = mapX(680), bcHitY = bcTop - 20, bcHitW = 300 * FRAME_SCALE_X, bcHitH = bcBottom - bcTop + 24;
              // Same panelFS/panelHeadingFS as the rest of the panel (client
              // req 2026-09-05), each capped against its own fixed line
              // spacing — BC_ROW_H for the beacon rows, the 13-unit gap to
              // the next line for the table's own heading — so a very fine
              // plan scale can't blow either one up past what that fixed
              // spacing actually has room for.
              const bcFS = Math.min(panelFS, BC_ROW_H * 0.65);
              const bcHeadingFS = Math.min(panelHeadingFS, 13 * 0.65);
              // Actual bordered grid (client req 2026-09-05, reference
              // screenshot of the real GC document's own tightly-ruled
              // block corner page: "isko table ki form main hi rakhna
              // hai... bus lines wagaira add karna ur space reduce karna
              // rows ur columns ki ur kuch nahi karna" — matches the Lot
              // Areas table's own outer-rect + column-divider + header-rule
              // convention just above, not a new style of its own).
              const bcBoxTop = bcTop + 5;
              const bcHeaderRuleY = bcTop + 42; // client req 2026-09-05: "heading wali row... uski height bi kam karo" (49 -> 42)
              // Column bounds RESET to fractions of the table's own width
              // (client req 2026-09-05: "reset the columns size of the
              // block corner table" — the two hand-picked divider positions
              // from the previous round didn't line up cleanly with the Y/X
              // value columns' actual text). Point/beacon names are short
              // ("L1401") so that column gets less width; Y and X hold full
              // coordinate values and split the rest evenly — same
              // fraction-of-box-width approach the Lot Areas table's own
              // computeLotColBounds already uses, not hand-tuned pixels.
              // Table width halved (client req 2026-09-05: "block corner
              // table ke columns ki width half kardo") — bcTblR replaces
              // tblR as this table's own right edge everywhere below,
              // leaving the Lot Areas table above it untouched.
              const bcTblR = tblL + (tblR - tblL) * 0.35; // client req 2026-09-05: "ur reduce karo" (0.5 -> 0.35)
              const bcTotalW = bcTblR - tblL;
              const bcCol0 = tblL, bcCol1 = tblL + bcTotalW * 0.22, bcCol2 = tblL + bcTotalW * 0.61;
              const bcPad = 6;
              return panelResizable("blockCorner", { x: bcHitX, y: bcHitY, w: bcHitW, h: bcHitH }, (
                <>
                  <text x={panelX} y={bcTop} fontSize={bcHeadingFS} fontWeight={700} fill="#0f172a">BLOCK CORNER TABLE</text>
                  <rect x={tblL} y={bcBoxTop} width={bcTblR - tblL} height={bcBottom - bcBoxTop} fill="none" stroke="#0f172a" strokeWidth={0.7} />
                  <line x1={tblL} y1={bcHeaderRuleY} x2={bcTblR} y2={bcHeaderRuleY} stroke="#0f172a" strokeWidth={0.7} />
                  <line x1={bcCol1} y1={bcBoxTop} x2={bcCol1} y2={bcBottom} stroke="#0f172a" strokeWidth={0.7} />
                  <line x1={bcCol2} y1={bcBoxTop} x2={bcCol2} y2={bcBottom} stroke="#0f172a" strokeWidth={0.7} />
                  <text x={panelX} y={bcTop + 13} fontSize={bcFS} fontWeight={600}>SYSTEM {fmtSystem(config.coordinateSystem)} CO-ORDINATES (metres)</text>
                  <text x={bcCol1 + bcPad} y={bcTop + 24} fontSize={bcFS} fontWeight={600} fill="#475569">Y</text>
                  <text x={bcCol2 + bcPad} y={bcTop + 24} fontSize={bcFS} fontWeight={600} fill="#475569">X</text>
                  <text x={bcCol0 + bcPad} y={bcTop + 35} fontSize={bcFS} fill="#475569">CONSTANTS</text>
                  <text x={bcCol1 + bcPad} y={bcTop + 35} fontSize={bcFS} fill="#475569">+0,00</text>
                  <text x={bcCol2 + bcPad} y={bcTop + 35} fontSize={bcFS} fill="#475569">+0,00</text>
                  {/* Row dividers (client req 2026-09-05: "block corner
                      table ur lot Area table dono ke rows ke divider nahi
                      hain?? fix karo") — one between each pair of
                      consecutive beacon rows, at the midpoint of their two
                      baselines. */}
                  {bcShown.slice(1).map((b, ri) => {
                    const ly = bcTop + 49 + (ri + 0.5) * BC_ROW_H;
                    return <line key={`rd-${b.id}`} x1={tblL} y1={ly} x2={bcTblR} y2={ly} stroke="#cbd5e1" strokeWidth={0.4} />;
                  })}
                  {bcShown.map((b, k) => {
                    const y = bcTop + 49 + k * BC_ROW_H;
                    return (
                      <g key={b.id}>
                        <text x={bcCol0 + bcPad} y={y} fontSize={bcFS} fill="#0f172a">{b.id}</text>
                        <text x={bcCol1 + bcPad} y={y} fontSize={bcFS} fill="#0f172a">{fmtCoord(b.east)}</text>
                        <text x={bcCol2 + bcPad} y={y} fontSize={bcFS} fill="#0f172a">{fmtCoord(b.north)}</text>
                      </g>
                    );
                  })}
                </>
              ));
            })()}
          </>
        )}
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
                  <line x1={mapX(30)} y1={FY1 + 30} x2={mapX(970)} y2={FY1 + 30} stroke="#0f172a" strokeWidth={0.6} />
                  <text x={mapX(30)} y={FY1 + 44} fontSize={10} fontWeight={700} fill="#0f172a">OUTER BOUNDARY — SIDES / DIRECTIONS / CO-ORDINATES</text>
                  <text x={mapX(30)} y={FY1 + 58} fontSize={8.5} fontWeight={600} fill="#475569">Point</text>
                  <text x={mapX(110)} y={FY1 + 58} fontSize={8.5} fontWeight={600} fill="#475569">Direction</text>
                  <text x={mapX(230)} y={FY1 + 58} fontSize={8.5} fontWeight={600} fill="#475569">Distance (m)</text>
                  <text x={mapX(340)} y={FY1 + 58} fontSize={8.5} fontWeight={600} fill="#475569">Y</text>
                  <text x={mapX(430)} y={FY1 + 58} fontSize={8.5} fontWeight={600} fill="#475569">X</text>
                  {outerSides.slice(0, 8).map((s, k) => {
                    const y = FY1 + 72 + k * 12;
                    return (
                      <g key={k}>
                        <text x={mapX(30)} y={y} fontSize={8} fill="#0f172a">{s.point}</text>
                        <text x={mapX(110)} y={y} fontSize={8} fill="#0f172a">{s.bearing}</text>
                        <text x={mapX(230)} y={y} fontSize={8} fill="#0f172a">{s.distance.toFixed(2)}</text>
                        <text x={mapX(340)} y={y} fontSize={8} fill="#0f172a">{s.east.toFixed(2)}</text>
                        <text x={mapX(430)} y={y} fontSize={8} fill="#0f172a">{s.north.toFixed(2)}</text>
                      </g>
                    );
                  })}
                  {outerSides.length > 8 && (
                    <text x={mapX(30)} y={FY1 + 72 + 8 * 12 + 4} fontSize={8} fill="#94a3b8">+{outerSides.length - 8} more side(s) — see digital record</text>
                  )}
                </>
              ) : null /* Standalone "TOTAL AREA" line (client req 2026-09-04,
                   screenshot with a red cross through it: "delete this
                   line") removed — no fallback message printed here any
                   more when the outer-boundary traverse table itself has
                   no clean ring to walk (client req 2026-08-31 already
                   dropped the technical explanation that used to sit
                   alongside it). */
            ) : (
              <text x={mapX(30)} y={FY1 + 58} fontSize={9} fill="#94a3b8">Outer boundary traverse and total area — see Sheet 1.</text>
            )}
          </>
        ) : (() => {
          // ===== Working Plan variant (spec Part 3): no tables — an inset
          // reference-mark sketch + certification box instead, same pattern
          // as WorkingPlan.tsx's own inset/cert boxes (components/WorkingPlan.tsx). =====
          const insetBox = { x: mapX(690), y: lotTableTop, w: 280 * FRAME_SCALE_X, h: 140 * FRAME_SCALE_Y };
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
          const cert = { x: mapX(650), y: FY1 + 20, w: 320 * FRAME_SCALE_X, h: 90 };
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
          <Field label="Scale 1:">
            <Input
              type="number"
              value={scaleText}
              onChange={setScaleText}
              onBlur={commitScale}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            />
          </Field>
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
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium text-slate-500">Lot Areas table columns</div>
          <span className="inline-flex overflow-hidden rounded-lg border border-slate-200">
            {[1, 2, 3, 4].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setMeta((m) => ({ ...m, lotTableCols: n }))}
                className={`w-10 py-1.5 text-sm font-medium ${meta.lotTableCols === n ? "bg-brand text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
              >
                {n}
              </button>
            ))}
          </span>
        </div>
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium text-slate-500">Grid mark spacing (metres)</div>
          <span className="inline-flex overflow-hidden rounded-lg border border-slate-200">
            {[50, 100, 200].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setMeta((m) => ({ ...m, gridSpacingM: n }))}
                className={`px-3 py-1.5 text-sm font-medium ${meta.gridSpacingM === n ? "bg-brand text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
              >
                {n}m
              </button>
            ))}
          </span>
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
            <span className="text-xs text-slate-400">Drag a label to move it; double-click to edit its text. Scroll over the sheet to zoom. Press and hold the scroll-wheel button, then drag, to pan.</span>
          </div>
        )}
        {/* Render all sheets (so refs exist for print-all); show only the active one.
            Scroll-wheel zoom is scoped to this box — preventDefault on the wheel
            event stops it from also scrolling the page itself (client req
            2026-09-01: "without moving the whole window"). overflow-auto lets the
            user pan around the sheet with the browser's own scrollbars once
            zoomed past what fits, or via middle-mouse-button drag (client req
            2026-09-02) below. */}
        <div
          ref={panBoxRef}
          className="overflow-auto rounded border border-slate-100"
          style={{ maxHeight: "82vh", cursor: isPanning ? "grabbing" : undefined }}
          onWheel={(e) => {
            e.preventDefault();
            setGpZoom((z) => Math.max(GP_ZOOM_MIN, Math.min(GP_ZOOM_MAX, +(z + (e.deltaY < 0 ? 0.1 : -0.1)).toFixed(2))));
          }}
          onMouseDown={handlePanMouseDown}
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
