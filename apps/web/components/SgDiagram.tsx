"use client";

import { forwardRef, type MouseEvent } from "react";
import { wrapSvgWords } from "@/lib/wrapSvgText";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface DiagramPoint {
  name: string | null;
  east: number;
  north: number;
}

export interface DiagramSide {
  from: string | null;
  to: string | null;
  bearing_dms: string;
  distance: number;
}

/** Which Botswana diagram/sketch template to render. */
export type DiagramKind = "surveyed" | "compiled" | "framed" | "borehole" | "lease";

export interface DiagramMeta {
  lotName: string;        // e.g. "LOT 3508 MATEBELE"
  parent: string;         // e.g. "A PORTION OF CADASTRE 21"
  location: string;       // e.g. "MATEBELE"
  tribalArea: string;     // e.g. "BAKGATLA TRIBAL TERRITORY"
  surveyor: string;       // e.g. "I.N. MULALU"
  surveyedDate: string;   // e.g. "December 2025"
  coordinateSystem: string; // e.g. "LO. 27°"
  scale: number;          // e.g. 7500
  dsmNo: string;          // "D.S.M No." e.g. "8586/2025"
  srNo: string;
  gpNo: string;
  degreeSquare: string;
  beaconDescription: string; // e.g. "All Beacons:12mm Iron Peg"
  areaHa: number;
  closed: boolean;
  kind?: DiagramKind;        // template variant (defaults to "surveyed")
  sourceRef?: string;        // Compiled-from / Framed-from source document(s)
  boreholeNo?: string;       // borehole identifier (borehole template)
  boreholeE?: number;        // surveyed borehole Easting (0 = use centroid)
  boreholeN?: number;        // surveyed borehole Northing
  parentDiagram?: string;    // (legacy) immediate parent diagram No.
  // Deeds-registration block (bottom annexure table — Botswana SG template).
  dsmFile?: string;          // "D.S.M File:" e.g. "CAD T9"
  comp?: string;             // "Comp."
  lirNo?: string;            // "LIR No:"
  annexedToNo?: string;      // "This diagram is annexed to ... No."
  annexedDate?: string;      // "Dated"
  annexedInFavourOf?: string;// "in favour of"
  parentDiagramNo?: string;  // "The immediate parent diagram is annexed to No."
  annexName?: string;        // optional name printed above "Registrar of Deeds"
}

/** Certification line wording — differs per diagram type per SG convention. */
export function certificationLine(meta: DiagramMeta): string {
  switch (meta.kind) {
    case "compiled":
      return `Compiled${meta.sourceRef ? ` from ${meta.sourceRef}` : ""} in ${meta.surveyedDate} by me,`;
    case "framed":
      return `Framed${meta.sourceRef ? ` from ${meta.sourceRef}` : ""} in ${meta.surveyedDate} by me,`;
    default:
      return `Surveyed in ${meta.surveyedDate} by me,`;
  }
}

/** A hand-drawn dashed extension line + free-text label on the diagram
 *  (client req 2026-08-22, Part 24) — the client clarified these lines are
 *  added manually by the surveyor (there's no reliable survey data to
 *  compute them from), so they're plain SVG-space coordinates the user
 *  clicked on the rendered diagram itself, not derived from a boundary
 *  side. Persisted with the diagram so they round-trip and appear in the
 *  exported SVG/PDF. */
export interface ManualAnnotation {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label: string;
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
}

const PARCEL_COLORS = ["#0d9488", "#2563eb", "#db2777", "#d97706", "#7c3aed", "#16a34a", "#dc2626", "#0891b2"];

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------
function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Signed coordinate with grouped thousands: 93205.88 -> "+93 205,88"
 *  (shared with WorkingPlan / Borehole / Lease sketches). */
export function fmtCoord(n: number): string {
  const sign = n < 0 ? "-" : "+";
  const [i, f] = Math.abs(n).toFixed(2).split(".");
  return `${sign}${groupThousands(i)},${f}`;
}

/** Distance with grouped thousands: 408.24 -> "408,24" */
export function fmtDist(n: number): string {
  const [i, f] = n.toFixed(2).split(".");
  return `${groupThousands(i)},${f}`;
}

// Coordinate-table formats matching the official SG template exactly: PERIOD
// decimal, NO thousands grouping (e.g. "+58737.55", "36.15"). Only the CONSTANTS
// row shows the comma form "0,00".
function tCoord(n: number): string {
  return `${n < 0 ? "-" : "+"}${Math.abs(n).toFixed(2)}`;
}
function tDist(n: number): string {
  return n.toFixed(2);
}
/** Side row-label: "AB" for single-letter beacons (the official SG
 *  convention), but bare concatenation of longer point names is
 *  unreadable ("25A225A1" — is that 25A2→25A1, or something else?), so
 *  those get a separator instead (client req 2026-08-22). */
function sideLabel(from: string | null, to: string | null): string {
  const f = from ?? "", t = to ?? "";
  return f.length <= 1 && t.length <= 1 ? `${f}${t}` : `${f}-${t}`;
}
/** Sequential boundary letter — A, B, ... Z, AA, AB, ... (client req
 *  2026-08-23: the diagram must letter the boundary A, B, C, ... on the
 *  official sheet regardless of what the underlying survey data calls
 *  those points, e.g. "25A2"/"M1" — same as every SG reference sample). */
function boundaryLetter(i: number): string {
  let n = i, s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}
/** Area line: small plots in SQUARE METRES, larger in HECTARES (SG convention). */
function areaText(areaHa: number): string {
  return areaHa < 1
    ? `${Math.round(areaHa * 10000).toLocaleString("en-US")} SQUARE METRES`
    : `${areaHa.toFixed(4)} HECTARES`;
}
/** Coordinate-system label in SG form: "Lo 29" -> "LO. 29°". */
function fmtSystem(cs: string): string {
  const m = cs.match(/Lo\s*(\d+)/i);
  return m ? `LO. ${m[1]}°` : cs;
}

/** "272°36'20\"" (or "272 36 20") -> "272.36.20" (Botswana DIRECTIONS notation) */
export function toDotted(dms: string): string {
  const m = dms.match(/(-?\d+)\D+(\d+)\D+(\d+(?:\.\d+)?)/);
  if (!m) return dms;
  const ss = Math.round(parseFloat(m[3]));
  return `${m[1]}.${m[2].padStart(2, "0")}.${String(ss).padStart(2, "0")}`;
}

const avg = (ns: number[]) => ns.reduce((a, b) => a + b, 0) / (ns.length || 1);

// ---------------------------------------------------------------------------
// Component — Botswana SG cadastral diagram, portrait A4, faithful to the
// official template (Lot 3508 MATEBELE sample). Only the figure changes with
// the coordinates; the layout/structure is fixed.
// ---------------------------------------------------------------------------
export const SgDiagram = forwardRef<SVGSVGElement, Props>(function SgDiagram(
  { meta, points: rawPoints, sides: rawSides, parcels, extraPoints, manualAnnotations, pendingAnnotationPoint, selectedAnnotationId, drawMode, onCanvasClick, onAnnotationClick },
  ref
) {
  // The diagram always letters the boundary A, B, C, ... on the printed
  // sheet, ignoring whatever the survey data actually calls each point
  // (client req 2026-08-23) — geometry (east/north) is untouched, only the
  // display name changes, and only for the certified boundary; extraPoints
  // (witness/reference marks, not part of "the figure") keep their real
  // names. Every side is assumed to join points[i] -> points[i+1], the
  // same adjacency already relied on elsewhere in this file (vertex
  // labels, side-distance labels), so sides relabel the same way.
  const points = rawPoints.map((p, i) => ({ ...p, name: boundaryLetter(i) }));
  const sides = rawSides.map((s, i) => ({ ...s, from: boundaryLetter(i), to: boundaryLetter((i + 1) % rawPoints.length) }));
  // ---------------------------------------------------------------------
  // Exact page geometry (client req 2026-08-22, Part 23) — measured
  // directly from the vector geometry of the client's official "Lot 15267
  // Bobonong" reference PDF (not eyeballed), on their explicit "nothing
  // should be off" instruction. The viewBox now represents the FULL A4
  // page at MM=10 units/mm, so every number below is literally the
  // client's mm figure * MM (e.g. FRAME_X = 24.8mm * 10 = 248 means
  // 24.8mm from the page's own left edge) — trivial to re-check against
  // the reference the same way it was measured. This also fixes the
  // print-pagination bug class at its root: the SVG's own size now IS the
  // A4 page size, so print CSS no longer needs a separate margin hack to
  // position the frame on the page (see Diagrams.tsx's printDiagram()).
  // ---------------------------------------------------------------------
  const MM = 10;
  const VB_W = 210 * MM; // 2100 — full A4 width
  const VB_H = 297 * MM; // 2970 — full A4 height

  const FRAME_X = 24.8 * MM;
  const FRAME_Y = 12.2 * MM;
  const FRAME_W = 160.4 * MM;
  const FRAME_H = 272.9 * MM;
  const FRAME_RIGHT = FRAME_X + FRAME_W;
  const FRAME_BOTTOM = FRAME_Y + FRAME_H;

  // Font sizes — increased across the board per the client's explicit
  // "increase font" feedback comparing the app's output to the reference.
  const FS_TABLE_HEAD = 32, FS_TABLE_SUB = 28, FS_CONSTANTS = 23;
  const FS_BEACON_HEAD = 34, FS_BEACON = 31, FS_LOCALITY = 38;
  const FS_DOS = 29, FS_ARROW = 26, FS_SCALE = 26;
  const FS_VERTEX = 36, FS_SIDE_LONG = 30, FS_SIDE_SHORT = 23, FS_NEIGHBOR = 23;
  const FS_LEGAL = 37, FS_LANDCALLED = 37, FS_PARENT = 31, FS_CERT = 31;
  const FS_SURVEYOR = 26, FS_SURVEYOR_TITLE = 25, FS_FOOTER = 21, FS_ANNEX = 24;

  // ---- top data table: fixed 51.0mm band, 14.0mm header (client req,
  // Part 23) — the table no longer grows the page as points are added;
  // its 37.0mm data area's row height shrinks instead, so the band below
  // it (and therefore the bottom registration table's position) never
  // moves regardless of how many boundary points a plot has. ----
  const tx = FRAME_X;
  const tw = FRAME_W;
  const ty = FRAME_Y;
  const headH = 14.0 * MM;
  const topBandH = 51.0 * MM;
  const tableBottom = ty + topBandH;
  const dataTop = ty + headH;
  const dataH = topBandH - headH;
  const n = Math.max(points.length, sides.length, 1);
  const rowH = dataH / n;
  const dataFS = Math.max(17, Math.min(FS_TABLE_SUB, rowH * 0.55));

  // column x boundaries — cumulative from the frame's own left edge,
  // widths per Part 23 (7.9 / 25.6 / 27.9 / 6.6 / 25.5 / 27.0 / 39.9mm).
  // The 7.9mm row-label width matches the reference's single-letter names
  // (AB, BC, ...) exactly — real projects can have longer point names
  // (client req 2026-08-22: "25A2-25A1" etc.), so this column grows to fit
  // the widest actual label instead of clipping/overlapping it, borrowing
  // spare room from the D.S.M No. box (which only ever holds one short
  // number) rather than moving the frame or any other fixed measurement.
  const maxSideLabelChars = Math.max(2, ...sides.map((s) => sideLabel(s.from, s.to).length));
  const sideValExtra = Math.min(200, Math.max(0, maxSideLabelChars * dataFS * 0.62 + 16 - 7.9 * MM));
  const xSideVal = tx + 7.9 * MM + sideValExtra; // between the row-label and its distance value
  const xMetR = xSideVal + 25.6 * MM; // right of SIDES/METRES group
  const xDir = xMetR;                       // DIRECTIONS column
  const xDirR = xDir + 27.9 * MM;           // right of DIRECTIONS
  const xPt = xDirR;                        // point-letter column
  const xPtR = xPt + 6.6 * MM;
  const xY = xPtR;                          // Y coordinate column
  const xYR = xY + 25.5 * MM;
  const xX = xYR;                           // X coordinate column
  const xXR = xX + 27.0 * MM;
  // Shifted a bit left of the exact Part 23 boundary (client req
  // 2026-08-23) — widens the D.S.M/Approved/Director column slightly;
  // exact figure to follow once the client sends their own measurement.
  const xDsm = xXR - 40;                    // D.S.M No. box
  const tableRight = tx + tw;               // = FRAME_RIGHT
  // header sub-row baselines and the partial-height Y/X dividers (no exact
  // figures given for these internal header rows — proportioned the same
  // way the old 3-row header split its 66-unit band, scaled to the new
  // fixed 14.0mm headH).
  const hRow1 = ty + headH * 0.26, hRow2 = ty + headH * 0.56, hRow3 = ty + headH * 0.9;
  // Both start at the same height (client req 2026-08-22) — they only
  // become two separate columns below the shared "System LO. N°" label,
  // so the X divider must not start higher up than the Y divider.
  const xYDividerTop = ty + headH * 0.667;
  const xXDividerTop = ty + headH * 0.667;

  // ---- bottom registration table (Part 23) — fixed 34.0mm band starting
  // 251.1mm from the page top, dividers at 53.4mm/111.4mm from the
  // frame's left edge. Independent of the top table's row count. ----
  const annTop = 251.1 * MM;
  const annBottom = 285.1 * MM; // = FRAME_BOTTOM
  const annC1 = FRAME_X + 53.4 * MM;
  const annC2 = FRAME_X + 111.4 * MM;
  const dash = (v?: string) => (v && v.trim() ? v : "");

  // ---- middle zone (Part 19 items 2-7: beacon description, locality,
  // Director of Surveys line, the boundary drawing w/ north arrow+scale,
  // certificate paragraph, surveyor signature line) — Part 23 gives no
  // fixed sub-measurements here, only the ~188mm total budget between the
  // two tables ("lay these out with even, uncramped spacing"). ----
  const midTop = tableBottom;
  const es = points.map((p) => p.east);
  const nsv = points.map((p) => p.north);
  const figureLetters =
    points.map((p) => p.name ?? "?").join(" ") + (meta.closed ? ` ${points[0]?.name ?? ""}` : "");
  const figureLines = wrapSvgWords(
    ["THE", "FIGURE", ...figureLetters.split(/\s+/).filter(Boolean), "REPRESENTS", ...areaText(meta.areaHa).split(" "), "OF", "LAND", "CALLED"],
    tw - 80,
    FS_LEGAL
  );
  const LEGAL_LH = FS_LEGAL * 1.5;
  // Reserve room at the bottom of the middle zone for the legal-description
  // block (however many lines it wraps to) + the certificate/surveyor
  // lines, so the figure box above it never overlaps this text no matter
  // how long the point-letter string gets.
  const legalBlockH = (figureLines.length + 7) * LEGAL_LH + 60;
  const legalY0 = annTop - legalBlockH;

  // Beacon Description (dynamic line count) + locality name sit right
  // below the top table; the figure gets whatever's left above the legal
  // block reserve.
  const beaconLines = meta.beaconDescription.split(/\s*[;\n]\s*/).filter(Boolean);
  const BD_LH = FS_BEACON * 1.35;
  const bdHeadingY = midTop + 40;
  const bdLinesY0 = midTop + 74;
  const bdBlockBottom = bdLinesY0 + Math.max(beaconLines.length, 1) * BD_LH;
  const localityY = bdBlockBottom + 44;

  const figTop = localityY + 44;
  const figBottom = Math.max(figTop + 400, legalY0 - 40);
  // Reserve the extra margin on the LEFT of the figure box, not the right
  // (client req 2026-08-22) — the north arrow moved to the left side of the
  // sheet, so that's where the box now needs the spare 300 units of room.
  const fig = { x: tx + 300, y: figTop, w: tw - 300 - 60, h: figBottom - figTop };
  const pad = 60;
  // Figure bounds include any extra (non-traverse) marks so they stay visible.
  const bE = [...es, ...(extraPoints ?? []).map((p) => p.east)];
  const bN = [...nsv, ...(extraPoints ?? []).map((p) => p.north)];
  const minE = Math.min(...bE), maxE = Math.max(...bE);
  const minN = Math.min(...bN), maxN = Math.max(...bN);
  const spanE = Math.max(maxE - minE, 1e-6);
  const spanN = Math.max(maxN - minN, 1e-6);
  // Draw at the actual chosen scale (client req 2026-08-21, Part 14) — the
  // printed "SCALE 1:N" label used to be purely cosmetic, with the figure
  // always auto-fit to the box regardless of meta.scale. MM=10 units/mm,
  // so at 1:N, 1m of real distance is (1000/N)mm on paper = 10000/N VB
  // units. A larger N (e.g. 5000 vs 2500) correctly makes the same
  // boundary draw smaller. Falls back to fitting the box only if scale is
  // unset/invalid (e.g. an older saved project).
  const sc = meta.scale > 0 ? 10000 / meta.scale : Math.min((fig.w - 2 * pad) / spanE, (fig.h - 2 * pad) / spanN);
  const dw = spanE * sc, dh = spanN * sc;
  const offX = fig.x + (fig.w - dw) / 2;
  const offY = fig.y + (fig.h - dh) / 2;
  const toX = (e: number) => offX + (e - minE) * sc;
  const toY = (north: number) => offY + (maxN - north) * sc;
  const cx = toX(avg(es)), cy = toY(avg(nsv));
  const polyPoints = points.map((p) => `${toX(p.east)},${toY(p.north)}`).join(" ");
  // Screen-space vertices + point-in-polygon test, used to pick which side of
  // a boundary segment is actually "outside" the shape (client req
  // 2026-08-21 — the earlier centroid-direction heuristic put distance
  // labels on the wrong side for concave/irregular boundaries, overlapping
  // the figure). Correct for any polygon shape, convex or not.
  const screenPts = points.map((p) => ({ x: toX(p.east), y: toY(p.north) }));
  function insidePoly(px: number, py: number): boolean {
    let inside = false;
    for (let i = 0, j = screenPts.length - 1; i < screenPts.length; j = i++) {
      const a = screenPts[i], b = screenPts[j];
      const hit = a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x;
      if (hit) inside = !inside;
    }
    return inside;
  }
  // "LAND CALLED" line carries the village/location too, e.g. "LOT 323 CHARLESHILL".
  const landCalled =
    meta.location && !meta.lotName.toUpperCase().includes(meta.location.trim().toUpperCase())
      ? `${meta.lotName} ${meta.location}`
      : meta.lotName;

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      xmlns="http://www.w3.org/2000/svg"
      fill="#000"
      onClick={onCanvasClick}
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
            merged "SIDES METRES" heading above it. */}
        <line x1={xSideVal} y1={dataTop} x2={xSideVal} y2={tableBottom} stroke="black" strokeWidth={0.5} />
        <line x1={xMetR} y1={ty} x2={xMetR} y2={tableBottom} stroke="black" strokeWidth={0.7} />
        <line x1={xDirR} y1={ty} x2={xDirR} y2={tableBottom} stroke="black" strokeWidth={0.7} />
        <line x1={xY} y1={xYDividerTop} x2={xY} y2={tableBottom} stroke="black" strokeWidth={0.5} />
        <line x1={xX} y1={xXDividerTop} x2={xX} y2={tableBottom} stroke="black" strokeWidth={0.5} />
        <line x1={xDsm} y1={ty} x2={xDsm} y2={tableBottom} stroke="black" strokeWidth={0.7} />
        {/* header underline */}
        <line x1={tx} y1={ty + headH} x2={xDsm} y2={ty + headH} stroke="black" strokeWidth={0.7} />

        {/* header row 1 */}
        <text x={(tx + xMetR) / 2} y={hRow1} textAnchor="middle" fontWeight="medium" fontSize={FS_TABLE_HEAD}>SIDES</text>
        <text x={(xDir + xDirR) / 2} y={hRow1} textAnchor="middle" fontWeight="medium" fontSize={FS_TABLE_HEAD}>DIRECTIONS</text>
        <text x={(xPt + xXR) / 2} y={hRow1} textAnchor="middle" fontWeight="medium" fontSize={FS_TABLE_HEAD}>CO-ORDINATES</text>
        <text x={(xDsm + tableRight) / 2} y={hRow1} textAnchor="middle" fontWeight="medium" fontSize={FS_TABLE_HEAD}>D.S.M No.</text>
        {/* header row 2 */}
        <text x={(tx + xMetR) / 2} y={hRow2} textAnchor="middle" fontWeight="medium" fontSize={FS_TABLE_SUB}>METRES</text>
        <text x={xPt + (xY - xPt) / 2} y={hRow2} textAnchor="middle" fontSize={FS_TABLE_SUB} fontWeight="medium">Y</text>
        <text x={(xY + xXR) / 2} y={hRow2} textAnchor="middle" fontSize={FS_TABLE_SUB}>System {fmtSystem(meta.coordinateSystem)}</text>
        <text x={xX + (xXR - xX) / 2} y={hRow2} textAnchor="middle" fontSize={FS_TABLE_SUB} fontWeight="medium">X</text>
        <text x={(xDsm + tableRight) / 2} y={hRow2} textAnchor="middle" fontSize={FS_TABLE_HEAD}>{meta.dsmNo || ""}</text>
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
      <text x={tx + tw / 2} y={localityY} textAnchor="middle" fontSize={FS_BEACON_HEAD} letterSpacing="1">{meta.location}</text>

      {/* ===================== Right-side D.S.M / Approved / Director of
          Surveys column (client req 2026-08-22) — reference shows this as
          ONE continuous box (D.S.M No. at top, "Approved" and "Director of
          Surveys and Mapping" further down) with NO internal dividing
          lines between the three — only the box's own outer border. The
          top/left/right edges are already the frame's + table's own
          borders; only the box's closing bottom edge is new here. */}
      {(() => {
        const dsmApprovedY = tableBottom + 25;
        const dosY1 = tableBottom + 100;
        const dosY2 = dosY1 + FS_DOS * 1.3;
        const dosLineY = dosY2 + FS_DOS * 1.1;
        return (
          <>
            {/* Open at the bottom, like the top table (client req
                2026-08-22) — no closing border, just the left divider
                running down to the signature line below "and Mapping". */}
            <line x1={xDsm} y1={tableBottom} x2={xDsm} y2={dosLineY} stroke="black" strokeWidth={1} />
            <text x={xDsm + 16} y={dsmApprovedY} fontSize={FS_BEACON_HEAD}>Approved</text>
            <text x={xDsm + 16} y={dosY1} fontSize={FS_BEACON_HEAD}>Director of Surveys</text>
            <text x={xDsm + 16} y={dosY2} fontSize={FS_BEACON_HEAD}>and Mapping</text>
            <line x1={xDsm + 16} y1={dosLineY} x2={tableRight - 16} y2={dosLineY} stroke="black" strokeWidth={1} />
          </>
        );
      })()}

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
          const ring = pc.points.map((p) => `${toX(p.east)},${toY(p.north)}`).join(" ");
          const col = PARCEL_COLORS[i % PARCEL_COLORS.length];
          const lcx = avg(pc.points.map((p) => toX(p.east)));
          const lcy = avg(pc.points.map((p) => toY(p.north)));
          return (
            <g key={`pc${i}`}>
              <polygon points={ring} fill={col} fillOpacity={0.12} stroke={col} strokeWidth={1.6} strokeLinejoin="round" />
              <text x={lcx} y={lcy} textAnchor="middle" fontSize={12} fontWeight="medium" fill={col}>{pc.number}</text>
            </g>
          );
        })
      ) : (
        <polygon points={polyPoints} fill="none" stroke="black" strokeWidth={1.6} strokeLinejoin="round" />
      )}
      {points.map((p, i) => {
        const bx = toX(p.east), by = toY(p.north);
        // Point the label along this vertex's own angle bisector (away from
        // its two neighbors), verified with the same inside/outside test as
        // the side-distance labels — more reliable than a flat centroid
        // direction on a concave corner (client req 2026-08-21), where it
        // could point toward the interior and collide with a nearby side
        // label instead of clearing the figure.
        const prev = points[(i - 1 + points.length) % points.length];
        const next = points[(i + 1) % points.length];
        const px = toX(prev.east), py = toY(prev.north);
        const qx = toX(next.east), qy = toY(next.north);
        const d1x = bx - px, d1y = by - py, l1 = Math.hypot(d1x, d1y) || 1;
        const d2x = bx - qx, d2y = by - qy, l2 = Math.hypot(d2x, d2y) || 1;
        let dx = d1x / l1 + d2x / l2, dy = d1y / l1 + d2y / l2;
        const dl = Math.hypot(dx, dy) || 1;
        dx /= dl; dy /= dl;
        const probe = 10;
        if (insidePoly(bx + dx * probe, by + dy * probe)) { dx = -dx; dy = -dy; }
        const lx = bx + dx * 40, ly = by + dy * 40;
        return (
          <g key={`bcn${i}`}>
            <circle cx={bx} cy={by} r={5} fill="white" stroke="black" strokeWidth={1.2} />
            <text x={lx} y={ly + 4} textAnchor="middle" fontSize={FS_BEACON_HEAD} fontWeight="medium">{p.name}</text>
          </g>
        );
      })}
      {/* Each side's distance, placed next to that side of the boundary
          (client req 2026-08-21, Part 19 reference template) — offset to
          whichever side of the line is actually outside the polygon
          (tested directly, not guessed from the centroid — a centroid
          direction is wrong for concave/irregular boundaries and was
          putting labels on top of the figure). Short sides use a smaller
          font and a proportionally smaller offset, so on a tight zigzag of
          short legs the label doesn't overshoot into the next side's own
          label or the neighboring vertex letter (both offset independently). */}
      {sides.map((s, i) => {
        const a = points[i], b = points[(i + 1) % points.length];
        if (!a || !b) return null;
        const ax = toX(a.east), ay = toY(a.north);
        const bx = toX(b.east), by = toY(b.north);
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
        let nx = -dy / len, ny = dx / len;
        const probe = 10; // small offset — enough to clear the line without crossing a nearby vertex
        if (insidePoly(mx + nx * probe, my + ny * probe)) { nx = -nx; ny = -ny; }
        const short = len < 96;
        const off = short ? 26 : 35;
        const fs = short ? FS_SIDE_SHORT : FS_SIDE_LONG;
        return (
          <text key={`sd${i}`} x={mx + nx * off} y={my + ny * off + 4} textAnchor="middle" fontSize={FS_BEACON_HEAD} fontWeight="medium">
            {s.distance.toFixed(2)}
          </text>
        );
      })}
      {/* Manually-drawn adjoining-parcel extension lines (client req
          2026-08-22, Part 24) — the surveyor draws these directly on the
          rendered diagram (there's no survey data to compute them from),
          so they're plain SVG-space lines + free-text labels, not derived
          from a boundary side. Never coloured, even when selected, so a
          print/export taken mid-edit still reads as plain black-and-white. */}
      {(manualAnnotations ?? []).map((a) => {
        const isSel = selectedAnnotationId === a.id;
        const midx = (a.x1 + a.x2) / 2, midy = (a.y1 + a.y2) / 2;
        return (
          <g key={a.id} onClick={(e) => { e.stopPropagation(); onAnnotationClick?.(a.id, e); }} style={onAnnotationClick ? { cursor: "pointer" } : undefined}>
            <line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} stroke="black" strokeWidth={isSel ? 2.2 : 1} strokeDasharray="6 4" />
            <text x={midx} y={midy - 8} fontSize={FS_BEACON_HEAD} fontWeight={isSel ? "bold" : undefined} textAnchor="middle">{a.label}</text>
          </g>
        );
      })}
      {pendingAnnotationPoint && (
        <circle cx={pendingAnnotationPoint.x} cy={pendingAnnotationPoint.y} r={5} fill="black" />
      )}
      {/* Extra points: shown as marks only (dot + label) — NOT part of the traverse
          (no boundary side, no coordinate-table row). */}
      {(extraPoints ?? []).map((p, i) => (
        <g key={`xp${i}`}>
          <circle cx={toX(p.east)} cy={toY(p.north)} r={5} fill="black" />
          <text x={toX(p.east) + 12} y={toY(p.north) + 4} fontSize={FS_BEACON_HEAD} textAnchor="middle">
            {p.name}
          </text>
        </g>
      ))}

      {/* ===================== LEGAL DESCRIPTION ===================== */}
      {(() => {
        const landCalledY = legalY0 + figureLines.length * LEGAL_LH;
        // "(A PORTION OF ...)" line removed (client req 2026-08-22) — SITUATE
        // AT now follows directly after the underlined lot name.
        const situateY = landCalledY + LEGAL_LH;
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
        return (
          <>
            <g textAnchor="middle">
              {figureLines.map((line, i) => (
                <text key={i} x={VB_W / 2} y={legalY0 + i * LEGAL_LH} fontSize={FS_LEGAL} fontWeight="medium">
                  {line}
                </text>
              ))}
              <text x={VB_W / 2} y={landCalledY} fontSize={FS_LANDCALLED} fontWeight="medium" textDecoration="underline">{landCalled}</text>
              <text x={VB_W / 2} y={situateY} fontSize={FS_BEACON_HEAD}>SITUATE AT {meta.location} IN THE {meta.tribalArea}</text>
            </g>

            {/* ===================== certification/deductions (left) + surveyor (right) ===================== */}
            <text x={tx + 4} y={certY1} fontSize={FS_BEACON_HEAD}>{certificationLine(meta)}</text>
            <text x={tx + 4} y={deductionsY} fontSize={FS_BEACON_HEAD}>DEDUCTIONS ON THIS DIAGRAM ARE MADE ON THE BACK HEREOF</text>
            {/* Plain/simple styling (client req 2026-08-22) — no bold, no
                forced caps, no signature line above; prints exactly
                whatever the surveyor field and the fixed "Land Surveyor"
                title read. */}
            <text x={VB_W - 700} y={certY1} fontSize={FS_BEACON_HEAD}>{meta.surveyor}</text>
            <text x={VB_W - 700} y={deductionsY} fontSize={FS_BEACON_HEAD}>Land Surveyor</text>
          </>
        );
      })()}

      {/* ===================== deeds/annexure table ===================== */}
      <g fontSize={FS_BEACON_HEAD}>
        <rect x={tx} y={annTop} width={tw} height={annBottom - annTop} fill="none" stroke="black" strokeWidth={1.2} />
        <line x1={annC1} y1={annTop} x2={annC1} y2={annBottom} stroke="black" strokeWidth={1} />
        <line x1={annC2} y1={annTop} x2={annC2} y2={annBottom} stroke="black" strokeWidth={1} />

        {/* left — Deeds Registry annexure */}
        <text x={tx + 10} y={annTop + 40}>This diagram is annexed to</text>
        <text x={tx + 10} y={annTop + 90}>No. {dash(meta.annexedToNo)}</text>
        <text x={tx + 10} y={annTop + 140}>Dated {dash(meta.annexedDate)}</text>
        <text x={annC1 - 140} y={annTop + 140}>in favour</text>
        <text x={tx + 10} y={annTop + 190}>of {dash(meta.annexedInFavourOf)}</text>
        {meta.annexName && meta.annexName.trim() && (
          <text x={(tx + annC1) / 2} y={annBottom - 46} textAnchor="middle" fontSize={FS_BEACON_HEAD}>
            {meta.annexName}
          </text>
        )}
        <text x={(tx + annC1) / 2} y={annBottom - 14} textAnchor="middle" fontSize={FS_BEACON_HEAD}>
          Registrar of Deeds
        </text>

        {/* middle — immediate parent diagram */}
        <text x={annC1 + 10} y={annTop + 40}>The immediate parent diagram is</text>
        <text x={annC2 - 14} y={annTop + 90} textAnchor="end">Annexed</text>
        <text x={annC1 + 10} y={annTop + 140}>to</text>
        <text x={annC1 + 50} y={annTop + 140}>No. {dash(meta.parentDiagramNo || meta.parentDiagram)}</text>

        {/* right — registration numbers (label + value in an aligned column, with a gap) */}
        <text x={annC2 + 12} y={annTop + 40}>General Plan No.</text>
        <text x={annC2 + 200} y={annTop + 40}>{dash(meta.gpNo)}</text>
        <text x={annC2 + 12} y={annTop + 90}>S.R No.</text>
        <text x={annC2 + 200} y={annTop + 90}>{dash(meta.srNo)}</text>
        <text x={annC2 + 12} y={annTop + 140}>D.S.M File:</text>
        <text x={annC2 + 200} y={annTop + 140}>{dash(meta.dsmFile)}</text>
        <text x={annC2 + 12} y={annTop + 190}>Comp.</text>
        <text x={annC2 + 200} y={annTop + 190}>{dash(meta.comp)}</text>
        <text x={annC2 + 12} y={annTop + 240}>Degree Square:</text>
        <text x={annC2 + 200} y={annTop + 240}>{dash(meta.degreeSquare)}</text>
        <text x={annC2 + 12} y={annTop + 290}>LIR No:</text>
        <text x={annC2 + 200} y={annTop + 290}>{dash(meta.lirNo)}</text>
      </g>
    </svg>
  );
});
