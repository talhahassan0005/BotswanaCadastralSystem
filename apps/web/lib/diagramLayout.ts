/**
 * Single source of truth for the Botswana SG cadastral diagram's layout —
 * every measurement, font size, column boundary, word-wrapped text block and
 * table value that `SgDiagram.tsx` (SVG/print) and `Diagrams.tsx`'s DXF
 * export both need (client req 2026-08-26, Part 34: the DXF export was a
 * "bare, simplified rendering" maintained as a second, drifting
 * implementation of the same template — this module is the fix, computed
 * once and consumed by both output paths so they can never diverge again).
 *
 * `computeDiagramLayout()` is a pure function of (meta, points, sides,
 * extraPoints) — no DOM, no SVG, no rendering — moved verbatim out of
 * SgDiagram.tsx's component body (Part 23/25/26/27's exact mm-measured
 * figures are untouched) so the SVG component now just destructures this
 * return value instead of computing it inline, and the DXF export
 * translates the same values into DXF entities instead of re-deriving them
 * from a separate, simpler formula set.
 */
import { wrapSvgWords, clampWords, clampToLines } from "./wrapSvgText";

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
  parent2?: string;       // optional 2nd "(A PORTION OF ...)" line — long-history plots with several ancestor parcels
  parent3?: string;       // optional 3rd "(A PORTION OF ...)" line
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

/** Certification line wording — differs per diagram type per SG convention.
 *  Compiled/Framed cite the same D.S.M No./S.R No./General Plan No. already
 *  entered in the Registration card (client req 2026-08-26, reference
 *  example: "Compiled from Sr. 435/2017, Dsm. 657/2017 in May 2025 by me")
 *  instead of a separate free-text field that duplicated the same numbers. */
export function certificationLine(meta: DiagramMeta): string {
  switch (meta.kind) {
    case "compiled": {
      const refs = [meta.srNo ? `Sr. ${meta.srNo}` : "", meta.dsmNo ? `Dsm. ${meta.dsmNo}` : ""].filter(Boolean).join(", ");
      return `Compiled${refs ? ` from ${refs}` : ""} in ${meta.surveyedDate} by me,`;
    }
    case "framed":
      return `Framed${meta.gpNo ? ` from G.P. ${meta.gpNo}` : ""} in ${meta.surveyedDate} by me,`;
    default:
      return `Surveyed in ${meta.surveyedDate} by me,`;
  }
}

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
export function tCoord(n: number): string {
  return `${n < 0 ? "-" : "+"}${Math.abs(n).toFixed(2)}`;
}
export function tDist(n: number): string {
  return n.toFixed(2);
}
/** Side row-label: "AB" for single-letter beacons (the official SG
 *  convention), but bare concatenation of longer point names is
 *  unreadable ("25A225A1" — is that 25A2→25A1, or something else?), so
 *  those get a separator instead (client req 2026-08-22). */
export function sideLabel(from: string | null, to: string | null): string {
  const f = from ?? "", t = to ?? "";
  return f.length <= 1 && t.length <= 1 ? `${f}${t}` : `${f}-${t}`;
}
/** Sequential boundary letter — A, B, ... Z, AA, AB, ... (client req
 *  2026-08-23: the diagram must letter the boundary A, B, C, ... on the
 *  official sheet regardless of what the underlying survey data calls
 *  those points, e.g. "25A2"/"M1" — same as every SG reference sample). */
export function boundaryLetter(i: number): string {
  let n = i, s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}
/** Area line: small plots in SQUARE METRES, larger in HECTARES (SG convention). */
export function areaText(areaHa: number): string {
  return areaHa < 1
    ? `${Math.round(areaHa * 10000).toLocaleString("en-US")} SQUARE METRES`
    : `${areaHa.toFixed(4)} HECTARES`;
}
/** Coordinate-system label in SG form: "Lo 29" -> "LO. 29°". */
export function fmtSystem(cs: string): string {
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

export const avg = (ns: number[]) => ns.reduce((a, b) => a + b, 0) / (ns.length || 1);

// ---------------------------------------------------------------------------
// computeDiagramLayout — every measurement, wrapped-text block and table
// value the diagram needs, moved verbatim (same formulas, same variable
// names) out of SgDiagram.tsx's component body. Pure function: same inputs
// always produce the same layout, so both the SVG component and the DXF
// export see exactly the same numbers.
// ---------------------------------------------------------------------------
export function computeDiagramLayout(
  meta: DiagramMeta,
  rawPoints: DiagramPoint[],
  rawSides: DiagramSide[],
  extraPoints: DiagramPoint[] = []
) {
  // The diagram always letters the boundary A, B, C, ... on the printed
  // sheet, ignoring whatever the survey data actually calls each point
  // (client req 2026-08-23) — geometry (east/north) is untouched, only the
  // display name changes, and only for the certified boundary; extraPoints
  // (witness/reference marks, not part of "the figure") keep their real
  // names. Every side is assumed to join points[i] -> points[i+1], the
  // same adjacency already relied on elsewhere in this file (vertex
  // labels, side-distance labels), so sides relabel the same way.
  // Some upstream sources represent a closed ring by repeating the first
  // point at the end (e.g. a 4-corner boundary A,B,C,D arriving as
  // [A,B,C,D,A'] with a matching degenerate zero-length closing side) —
  // relabeling that duplicate as a brand-new "E" is wrong regardless of
  // which source did it (client req 2026-08-23: "where do we get E, we
  // only had A to D"). Detect and drop it before lettering.
  const DUP_TOL = 0.01; // metres — points within 1cm count as "the same point"
  const isSamePoint = (a: { east: number; north: number }, b: { east: number; north: number }) =>
    Math.abs(a.east - b.east) < DUP_TOL && Math.abs(a.north - b.north) < DUP_TOL;
  const hasDupClosingPoint =
    rawPoints.length > 1 && isSamePoint(rawPoints[0], rawPoints[rawPoints.length - 1]);
  const boundaryPoints = hasDupClosingPoint ? rawPoints.slice(0, -1) : rawPoints;
  const boundarySides = hasDupClosingPoint ? rawSides.slice(0, -1) : rawSides;
  const points = boundaryPoints.map((p, i) => ({ ...p, name: boundaryLetter(i) }));
  const sides = boundarySides.map((s, i) => ({ ...s, from: boundaryLetter(i), to: boundaryLetter((i + 1) % boundaryPoints.length) }));
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
  const FS_LEGAL = 37, FS_LANDCALLED = 37, FS_PARENT = 31, FS_CERT = 31;
  // Name and title kept equal on purpose (client req 2026-08-22: "same
  // font size as how the lower one is") — a later across-the-board font
  // bump accidentally drifted them apart by 1pt; restored here.
  const FS_SURVEYOR = 26, FS_SURVEYOR_TITLE = 26, FS_FOOTER = 21, FS_ANNEX = 24;

  // ---- top data table: fixed 51.0mm band, 14.0mm header for a normal-
  // sized plot (client req, Part 23) — the data area's row height used to
  // shrink to force every row into that fixed 37.0mm band regardless of
  // point count, but that meant the row font kept shrinking right along
  // with it on a beacon-heavy plot (client req 2026-08-26: "font chota ku
  // hogaya hai points zyada honay ki waja se, ye chota nahi hona chahiye"
  // — the font must NOT shrink). The font is fixed now; once there are
  // more rows than the 37.0mm band comfortably fits at that fixed size,
  // the band itself grows instead (pushing the rest of the page's
  // dynamically-sized content down, the same way a long legal-description
  // or beacon-description block already does) — a small, beacon-light plot
  // (the overwhelmingly common case, and the one Part 23's exact mm figures
  // were measured against) renders at exactly the original dimensions. ----
  const tx = FRAME_X;
  const tw = FRAME_W;
  const ty = FRAME_Y;
  const headH = 14.0 * MM;
  const dataTop = ty + headH;
  const n = Math.max(points.length, sides.length, 1);
  const dataFS = FS_TABLE_SUB;
  const ROW_H_MIN = FS_TABLE_SUB / 0.55; // the row height a fixed-size row actually needs
  const rowH = Math.max((51.0 * MM - headH) / n, ROW_H_MIN);
  const dataH = rowH * n;
  const topBandH = headH + dataH;
  const tableBottom = ty + topBandH;

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
  // "LAND CALLED" line carries the village/location too, e.g. "LOT 323
  // CHARLESHILL" — wrapped like every other free-text block here (client
  // req 2026-08-24: an unusually long lot name/location used to just run
  // off the sheet as one un-wrapped line instead of dropping to a second).
  const landCalled =
    meta.location && !meta.lotName.toUpperCase().includes(meta.location.trim().toUpperCase())
      ? `${meta.lotName} ${meta.location}`
      : meta.lotName;
  const landCalledLines = wrapSvgWords(landCalled.split(/\s+/).filter(Boolean), tw - 80, FS_LANDCALLED);
  // Optional "(A PORTION OF ...)" ancestry lines — client req 2026-08-23:
  // long-history plots (subdivided from a lot, itself a portion of another
  // lot, itself a portion of a cadastre) need up to 3 stacked lines here,
  // not just the one `parent` field. Blank ones are skipped entirely so a
  // plot with a simple history renders exactly as before. Each one is
  // itself word-wrapped (client req 2026-08-24) rather than assumed to fit
  // on one line — the wrapping parens are stitched onto the first/last
  // wrapped word so a long ancestry line still reads as "(... ... ...)".
  const parentLineGroups: string[][] = [meta.parent, meta.parent2, meta.parent3]
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .map((p) => {
      const wrapped = wrapSvgWords(p.split(/\s+/).filter(Boolean), tw - 100, FS_LEGAL);
      if (wrapped.length === 0) return wrapped;
      const withParens = [...wrapped];
      withParens[0] = `(${withParens[0]}`;
      withParens[withParens.length - 1] = `${withParens[withParens.length - 1]})`;
      return withParens;
    });
  const situateLines = wrapSvgWords(
    ["SITUATE", "AT", ...meta.location.split(/\s+/).filter(Boolean), "IN", "THE", ...meta.tribalArea.split(/\s+/).filter(Boolean)],
    tw - 80,
    FS_BEACON_HEAD
  );
  // Reserve room at the bottom of the middle zone for the legal-description
  // block (however many lines each free-text piece wraps to) + the
  // certificate/surveyor lines, so the figure box above it never overlaps
  // this text no matter how long any of the underlying fields get.
  const legalBlockH =
    (figureLines.length +
      landCalledLines.length +
      parentLineGroups.reduce((a, g) => a + g.length, 0) +
      situateLines.length +
      2 + // certification + deductions lines
      3) * // spare margin, matching the original fixed-block breathing room
      LEGAL_LH +
    60;
  const legalY0 = annTop - legalBlockH;

  // Beacon Description (dynamic line count) + locality name sit right
  // below the top table; the figure gets whatever's left above the legal
  // block reserve.
  // Each semicolon-separated entry gets its own word-wrap pass (client req
  // 2026-08-24 — an unusually long single entry, with no semicolon to break
  // on, used to just run off the right edge of the sheet instead of
  // dropping to a second line like every other free-text block here).
  const beaconLines = meta.beaconDescription
    .split(/\s*[;\n]\s*/)
    .filter(Boolean)
    .flatMap((entry) => wrapSvgWords(entry.split(/\s+/).filter(Boolean), tw - 8, FS_BEACON_HEAD));
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

  // ===================== Right-side D.S.M / Approved / Director of Surveys
  // column geometry (client req 2026-08-22/2026-08-26) — moved here so the
  // DXF export draws the exact same open-bottom box the SVG does. ====
  const dsmBoxTop = ty + headH;
  const dsmApprovedY = dsmBoxTop + 25;
  const dosY1 = dsmApprovedY + FS_DOS * 2.2;
  const dosY2 = dosY1 + FS_DOS * 1.3;
  const dosLineY = dosY2 + FS_DOS * 1.1;

  // ===================== North arrow anchor (client req 2026-08-22) =====
  const arrowX = Math.max(tx + 90, Math.min(fig.x - 90, offX - 90));
  const arrowY = fig.y + 200;

  // ===================== Legal description + certificate/surveyor
  // (client req 2026-08-22) — exact same line positions as the SVG. =====
  const landCalledY0 = legalY0 + figureLines.length * LEGAL_LH;
  const parentY0 = landCalledY0 + landCalledLines.length * LEGAL_LH;
  const parentTotalLines = parentLineGroups.reduce((a, g) => a + g.length, 0);
  const situateY0 = parentY0 + parentTotalLines * LEGAL_LH;
  const deductionsY = annTop - 20;
  const certY1 = deductionsY - FS_CERT * 1.15;
  const leftColW = VB_W - 700 - (tx + 4) - 20;
  const rightColW = tableRight - (VB_W - 700) - 20;
  const cert = clampWords(certificationLine(meta), leftColW, FS_BEACON_HEAD, 12);
  const surveyorFit = clampWords(meta.surveyor, rightColW, FS_BEACON_HEAD);

  // ===================== deeds/annexure (bottom registration) table
  // (client req 2026-08-22/2026-08-24) — same shrink-to-fit/wrap rules. ===
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
  const annexNameLines = meta.annexName && meta.annexName.trim()
    ? clampToLines(meta.annexName, annC1 - tx - 40, FS_BEACON_HEAD, 2)
    : [];
  const ANNEX_NAME_LH = FS_BEACON_HEAD * 1.15;
  const parentDiagramNo = clampWords(`No. ${dash(meta.parentDiagramNo || meta.parentDiagram)}`, annC2 - (annC1 + 50) - 10, FS_BEACON_HEAD);

  return {
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
    sc, dw, dh, offX, offY, toX, toY, cx, cy, polyPoints, screenPts, insidePoly,
    dsmBoxTop, dsmApprovedY, dosY1, dosY2, dosLineY,
    arrowX, arrowY,
    landCalledY0, parentY0, parentTotalLines, situateY0, deductionsY, certY1, leftColW, rightColW, cert, surveyorFit,
    valueX, gpNoX, srNoX, dsmFileX, compX, degreeSquareX, lirNoX,
    gpNo, srNo, dsmFile, comp, degreeSquare, lirNo,
    annexedTo, annexedDate, annexedFavour, annexNameLines, ANNEX_NAME_LH, parentDiagramNo,
  };
}

export type DiagramLayout = ReturnType<typeof computeDiagramLayout>;
