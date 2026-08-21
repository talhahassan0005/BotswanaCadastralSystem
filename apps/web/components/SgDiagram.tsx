"use client";

import { forwardRef } from "react";
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
  /** Optional adjoining-parcel identifier per boundary side, e.g. "REMAINDER
   *  OF CADASTRE 477" (client req 2026-08-21, Part 20a) — same index as
   *  `sides`/the point pair (points[i] -> points[i+1]). A blank/missing
   *  entry means that side gets no extension line, matching the reference. */
  neighborLabels?: string[];
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
  { meta, points, sides, parcels, extraPoints, neighborLabels },
  ref
) {
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
  const FS_TABLE_HEAD = 26, FS_TABLE_SUB = 22, FS_CONSTANTS = 19;
  const FS_BEACON_HEAD = 28, FS_BEACON = 25, FS_LOCALITY = 32;
  const FS_DOS = 23, FS_ARROW = 22, FS_SCALE = 22;
  const FS_VERTEX = 30, FS_SIDE_LONG = 24, FS_SIDE_SHORT = 19, FS_NEIGHBOR = 19;
  const FS_LEGAL = 27, FS_LANDCALLED = 31, FS_PARENT = 25, FS_CERT = 25;
  const FS_SURVEYOR = 27, FS_SURVEYOR_TITLE = 21, FS_FOOTER = 17, FS_ANNEX = 20;

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
  const dataFS = Math.max(13, Math.min(FS_TABLE_SUB, rowH * 0.55));

  // column x boundaries — cumulative from the frame's own left edge,
  // widths per Part 23 (7.9 / 25.6 / 27.9 / 6.6 / 25.5 / 27.0 / 39.9mm).
  const xMetR = tx + 7.9 * MM + 25.6 * MM; // right of SIDES/METRES group
  const xDir = xMetR;                       // DIRECTIONS column
  const xDirR = xDir + 27.9 * MM;           // right of DIRECTIONS
  const xPt = xDirR;                        // point-letter column
  const xPtR = xPt + 6.6 * MM;
  const xY = xPtR;                          // Y coordinate column
  const xYR = xY + 25.5 * MM;
  const xX = xYR;                           // X coordinate column
  const xXR = xX + 27.0 * MM;
  const xDsm = xXR;                         // D.S.M No. box
  const tableRight = tx + tw;               // = FRAME_RIGHT
  // header sub-row baselines and the partial-height Y/X dividers (no exact
  // figures given for these internal header rows — proportioned the same
  // way the old 3-row header split its 66-unit band, scaled to the new
  // fixed 14.0mm headH).
  const hRow1 = ty + headH * 0.26, hRow2 = ty + headH * 0.56, hRow3 = ty + headH * 0.9;
  const xYDividerTop = ty + headH * 0.667;
  const xXDividerTop = ty + headH * 0.333;

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
  const fig = { x: tx + 60, y: figTop, w: tw - 60 - 300, h: figBottom - figTop };
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
      style={{ width: "100%", height: "auto", background: "white", color: "#000", fontFamily: "Arial, Helvetica, sans-serif" }}
    >
      {/* outer border — 160.4 x 272.9mm, positioned per Part 23's exact
          margins (24.8mm left/right, 12.2mm top, ~11.9mm bottom) */}
      <rect x={FRAME_X} y={FRAME_Y} width={FRAME_W} height={FRAME_H} fill="white" stroke="black" strokeWidth={2} />

      {/* ===================== TOP DATA TABLE ===================== */}
      <g>
        <rect x={tx} y={ty} width={tw} height={tableBottom - ty} fill="none" stroke="black" strokeWidth={1} />
        {/* vertical dividers */}
        <line x1={xMetR} y1={ty} x2={xMetR} y2={tableBottom} stroke="black" strokeWidth={0.7} />
        <line x1={xDirR} y1={ty} x2={xDirR} y2={tableBottom} stroke="black" strokeWidth={0.7} />
        <line x1={xY} y1={xYDividerTop} x2={xY} y2={tableBottom} stroke="black" strokeWidth={0.5} />
        <line x1={xX} y1={xXDividerTop} x2={xX} y2={tableBottom} stroke="black" strokeWidth={0.5} />
        <line x1={xDsm} y1={ty} x2={xDsm} y2={tableBottom} stroke="black" strokeWidth={0.7} />
        {/* header underline */}
        <line x1={tx} y1={ty + headH} x2={xDsm} y2={ty + headH} stroke="black" strokeWidth={0.7} />
        <line x1={xDsm} y1={xYDividerTop} x2={tableRight} y2={xYDividerTop} stroke="black" strokeWidth={0.5} />

        {/* header row 1 */}
        <text x={(tx + xMetR) / 2} y={hRow1} textAnchor="middle" fontWeight="bold" fontSize={FS_TABLE_HEAD}>SIDES</text>
        <text x={(xDir + xDirR) / 2} y={hRow1} textAnchor="middle" fontWeight="bold" fontSize={FS_TABLE_HEAD}>DIRECTIONS</text>
        <text x={(xPt + xXR) / 2} y={hRow1} textAnchor="middle" fontWeight="bold" fontSize={FS_TABLE_HEAD}>CO-ORDINATES</text>
        <text x={(xDsm + tableRight) / 2} y={hRow1} textAnchor="middle" fontWeight="bold" fontSize={FS_TABLE_HEAD}>D.S.M No.</text>
        {/* header row 2 */}
        <text x={(tx + xMetR) / 2} y={hRow2} textAnchor="middle" fontWeight="bold" fontSize={FS_TABLE_SUB}>METRES</text>
        <text x={xPt + (xY - xPt) / 2} y={hRow2} textAnchor="middle" fontSize={FS_TABLE_SUB} fontWeight="bold">Y</text>
        <text x={(xY + xXR) / 2} y={hRow2} textAnchor="middle" fontSize={FS_TABLE_SUB}>System {fmtSystem(meta.coordinateSystem)}</text>
        <text x={xX + (xXR - xX) / 2} y={hRow2} textAnchor="middle" fontSize={FS_TABLE_SUB} fontWeight="bold">X</text>
        <text x={(xDsm + tableRight) / 2} y={hRow2} textAnchor="middle" fontSize={FS_TABLE_HEAD}>{meta.dsmNo || ""}</text>
        {/* header row 3 — constants */}
        <text x={(xDir + xDirR) / 2} y={hRow3} textAnchor="middle" fontWeight="bold" fontSize={FS_CONSTANTS}>CONSTANTS</text>
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
                  <text x={tx + 10} y={y}>{`${s.from ?? ""}${s.to ?? ""}`}</text>
                  <text x={xMetR - 8} y={y} textAnchor="end">{tDist(s.distance)}</text>
                  <text x={xDir + 12} y={y}>{toDotted(s.bearing_dms)}</text>
                </>
              )}
              {p && (
                <>
                  <text x={xPt + 8} y={y} fontWeight="bold">{p.name}</text>
                  <text x={xY + 8} y={y}>{tCoord(p.east)}</text>
                  <text x={xX + 8} y={y}>{tCoord(p.north)}</text>
                </>
              )}
            </g>
          );
        })}
      </g>

      {/* ===================== BEACON DESCRIPTION + village ===================== */}
      <text x={tx + 4} y={bdHeadingY} fontSize={FS_BEACON_HEAD} fontWeight="bold" textDecoration="underline">
        BEACON DESCRIPTION
      </text>
      {beaconLines.map((ln, i) => (
        <text key={`bd${i}`} x={tx + 4} y={bdLinesY0 + i * BD_LH} fontSize={FS_BEACON}>{ln}</text>
      ))}
      <text x={tx + tw / 2} y={localityY} textAnchor="middle" fontSize={FS_LOCALITY} letterSpacing="1">{meta.location}</text>

      {/* ===================== Director of Surveys block (right, under D.S.M) ===================== */}
      <text x={xDsm + 16} y={bdHeadingY} fontSize={FS_DOS}>Director of Surveys</text>
      <text x={xDsm + 16} y={bdHeadingY + FS_DOS * 1.4} fontSize={FS_DOS}>and Mapping</text>
      <line x1={xDsm + 16} y1={bdHeadingY + FS_DOS * 2.7} x2={tableRight - 16} y2={bdHeadingY + FS_DOS * 2.7} stroke="black" strokeWidth={0.6} />

      {/* ===================== North arrow + scale (right of the figure) ===================== */}
      {/* Positioned clear of the actual drawn figure (client req 2026-08-21)
          — since Part 14 draws the boundary at the chosen scale instead of
          always auto-fitting the fig box, a large/tall shape can extend
          further right than the figure box's own default position
          anticipated. Push the arrow right of the figure's actual right
          edge (capped so it stays inside the frame), instead of always
          sitting at a fixed position. */}
      <g transform={`translate(${Math.min(tableRight - 90, Math.max(fig.x + fig.w + 90, offX + dw + 90))}, ${fig.y + 40})`}>
        <line x1={0} y1={46} x2={0} y2={-34} stroke="black" strokeWidth={1.3} />
        <polygon points="0,-46 -8,-22 0,-32 8,-22" fill="black" />
        <line x1={-14} y1={2} x2={14} y2={2} stroke="black" strokeWidth={0.8} />
        <text x={9} y={-2} fontSize={FS_ARROW} fontWeight="bold">N</text>
        <text x={-18} y={-2} fontSize={FS_ARROW}>T</text>
        {meta.scale > 0 && (
          <text x={0} y={78} textAnchor="middle" fontSize={FS_SCALE} fontWeight="bold">SCALE 1:{meta.scale.toLocaleString()}</text>
        )}
      </g>

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
              <text x={lcx} y={lcy} textAnchor="middle" fontSize={12} fontWeight="bold" fill={col}>{pc.number}</text>
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
            <text x={lx} y={ly + 4} textAnchor="middle" fontSize={FS_VERTEX} fontWeight="bold">{p.name}</text>
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
          <text key={`sd${i}`} x={mx + nx * off} y={my + ny * off + 4} textAnchor="middle" fontSize={fs}>
            {s.distance.toFixed(2)}
          </text>
        );
      })}
      {/* Adjoining-parcel extension lines (client req 2026-08-21, Part 20a) —
          a dashed line continuing past this side's end point, labeled with
          the neighboring parcel's identifier. Only drawn where the user
          actually entered a label; sides with none get no extension at all. */}
      {sides.map((s, i) => {
        const label = neighborLabels?.[i];
        if (!label || !label.trim()) return null;
        const a = points[i], b = points[(i + 1) % points.length];
        if (!a || !b) return null;
        const ax = toX(a.east), ay = toY(a.north);
        const bx = toX(b.east), by = toY(b.north);
        const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        const extLen = 144;
        const ex = bx + ux * extLen, ey = by + uy * extLen;
        const midx = (bx + ex) / 2, midy = (by + ey) / 2;
        const nx = -uy, ny = ux;
        return (
          <g key={`nb${i}`}>
            <line x1={bx} y1={by} x2={ex} y2={ey} stroke="black" strokeWidth={1} strokeDasharray="6 4" />
            <text x={midx + nx * 22} y={midy + ny * 22} fontSize={FS_NEIGHBOR} textAnchor="middle">{label}</text>
          </g>
        );
      })}
      {/* Extra points: shown as marks only (dot + label) — NOT part of the traverse
          (no boundary side, no coordinate-table row). */}
      {(extraPoints ?? []).map((p, i) => (
        <g key={`xp${i}`}>
          <circle cx={toX(p.east)} cy={toY(p.north)} r={5} fill="black" />
          <text x={toX(p.east) + 12} y={toY(p.north) + 4} fontSize={FS_NEIGHBOR}>{p.name}</text>
        </g>
      ))}

      {/* ===================== LEGAL DESCRIPTION ===================== */}
      {(() => {
        const landCalledY = legalY0 + figureLines.length * LEGAL_LH;
        const parentY = landCalledY + LEGAL_LH;
        const situateY = parentY + LEGAL_LH;
        const certY1 = situateY + LEGAL_LH * 1.3;
        const certY2 = certY1 + LEGAL_LH;
        const surveyorTitleY = certY2 + LEGAL_LH * 0.65;
        return (
          <>
            <g textAnchor="middle">
              {figureLines.map((line, i) => (
                <text key={i} x={VB_W / 2} y={legalY0 + i * LEGAL_LH} fontSize={FS_LEGAL} fontWeight="bold">
                  {line}
                </text>
              ))}
              <text x={VB_W / 2} y={landCalledY} fontSize={FS_LANDCALLED} fontWeight="bold" textDecoration="underline">{landCalled}</text>
              <text x={VB_W / 2} y={parentY} fontSize={FS_PARENT}>({meta.parent})</text>
              <text x={VB_W / 2} y={situateY} fontSize={FS_PARENT}>SITUATE AT {meta.location} IN THE {meta.tribalArea}</text>
            </g>

            {/* ===================== certification + surveyor ===================== */}
            <text x={tx + 20} y={certY1} fontSize={FS_CERT}>
              {meta.kind === "compiled"
                ? `Compiled from ${dash(meta.sourceRef) || "—"}`
                : meta.kind === "framed"
                ? `Framed from ${dash(meta.sourceRef) || "—"}`
                : "Surveyed"}
            </text>
            <text x={tx + 40} y={certY2} fontSize={FS_CERT}>IN {meta.surveyedDate} BY ME,</text>
            <text x={VB_W - 480} y={certY2} fontSize={FS_SURVEYOR} fontWeight="bold">{meta.surveyor}</text>
            <text x={VB_W - 480} y={surveyorTitleY} fontSize={FS_SURVEYOR_TITLE}>LAND SURVEYOR</text>
          </>
        );
      })()}

      {/* ===================== DEDUCTIONS + deeds/annexure table ===================== */}
      <text x={tx + 4} y={annTop - 10} fontSize={FS_FOOTER}>DEDUCTIONS FROM THIS DIAGRAM ARE MADE ON THE BACK HEREOF</text>
      <g fontSize={FS_ANNEX}>
        <rect x={tx} y={annTop} width={tw} height={annBottom - annTop} fill="none" stroke="black" strokeWidth={0.8} />
        <line x1={annC1} y1={annTop} x2={annC1} y2={annBottom} stroke="black" strokeWidth={0.6} />
        <line x1={annC2} y1={annTop} x2={annC2} y2={annBottom} stroke="black" strokeWidth={0.6} />

        {/* left — Deeds Registry annexure */}
        <text x={tx + 10} y={annTop + 40}>This diagram is annexed to</text>
        <text x={tx + 10} y={annTop + 90}>No. {dash(meta.annexedToNo)}</text>
        <text x={tx + 10} y={annTop + 140}>Dated {dash(meta.annexedDate)}</text>
        <text x={annC1 - 100} y={annTop + 140}>in favour</text>
        <text x={tx + 10} y={annTop + 190}>of {dash(meta.annexedInFavourOf)}</text>
        {meta.annexName && meta.annexName.trim() && (
          <text x={(tx + annC1) / 2} y={annBottom - 46} textAnchor="middle" fontSize={FS_ANNEX}>{meta.annexName}</text>
        )}
        <line x1={tx + 40} y1={annBottom - 34} x2={annC1 - 30} y2={annBottom - 34} stroke="black" strokeWidth={0.4} />
        <text x={(tx + annC1) / 2} y={annBottom - 14} textAnchor="middle">Registrar of Deeds</text>

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
