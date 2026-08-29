"use client";

import { forwardRef, type MouseEvent, type PointerEvent } from "react";
import { clampWords, clampToLines } from "@/lib/wrapSvgText";
import { declutterLabels } from "@/lib/labelLayout";
import {
  computeDiagramLayout,
  avg,
  fmtCoord,
  fmtDist,
  tCoord,
  tDist,
  sideLabel,
  areaText,
  fmtSystem,
  toDotted,
  certificationLine,
  type DiagramMeta,
  type DiagramPoint,
  type DiagramSide,
  type DiagramKind,
} from "@/lib/diagramLayout";

// Re-exported so every existing `from "@/components/SgDiagram"` /
// `from "./SgDiagram"` import elsewhere (Diagrams.tsx, WorkingPlan.tsx,
// BoreholeDiagram.tsx, MutationDiagram.tsx, TribalLeaseSketch.tsx,
// reportFormats.ts) keeps working unchanged — the types/helpers now live in
// `@/lib/diagramLayout` (client req 2026-08-26, Part 34: one shared layout
// module for both the SVG/print diagram and the DXF export), but this
// component is still where the rest of the app expects to find them.
export type { DiagramMeta, DiagramPoint, DiagramSide, DiagramKind };
export { fmtCoord, fmtDist, toDotted, areaText, certificationLine };

/** A hand-drawn dashed extension line the surveyor draws directly on the
 *  diagram (client req 2026-08-22, Part 24) — there's no survey data to
 *  compute it from, so its endpoints are wherever the surveyor clicked, but
 *  stored as real east/north survey coordinates (the same space the
 *  boundary itself lives in), not raw page pixels. Storing raw page
 *  coordinates was a real bug (client req 2026-08-25, "when I zoom, those
 *  edits are left behind... should be fixed to the drawing"): the figure's
 *  on-page position and scale are recomputed from meta.scale/the boundary
 *  every render, so a line anchored to a fixed pixel position drifts off
 *  the boundary the moment either changes, instead of staying attached to
 *  whatever point on the plot the surveyor actually clicked. */
export interface ManualAnnotation {
  id: string;
  e1: number;
  n1: number;
  e2: number;
  n2: number;
}

/** A free-text note the surveyor places directly on the diagram (client req
 *  2026-08-24: "I want to Add text there... How do I add Text"), anchored
 *  in the same real east/north survey coordinates as the extension lines
 *  above and for the same reason — it has to stay attached to the plot
 *  when the figure's scale/position recomputes, not drift off at a fixed
 *  page position. */
export interface ManualText {
  id: string;
  east: number;
  north: number;
  text: string;
  angle?: number; // rotation in degrees, clockwise (client req 2026-08-26); 0/undefined = horizontal
}

/** Live conversion between this diagram's on-page pixel space and the real
 *  survey east/north coordinates it's drawn from — handed to the caller via
 *  onTransform so annotations/text (drawn and dragged in page-pixel terms,
 *  same as any other pointer interaction) can be stored in survey
 *  coordinates and always stay attached to the boundary, however the
 *  figure's scale or position recompute (client req 2026-08-25). */
export interface DiagramTransform {
  toScreen: (east: number, north: number) => { x: number; y: number };
  toWorld: (x: number, y: number) => { east: number; north: number };
  /** Same as `toScreen`, but including any live display rotation/flip the
   *  caller has applied (client req 2026-08-28: "DXF main rotation working
   *  nahi kar raha") — optional since not every DiagramTransform provider
   *  has a rotation/flip concept; a DXF export can round-trip a world point
   *  through this then back through the plain (unrotated) `toWorld` to get
   *  a "fake" world coordinate that plots in the same place/orientation the
   *  live preview shows, without needing its own copy of the rotation math. */
  toScreenLive?: (east: number, north: number) => { x: number; y: number };
}

interface Props {
  meta: DiagramMeta;
  points: DiagramPoint[];
  sides: DiagramSide[];
  /** Optional: draw several parcel rings (mutation / subdivision) coloured,
   *  instead of one boundary polygon — keeps one template for every diagram. */
  parcels?: { number: string; points: DiagramPoint[] }[];
  /** Optional: points shown on the figure as marks (dot + label) but NOT part of
   *  the traverse — no boundary side, no coordinate-table row (e.g. a nearby
   *  reference/witness point the surveyor wants visible). */
  extraPoints?: DiagramPoint[];
  /** Adjoining-parcel extension lines the user has manually drawn directly
   *  on this diagram (client req 2026-08-22, Part 24 — supersedes the
   *  earlier per-side auto-computed approach for the diagram's own
   *  rendering). */
  manualAnnotations?: ManualAnnotation[];
  /** The first click of an in-progress manual annotation, awaiting the
   *  second click — shown as a small marker so the user can see where
   *  they started. */
  pendingAnnotationPoint?: { x: number; y: number } | null;
  /** Currently-selected annotation (for a Delete action) — rendered
   *  bolder, never in colour, so a screenshot/print taken mid-edit still
   *  reads as a normal black-and-white diagram. */
  selectedAnnotationId?: string | null;
  /** True while the manual-annotation draw tool is active — switches the
   *  cursor to a crosshair so the user knows clicks are being captured. */
  drawMode?: boolean;
  onCanvasClick?: (e: MouseEvent<SVGSVGElement>) => void;
  onAnnotationClick?: (id: string, e: MouseEvent) => void;
  /** Pointerdown on a selected annotation's move-handle (drag the whole
   *  line) or either end-handle (drag just that endpoint — stretches it
   *  freely, or rotates the whole line around the other, fixed end if the
   *  drag started with Shift held), client req 2026-08-23, extended
   *  2026-08-24 (Part 28). Pointer events (not mouse events) so the caller
   *  can take pointer capture on the grip itself — without it, a fast real
   *  drag that slips the cursor off the small grip hit-target, or off the
   *  diagram entirely, stops delivering move events partway through. */
  onAnnotationHandleDown?: (id: string, handle: "start" | "end" | "move", e: PointerEvent<SVGElement>) => void;
  onCanvasMouseMove?: (e: PointerEvent<SVGSVGElement>) => void;
  onCanvasMouseUp?: (e: PointerEvent<SVGSVGElement>) => void;
  /** Free-text notes placed directly on the diagram (client req 2026-08-24). */
  manualTexts?: ManualText[];
  selectedTextId?: string | null;
  onTextClick?: (id: string, e: MouseEvent) => void;
  onTextDoubleClick?: (id: string) => void;
  /** Drag to move (client req 2026-08-24) — same pointer-capture-on-grip
   *  robustness as the extension-line grips (Part 28); a single point has
   *  no length/angle to stretch or rotate, so move is the only mode. */
  onTextHandleDown?: (id: string, e: PointerEvent<SVGElement>) => void;
  /** Fires on every render with this diagram's current pixel<->survey-
   *  coordinate conversion (client req 2026-08-25) — the caller stores it
   *  in a ref (not state — this runs during render, so setState here would
   *  be a React anti-pattern) and uses it to convert annotation/text
   *  clicks and drags to/from real east/north before persisting them. */
  onTransform?: (t: DiagramTransform) => void;
  /** Shared display rotation (degrees, client req 2026-08-28) — the same
   *  project-wide value CogoWorkspace's Rotate slider, Working Plan and
   *  General Plan use. Applied only to the FIGURE (boundary, beacons,
   *  manual annotations/text) — pivoted on the figure's own drawing box
   *  (`fig`) — never to the fixed title block/legal-description/
   *  registration-table positions around it, which stay exactly where the
   *  official template puts them regardless of rotation. */
  rotation?: number;
  /** Shared display-only horizontal mirror (client req 2026-08-28) — same
   *  project-wide setting as CogoWorkspace's Flip button; rotation alone
   *  can never fix a mirrored shape. */
  flip?: boolean;
}

const PARCEL_COLORS = ["#0d9488", "#2563eb", "#db2777", "#d97706", "#7c3aed", "#16a34a", "#dc2626", "#0891b2"];

// ---------------------------------------------------------------------------
// Component — Botswana SG cadastral diagram, portrait A4, faithful to the
// official template (Lot 3508 MATEBELE sample). Only the figure changes with
// the coordinates; the layout/structure is fixed.
// ---------------------------------------------------------------------------
export const SgDiagram = forwardRef<SVGSVGElement, Props>(function SgDiagram(
  {
    meta, points: rawPoints, sides: rawSides, parcels, extraPoints, manualAnnotations, pendingAnnotationPoint,
    selectedAnnotationId, drawMode, onCanvasClick, onAnnotationClick, onAnnotationHandleDown, onCanvasMouseMove, onCanvasMouseUp,
    manualTexts, selectedTextId, onTextClick, onTextDoubleClick, onTextHandleDown, onTransform,
    rotation: rotationProp, flip: flipProp,
  },
  ref
) {
  // All layout math (frame/table/legal-description/annexure-table
  // measurements) lives in computeDiagramLayout — the single source of
  // truth shared with the DXF export (client req 2026-08-26, Part 34).
  // Destructuring back the same names the old inline computation used
  // keeps the JSX below completely unchanged.
  const L = computeDiagramLayout(meta, rawPoints, rawSides, extraPoints ?? []);
  const {
    points, sides,
    MM, VB_W, VB_H,
    FRAME_X, FRAME_Y, FRAME_W, FRAME_H, FRAME_RIGHT, FRAME_BOTTOM,
    FS_TABLE_HEAD, FS_TABLE_SUB, FS_CONSTANTS,
    FS_BEACON_HEAD, FS_BEACON, FS_LOCALITY,
    FS_DOS, FS_ARROW, FS_SCALE,
    FS_LEGAL, FS_LANDCALLED, FS_PARENT, FS_CERT,
    FS_SURVEYOR, FS_SURVEYOR_TITLE, FS_FOOTER, FS_ANNEX,
    tx, tw, ty, headH, dataTop, n, dataFS, ROW_H_MIN, rowH, dataH, topBandH, tableBottom,
    maxSideLabelChars, sideValExtra, xSideVal, xMetR, xDir, xDirR, xPt, xPtR, xY, xYR, xX, xXR, xDsm, tableRight,
    hRow1, hRow2, hRow3, xYDividerTop, xXDividerTop,
    annTop, annBottom, annC1, annC2, dash,
    midTop, es, nsv, figureLetters, figureLines, LEGAL_LH, landCalled, landCalledLines,
    parentLineGroups, situateLines, legalBlockH, legalY0,
    beaconLines, BD_LH, bdHeadingY, bdLinesY0, bdBlockBottom, localityY,
    figTop, figBottom, fig, pad, bE, bN, minE, maxE, minN, maxN, spanE, spanN,
    sc, dw, dh, offX, offY, toX, toY,
    dsmBoxTop, dsmApprovedY, dosY1, dosY2, dosLineY,
    arrowX, arrowY,
    landCalledY0, parentY0, parentTotalLines, situateY0, deductionsY, certY1, leftColW, rightColW, cert, surveyorFit,
    valueX, gpNoX, srNoX, dsmFileX, compX, degreeSquareX, lirNoX,
    gpNo, srNo, dsmFile, comp, degreeSquare, lirNo,
    annexedTo, annexedDate, annexedFavour, annexNameLines, ANNEX_NAME_LH, parentDiagramNo,
  } = L;
  // Shared display rotation/flip (client req 2026-08-28) — same project-
  // wide values CogoWorkspace/Working Plan/General Plan use, applied ONLY
  // to the figure (boundary/beacons/annotations/extraPoints) below, pivoted
  // on the figure's own drawing box `fig`. The title block, legal
  // description, and registration tables never call toX/toY at all (they
  // use their own fixed tx/ty/dsmBoxTop-style positions), so they're
  // untouched by construction — nothing to opt them out of.
  const rotation = rotationProp || 0;
  const flip = flipProp ?? false;
  const figPivotX = fig.x + fig.w / 2, figPivotY = fig.y + fig.h / 2;
  const figRotRad = (rotation * Math.PI) / 180;
  const figCosR = Math.cos(figRotRad), figSinR = Math.sin(figRotRad);
  const fx0 = (e: number) => {
    const x = toX(e);
    return flip ? 2 * figPivotX - x : x;
  };
  const fx = (e: number, n: number) => {
    if (!rotation) return fx0(e);
    return figPivotX + (fx0(e) - figPivotX) * figCosR - (toY(n) - figPivotY) * figSinR;
  };
  const fy = (e: number, n: number) => {
    if (!rotation) return toY(n);
    return figPivotY + (fx0(e) - figPivotX) * figSinR + (toY(n) - figPivotY) * figCosR;
  };
  // Rotation/flip-aware point-in-polygon test (mirrors diagramLayout.ts's
  // own `insidePoly`, which is built from the UNROTATED screenPts and so
  // can't be reused once the queried point is itself rotated) — used below
  // to keep a beacon label on the true outside of a concave corner
  // regardless of the live rotation/flip.
  const rotatedRing = points.map((p) => ({ x: fx(p.east, p.north), y: fy(p.east, p.north) }));
  function rotInsidePoly(px: number, py: number): boolean {
    let inside = false;
    for (let i = 0, j = rotatedRing.length - 1; i < rotatedRing.length; j = i++) {
      const a = rotatedRing[i], b = rotatedRing[j];
      const hit = a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x;
      if (hit) inside = !inside;
    }
    return inside;
  }
  const rotatedPolyPoints = rotatedRing.map((p) => `${p.x},${p.y}`).join(" ");
  // Inverse of toX/toY (client req 2026-08-25) — lets the caller convert a
  // pixel-space click/drag back to real survey coordinates so annotations
  // stay attached to the boundary regardless of how this scale/offset
  // recomputes later (a fixed pixel position doesn't).
  onTransform?.({
    toScreen: (east, north) => ({ x: toX(east), y: toY(north) }),
    toWorld: (x, y) => ({ east: (x - offX) / sc + minE, north: maxN - (y - offY) / sc }),
    toScreenLive: (east, north) => ({ x: fx(east, north), y: fy(east, north) }),
  });
  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      xmlns="http://www.w3.org/2000/svg"
      fill="#000"
      onClick={onCanvasClick}
      onPointerMove={onCanvasMouseMove}
      onPointerUp={onCanvasMouseUp}
      style={{
        width: "100%",
        height: "auto",
        background: "white",
        color: "#000",
        fontFamily: "Calibri, Candara, 'Segoe UI', Optima, Arial, sans-serif",
        cursor: drawMode ? "crosshair" : undefined,
      }}
    >
      {/* outer border — 160.4 x 272.9mm, positioned per Part 23's exact
          margins (24.8mm left/right, 12.2mm top, ~11.9mm bottom) */}
      <rect x={FRAME_X} y={FRAME_Y} width={FRAME_W} height={FRAME_H} fill="white" stroke="black" strokeWidth={2} />

      {/* ===================== TOP DATA TABLE ===================== */}
      {/* Open-at-the-bottom, per the reference PDF's actual line geometry
          (client req 2026-08-22, Part 27) — the reference has only two
          horizontal lines in this band (the frame's own top edge, and the
          header/data divider); there is no line between individual data
          rows and no closing bottom border. No table-outline <rect> here:
          the top/left/right edges are already the frame's own border
          (tx/tableRight = FRAME_X/FRAME_RIGHT, ty = FRAME_Y), so drawing a
          separate table rect would just duplicate them AND add the bottom
          border the reference doesn't have. */}
      <g>
        {/* vertical dividers */}
        {/* Row-label / distance-value split within SIDES METRES (client req
            2026-08-22) — matches the point-letter/Y divider's style: a
            light line starting below the header, not cutting through the
            merged "SIDES METRES" heading above it. Bumped from a hairline
            (0.5/0.7) to a full solid weight (client req 2026-08-25: "make
            all the lines black" — thin enough to anti-alias into a faint
            gray on screen/print despite already being color #000). */}
        <line x1={xSideVal} y1={dataTop} x2={xSideVal} y2={tableBottom} stroke="black" strokeWidth={1.2} />
        <line x1={xMetR} y1={ty} x2={xMetR} y2={tableBottom} stroke="black" strokeWidth={1.2} />
        <line x1={xDirR} y1={ty} x2={xDirR} y2={tableBottom} stroke="black" strokeWidth={1.2} />
        <line x1={xY} y1={xYDividerTop} x2={xY} y2={tableBottom} stroke="black" strokeWidth={1.2} />
        <line x1={xX} y1={xXDividerTop} x2={xX} y2={tableBottom} stroke="black" strokeWidth={1.2} />
        <line x1={xDsm} y1={ty} x2={xDsm} y2={tableBottom} stroke="black" strokeWidth={1.2} />
        {/* header underline */}
        <line x1={tx} y1={ty + headH} x2={xDsm} y2={ty + headH} stroke="black" strokeWidth={1.2} />

        {/* header row 1 */}
        <text x={(tx + xMetR) / 2} y={hRow1} textAnchor="middle" fontWeight="medium" fontSize={FS_TABLE_HEAD}>SIDES</text>
        <text x={(xDir + xDirR) / 2} y={hRow1} textAnchor="middle" fontWeight="medium" fontSize={FS_TABLE_HEAD}>DIRECTIONS</text>
        <text x={(xPt + xXR) / 2} y={hRow1} textAnchor="middle" fontWeight="medium" fontSize={FS_TABLE_HEAD}>CO-ORDINATES</text>
        <text x={(xDsm + tableRight) / 2} y={hRow1} textAnchor="middle" fontWeight="medium" fontSize={FS_TABLE_HEAD}>D.S.M No.</text>
        {/* header row 2 */}
        <text x={(tx + xMetR) / 2} y={hRow2} textAnchor="middle" fontWeight="medium" fontSize={FS_TABLE_SUB}>METRES</text>
        <text x={xPt + (xY - xPt) / 2} y={hRow2} textAnchor="middle" fontSize={FS_TABLE_SUB} fontWeight="medium">Y</text>
        <text x={(xY + xXR) / 2} y={hRow2} textAnchor="middle" fontSize={FS_TABLE_SUB}>
          {clampWords(`System ${fmtSystem(meta.coordinateSystem)}`, xXR - xY - 12, FS_TABLE_SUB)}
        </text>
        {/* Nudged right off centre (client req 2026-08-27) — dead-centre in the
            X column sat against the tail of the "System LO. N°" label next to
            it, which spans into this column too, so the two collided. */}
        <text x={xX + (xXR - xX) / 2 + 20} y={hRow2} textAnchor="middle" fontSize={FS_TABLE_SUB} fontWeight="medium">X</text>
        <text x={(xDsm + tableRight) / 2} y={hRow2} textAnchor="middle" fontSize={FS_TABLE_HEAD}>
          {clampWords(meta.dsmNo || "", tableRight - xDsm - 16, FS_TABLE_HEAD)}
        </text>
        {/* header row 3 — constants */}
        <text x={(xDir + xDirR) / 2} y={hRow3} textAnchor="middle" fontWeight="medium" fontSize={FS_CONSTANTS}>CONSTANTS</text>
        <text x={xY + 8} y={hRow3} fontSize={FS_CONSTANTS}>+    0,00</text>
        <text x={xX + 8} y={hRow3} fontSize={FS_CONSTANTS}>+    0,00</text>

        {/* data rows — row height (and font) shrinks to fit the fixed
            37.0mm data area regardless of point count (Part 23). */}
        {Array.from({ length: n }).map((_, i) => {
          const s = sides[i];
          const p = points[i];
          const y = dataTop + i * rowH + rowH * 0.7;
          return (
            <g key={`row${i}`} fontSize={dataFS}>
              {s && (
                <>
                  <text x={tx + 10} y={y}>{sideLabel(s.from, s.to)}</text>
                  <text x={xMetR - 8} y={y} textAnchor="end">{tDist(s.distance)}</text>
                  <text x={xDir + 12} y={y}>{toDotted(s.bearing_dms)}</text>
                </>
              )}
              {p && (
                <>
                  <text x={xPt + 8} y={y} fontWeight="medium">{p.name}</text>
                  <text x={xY + 8} y={y}>{tCoord(p.east)}</text>
                  <text x={xX + 8} y={y}>{tCoord(p.north)}</text>
                </>
              )}
            </g>
          );
        })}
      </g>

      {/* ===================== BEACON DESCRIPTION + village ===================== */}
      <text x={tx + 4} y={bdHeadingY} fontSize={FS_BEACON_HEAD} fontWeight="medium" textDecoration="underline">
        BEACON DESCRIPTION
      </text>
      {beaconLines.map((ln, i) => (
        <text key={`bd${i}`} x={tx + 4} y={bdLinesY0 + i * BD_LH} fontSize={FS_BEACON_HEAD}>{ln}</text>
      ))}
      <text x={tx + tw / 2} y={localityY} textAnchor="middle" fontSize={FS_BEACON_HEAD} letterSpacing="1">
        {clampWords(meta.location, tw - 8, FS_BEACON_HEAD)}
      </text>

      {/* ===================== Right-side D.S.M / Approved / Director of
          Surveys column (client req 2026-08-22) — reference shows this as
          ONE continuous box (D.S.M No. at top, "Approved" and "Director of
          Surveys and Mapping" further down) with NO internal dividing
          lines between the three — only the box's own outer border. The
          top/left/right edges are already the frame's + table's own
          borders; only the box's closing bottom edge is new here. */}
      {/* Anchored right under the "D.S.M No." header (not tableBottom) —
          client req 2026-08-26: tableBottom moves with point count (a
          beacon-heavy plot's table now grows taller, Part 23-vs-consistency
          fix), which was dragging "Approved" down and leaving a big dead
          gap under the header. This column has no per-row data of its own,
          so keeping the block near the top reads correctly regardless of
          how tall the neighboring coordinate table gets. dsmApprovedY/
          dosY1/dosY2/dosLineY come from computeDiagramLayout (client req
          2026-08-26, Part 34) — the DXF export draws this same box from
          the same numbers. */}
      <>
        {/* Open at the bottom, like the top table (client req
            2026-08-22) — no closing border, just the left divider
            running down to the signature line below "and Mapping".
            Only extends past tableBottom if the block itself is taller
            than the table (never for a normal-sized plot). */}
        <line x1={xDsm} y1={tableBottom} x2={xDsm} y2={Math.max(tableBottom, dosLineY)} stroke="black" strokeWidth={1.2} />
        <text x={xDsm + 16} y={dsmApprovedY} fontSize={FS_BEACON_HEAD}>Approved</text>
        <text x={xDsm + 16} y={dosY1} fontSize={FS_BEACON_HEAD}>Director of Surveys</text>
        <text x={xDsm + 16} y={dosY2} fontSize={FS_BEACON_HEAD}>and Mapping</text>
        <line x1={xDsm + 16} y1={dosLineY} x2={tableRight - 16} y2={dosLineY} stroke="black" strokeWidth={1.2} />
      </>

      {/* ===================== North arrow + scale (left of the figure) ===================== */}
      {/* Moved to the LEFT side of the sheet (client req 2026-08-22) —
          mirrors the old right-side clamping logic: stay clear of whichever
          extends further left, the figure box's own left edge or the
          actual drawn boundary's left extent, without going past the
          frame's own left margin. */}
      {/* Thin outlined compass needle with a full-height "T-N" reference
          line, redrawn as a simple lopsided outline (client req
          2026-08-22) — a plain unfilled arrow silhouette threaded by a
          single vertical line down through the "T | N" label beneath it,
          not a bold solid-filled or symmetric shape. */}
      <g transform={`translate(${Math.max(tx + 90, Math.min(fig.x - 90, offX - 90))}, ${fig.y + 200})`}>
        <line x1={0} y1={-170} x2={0} y2={54} stroke="black" strokeWidth={1} />
        <polygon points="0,-170 -14,-55 4,-30" fill="none" stroke="black" strokeWidth={1.2} strokeLinejoin="round" />
        <text x={-6} y={24} textAnchor="end" fontSize={FS_BEACON_HEAD}>T</text>
        <text x={6} y={24} textAnchor="start" fontSize={FS_BEACON_HEAD}>N</text>
      </g>

      {/* Scale tag moved here, right above the legal-description block
          (client req 2026-08-22) — no longer under the north arrow. */}
      {meta.scale > 0 && (
        <text x={VB_W / 2} y={legalY0 - 40} textAnchor="middle" fontSize={FS_BEACON_HEAD} fontWeight="medium">
          SCALE 1:{meta.scale.toLocaleString()}
        </text>
      )}

      {/* ===================== FIGURE ===================== */}
      {parcels && parcels.length > 0 ? (
        parcels.map((pc, i) => {
          const ring = pc.points.map((p) => `${fx(p.east, p.north)},${fy(p.east, p.north)}`).join(" ");
          const col = PARCEL_COLORS[i % PARCEL_COLORS.length];
          const lcx = avg(pc.points.map((p) => fx(p.east, p.north)));
          const lcy = avg(pc.points.map((p) => fy(p.east, p.north)));
          return (
            <g key={`pc${i}`}>
              <polygon points={ring} fill={col} fillOpacity={0.12} stroke={col} strokeWidth={1.6} strokeLinejoin="round" />
              <text x={lcx} y={lcy} textAnchor="middle" fontSize={12} fontWeight="medium" fill={col}>{pc.number}</text>
            </g>
          );
        })
      ) : (
        <polygon points={rotatedPolyPoints} fill="none" stroke="black" strokeWidth={1.6} strokeLinejoin="round" />
      )}
      {(() => {
        // Point the label along each vertex's own angle bisector (away from
        // its two neighbors), verified with the same inside/outside test as
        // the side-distance labels — more reliable than a flat centroid
        // direction on a concave corner (client req 2026-08-21), where it
        // could point toward the interior and collide with a nearby side
        // label instead of clearing the figure. Used as the PREFERRED first
        // spot for decluttering (client req 2026-08-30) — a boundary with
        // hundreds of beacons close together (e.g. a General Plan's whole
        // outer ring, or a stress-test import) otherwise piles every label
        // on top of the next; every point's dot still always renders even
        // where its label gets nudged or, as a last resort, hidden.
        const candidates = points.map((p, i) => {
          const bx = fx(p.east, p.north), by = fy(p.east, p.north);
          const prev = points[(i - 1 + points.length) % points.length];
          const next = points[(i + 1) % points.length];
          const px = fx(prev.east, prev.north), py = fy(prev.east, prev.north);
          const qx = fx(next.east, next.north), qy = fy(next.east, next.north);
          const d1x = bx - px, d1y = by - py, l1 = Math.hypot(d1x, d1y) || 1;
          const d2x = bx - qx, d2y = by - qy, l2 = Math.hypot(d2x, d2y) || 1;
          let dx = d1x / l1 + d2x / l2, dy = d1y / l1 + d2y / l2;
          const dl = Math.hypot(dx, dy) || 1;
          dx /= dl; dy /= dl;
          if (rotInsidePoly(bx + dx * 10, by + dy * 10)) { dx = -dx; dy = -dy; }
          return { id: p.name || `#${i}`, x: bx, y: by, text: p.name ?? "", fontSize: FS_BEACON_HEAD, preferDx: dx * 40, preferDy: dy * 40 };
        });
        const placements = declutterLabels(candidates);
        return points.map((p, i) => {
          const bx = fx(p.east, p.north), by = fy(p.east, p.north);
          const pl = placements[i];
          return (
            <g key={`bcn${i}`}>
              <circle cx={bx} cy={by} r={5} fill="white" stroke="black" strokeWidth={1.2} />
              {pl.leader && <line x1={bx} y1={by} x2={pl.labelX} y2={pl.labelY} stroke="#999" strokeWidth={0.5} />}
              {!pl.hidden && (
                <text x={pl.labelX} y={pl.labelY + 4} textAnchor="middle" fontSize={FS_BEACON_HEAD} fontWeight="medium">{p.name}</text>
              )}
            </g>
          );
        });
      })()}
      {/* Side distances are NOT drawn on the figure itself by default
          (client req 2026-08-23) — they're already tabulated in the SIDES
          METRES column of the top table; repeating them on the boundary
          lines was redundant clutter the client explicitly crossed out. */}
      {/* Manually-drawn adjoining-parcel extension lines (client req
          2026-08-22, Part 24) — the surveyor draws these directly on the
          rendered diagram (there's no survey data to compute them from),
          so they're plain SVG-space lines + free-text labels, not derived
          from a boundary side. Never coloured, even when selected, so a
          print/export taken mid-edit still reads as plain black-and-white. */}
      {/* No label on these — they only mark that a side borders a
          neighbouring plot (client req 2026-08-23), not which one. */}
      {/* Selected line gets a move-handle (drag anywhere on the line to
          translate it) and an end-handle at each tip (drag to rotate/
          resize around the other end) — client req 2026-08-23: "select,
          move, rotate/tilt the extension lines." A wider transparent
          "hit" line sits under the visible dashed one so the line is easy
          to grab without needing pixel-perfect precision on the thin
          dashed stroke itself. */}
      {(manualAnnotations ?? []).map((a) => {
        const isSel = selectedAnnotationId === a.id;
        const x1 = fx(a.e1, a.n1), y1 = fy(a.e1, a.n1), x2 = fx(a.e2, a.n2), y2 = fy(a.e2, a.n2);
        return (
          <g key={a.id}>
            <line
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke="transparent"
              strokeWidth={16}
              onClick={(e) => { e.stopPropagation(); onAnnotationClick?.(a.id, e); }}
              onPointerDown={(e) => { if (isSel) { e.stopPropagation(); onAnnotationHandleDown?.(a.id, "move", e); } }}
              style={{ cursor: isSel ? "move" : "pointer" }}
            />
            <line
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke="black"
              strokeWidth={isSel ? 3 : 1.8}
              strokeDasharray="16 10"
              style={{ pointerEvents: "none" }}
            />
            {isSel && (
              <>
                <circle
                  cx={x1} cy={y1} r={9} fill="white" stroke="black" strokeWidth={1.4}
                  onPointerDown={(e) => { e.stopPropagation(); onAnnotationHandleDown?.(a.id, "start", e); }}
                  onClick={(e) => e.stopPropagation()}
                  style={{ cursor: "grab" }}
                />
                <circle
                  cx={x2} cy={y2} r={9} fill="white" stroke="black" strokeWidth={1.4}
                  onPointerDown={(e) => { e.stopPropagation(); onAnnotationHandleDown?.(a.id, "end", e); }}
                  onClick={(e) => e.stopPropagation()}
                  style={{ cursor: "grab" }}
                />
              </>
            )}
          </g>
        );
      })}
      {pendingAnnotationPoint && (
        <circle cx={pendingAnnotationPoint.x} cy={pendingAnnotationPoint.y} r={5} fill="black" />
      )}
      {/* Free-text notes the surveyor placed directly on the diagram
          (client req 2026-08-24), rotatable (client req 2026-08-26) via an
          Angle field in the Add/Edit Text panel. A selected note shows a
          small grip handle at its anchor instead of an underline (client
          req 2026-08-26: "remove the underlining feature" — it read as
          part of the text's own styling, not a selection indicator). */}
      {(manualTexts ?? []).map((t) => {
        const isSel = selectedTextId === t.id;
        const x = fx(t.east, t.north), y = fy(t.east, t.north);
        const textAngle = (flip ? -(t.angle || 0) : (t.angle || 0)) + rotation;
        return (
          <g key={t.id} transform={textAngle ? `rotate(${textAngle} ${x} ${y})` : undefined}>
            <text
              x={x} y={y}
              fontSize={FS_BEACON_HEAD}
              onClick={(e) => { e.stopPropagation(); onTextClick?.(t.id, e); }}
              onDoubleClick={(e) => { e.stopPropagation(); onTextDoubleClick?.(t.id); }}
              onPointerDown={(e) => { if (isSel) { e.stopPropagation(); onTextHandleDown?.(t.id, e); } }}
              style={{ cursor: isSel ? "move" : "pointer" }}
            >
              {t.text}
            </text>
            {isSel && (
              <circle
                cx={x} cy={y - FS_BEACON_HEAD * 0.35} r={5} fill="white" stroke="black" strokeWidth={1.2}
                style={{ pointerEvents: "none" }}
              />
            )}
          </g>
        );
      })}
      {/* Extra points: shown as marks only (dot + label) — NOT part of the traverse
          (no boundary side, no coordinate-table row). */}
      {(extraPoints ?? []).map((p, i) => (
        <g key={`xp${i}`}>
          <circle cx={fx(p.east, p.north)} cy={fy(p.east, p.north)} r={5} fill="black" />
          <text x={fx(p.east, p.north) + 12} y={fy(p.east, p.north) + 4} fontSize={FS_BEACON_HEAD} textAnchor="middle">
            {p.name}
          </text>
        </g>
      ))}

      {/* ===================== LEGAL DESCRIPTION ===================== */}
      {(() => {
        const landCalledY0 = legalY0 + figureLines.length * LEGAL_LH;
        // Optional "(A PORTION OF ...)" ancestry line(s) sit right after the
        // underlined lot name, one per non-blank parent field (client req
        // 2026-08-23) — SITUATE AT follows after however many of those (and
        // however many lines each one itself wraps to, client req
        // 2026-08-24) print.
        const parentY0 = landCalledY0 + landCalledLines.length * LEGAL_LH;
        const parentTotalLines = parentLineGroups.reduce((a, g) => a + g.length, 0);
        const situateY0 = parentY0 + parentTotalLines * LEGAL_LH;
        // Certification + deductions note sit on two tight, back-to-back
        // lines with no gap between them (client req 2026-08-22) — was
        // previously split across "Surveyed"/"IN ... BY ME," on separate
        // lines, duplicating (and drifting from) the already-exported
        // certificationLine() helper; now uses it directly for one line.
        // Anchored just above the registration table's own top border
        // (client req 2026-08-22: "sit right above that line"), not
        // floating wherever the legal-description flow happens to end.
        const deductionsY = annTop - 20;
        const certY1 = deductionsY - FS_CERT * 1.15;
        const leftColW = VB_W - 700 - (tx + 4) - 20;
        const rightColW = tableRight - (VB_W - 700) - 20;
        // A higher word cap than the default 5 — "Surveyed in FEBRUARY 2026
        // by me," is already 6 words in the ordinary case (more for
        // Compiled/Framed, which also fold in a source-document
        // reference), so the default would truncate perfectly normal text.
        // The character-width fallback still catches genuinely long input.
        const cert = clampWords(certificationLine(meta), leftColW, FS_BEACON_HEAD, 12);
        const surveyorFit = clampWords(meta.surveyor, rightColW, FS_BEACON_HEAD);
        let parentLine = 0;
        return (
          <>
            <g textAnchor="middle">
              {figureLines.map((line, i) => (
                <text key={i} x={VB_W / 2} y={legalY0 + i * LEGAL_LH} fontSize={FS_LEGAL} fontWeight="medium">
                  {line}
                </text>
              ))}
              {landCalledLines.map((line, i) => (
                <text key={i} x={VB_W / 2} y={landCalledY0 + i * LEGAL_LH} fontSize={FS_LANDCALLED} fontWeight="medium" textDecoration="underline">
                  {line}
                </text>
              ))}
              {parentLineGroups.map((group, gi) =>
                group.map((line, li) => {
                  const y = parentY0 + parentLine * LEGAL_LH;
                  parentLine += 1;
                  return (
                    <text key={`${gi}-${li}`} x={VB_W / 2} y={y} fontSize={FS_LEGAL} fontWeight="medium">
                      {line}
                    </text>
                  );
                })
              )}
              {situateLines.map((line, i) => (
                <text key={i} x={VB_W / 2} y={situateY0 + i * LEGAL_LH} fontSize={FS_BEACON_HEAD}>
                  {line}
                </text>
              ))}
            </g>

            {/* ===================== certification/deductions (left) + surveyor (right) ===================== */}
            <text x={tx + 4} y={certY1} fontSize={FS_BEACON_HEAD}>{cert}</text>
            <text x={tx + 4} y={deductionsY} fontSize={FS_BEACON_HEAD}>DEDUCTIONS ON THIS DIAGRAM ARE MADE ON THE BACK HEREOF</text>
            {/* Plain/simple styling (client req 2026-08-22) — no bold, no
                forced caps, no signature line above; prints exactly
                whatever the surveyor field and the fixed "Land Surveyor"
                title read. */}
            <text x={VB_W - 700} y={certY1} fontSize={FS_BEACON_HEAD}>{surveyorFit}</text>
            <text x={VB_W - 700} y={deductionsY} fontSize={FS_BEACON_HEAD}>Land Surveyor</text>
          </>
        );
      })()}

      {/* ===================== deeds/annexure table ===================== */}
      {/* Every value here is a single fixed-height row with no room to wrap
          onto a second line — an unusually long field value used to just
          run past its column and collide with whatever printed next to it
          (client req 2026-08-24), so each one shrinks-to-fit (and, only if
          still too long even at the floor size, truncates with "…")
          instead. */}
      {(() => {
        // The value column used to start at a flat annC2+200 regardless of
        // the row's own label — fine while every label was short enough to
        // clear it, but "General Plan No." and "Degree Square:" are already
        // wider than that gap on their own, so the value ran straight into
        // the label even with a perfectly ordinary value (client req
        // 2026-08-24). Each row's value now starts right after its own
        // label's actual (estimated) width instead of a shared fixed x.
        const valueX = (label: string) => annC2 + 12 + label.length * FS_BEACON_HEAD * 0.62 + 16;
        const gpNoX = valueX("General Plan No.");
        const srNoX = valueX("S.R No.");
        const dsmFileX = valueX("D.S.M File:");
        const compX = valueX("Comp.");
        const degreeSquareX = valueX("Degree Square:");
        const lirNoX = valueX("LIR No:");
        const gpNo = clampWords(dash(meta.gpNo), tableRight - gpNoX - 10, FS_BEACON_HEAD);
        const srNo = clampWords(dash(meta.srNo), tableRight - srNoX - 10, FS_BEACON_HEAD);
        const dsmFile = clampWords(dash(meta.dsmFile), tableRight - dsmFileX - 10, FS_BEACON_HEAD);
        const comp = clampWords(dash(meta.comp), tableRight - compX - 10, FS_BEACON_HEAD);
        const degreeSquare = clampWords(dash(meta.degreeSquare), tableRight - degreeSquareX - 10, FS_BEACON_HEAD);
        const lirNo = clampWords(dash(meta.lirNo), tableRight - lirNoX - 10, FS_BEACON_HEAD);
        const annexedTo = clampWords(`No. ${dash(meta.annexedToNo)}`, annC1 - (tx + 10) - 10, FS_BEACON_HEAD);
        const annexedDate = clampWords(`Dated ${dash(meta.annexedDate)}`, annC1 - 140 - (tx + 10) - 20, FS_BEACON_HEAD);
        const annexedFavour = clampWords(`of ${dash(meta.annexedInFavourOf)}`, annC1 - (tx + 10) - 10, FS_BEACON_HEAD);
        // Wraps to a second line instead of shrinking (client req
        // 2026-08-24: "it should not go beyond the boundary.. it should go
        // to next line") — capped at 2 lines: that's all the room there is
        // before "Registrar of Deeds" below it, so a 3rd line (e.g. from a
        // long unbroken run with no word breaks) folds into the 2nd and
        // ellipsizes there instead of climbing into the "of ___" line above
        // (found via stress-test data). The last line keeps the field's
        // original fixed Y so a short name (the common case) renders in
        // exactly the same spot as before.
        const annexNameLines = meta.annexName && meta.annexName.trim()
          ? clampToLines(meta.annexName, annC1 - tx - 40, FS_BEACON_HEAD, 2)
          : [];
        const ANNEX_NAME_LH = FS_BEACON_HEAD * 1.15;
        const parentDiagramNo = clampWords(`No. ${dash(meta.parentDiagramNo || meta.parentDiagram)}`, annC2 - (annC1 + 50) - 10, FS_BEACON_HEAD);
        return (
          <g fontSize={FS_BEACON_HEAD}>
            <rect x={tx} y={annTop} width={tw} height={annBottom - annTop} fill="none" stroke="black" strokeWidth={1.2} />
            <line x1={annC1} y1={annTop} x2={annC1} y2={annBottom} stroke="black" strokeWidth={1} />
            <line x1={annC2} y1={annTop} x2={annC2} y2={annBottom} stroke="black" strokeWidth={1} />

            {/* left — Deeds Registry annexure */}
            <text x={tx + 10} y={annTop + 40}>This diagram is annexed to</text>
            <text x={tx + 10} y={annTop + 90}>{annexedTo}</text>
            <text x={tx + 10} y={annTop + 140}>{annexedDate}</text>
            <text x={annC1 - 140} y={annTop + 140}>in favour</text>
            <text x={tx + 10} y={annTop + 190}>{annexedFavour}</text>
            {annexNameLines.map((line, i) => (
              <text
                key={i}
                x={(tx + annC1) / 2}
                y={annBottom - 46 - (annexNameLines.length - 1 - i) * ANNEX_NAME_LH}
                textAnchor="middle"
                fontSize={FS_BEACON_HEAD}
              >
                {line}
              </text>
            ))}
            <text x={(tx + annC1) / 2} y={annBottom - 14} textAnchor="middle" fontSize={FS_BEACON_HEAD}>
              Registrar of Deeds
            </text>

            {/* middle — immediate parent diagram */}
            <text x={annC1 + 10} y={annTop + 40}>The immediate parent diagram is</text>
            <text x={annC2 - 14} y={annTop + 90} textAnchor="end">Annexed</text>
            <text x={annC1 + 10} y={annTop + 140}>to</text>
            <text x={annC1 + 50} y={annTop + 140}>{parentDiagramNo}</text>

            {/* right — registration numbers (label + value in an aligned column, with a gap) */}
            <text x={annC2 + 12} y={annTop + 40}>General Plan No.</text>
            <text x={gpNoX} y={annTop + 40}>{gpNo}</text>
            <text x={annC2 + 12} y={annTop + 90}>S.R No.</text>
            <text x={srNoX} y={annTop + 90}>{srNo}</text>
            <text x={annC2 + 12} y={annTop + 140}>D.S.M File:</text>
            <text x={dsmFileX} y={annTop + 140}>{dsmFile}</text>
            <text x={annC2 + 12} y={annTop + 190}>Comp.</text>
            <text x={compX} y={annTop + 190}>{comp}</text>
            <text x={annC2 + 12} y={annTop + 240}>Degree Square:</text>
            <text x={degreeSquareX} y={annTop + 240}>{degreeSquare}</text>
            <text x={annC2 + 12} y={annTop + 290}>LIR No:</text>
            <text x={lirNoX} y={annTop + 290}>{lirNo}</text>
          </g>
        );
      })()}
    </svg>
  );
});
