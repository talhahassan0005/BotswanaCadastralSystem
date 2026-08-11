"use client";

import { forwardRef } from "react";

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
  { meta, points, sides, parcels, extraPoints },
  ref
) {
  const VB_W = 1000;
  const VB_H = 1687; // 16 : 27 cm SG sheet — border prints 160×270mm on A4

  // ---- top data table geometry ----
  const tx = 24;
  const tw = 952;
  const ty = 28;
  const rowH = 19;
  const headH = 66; // three header rows
  const n = Math.max(points.length, sides.length, 1);
  const tableBottom = ty + headH + n * rowH;

  // column x boundaries
  const xMetR = 196; // right of SIDES/METRES group
  const xDir = 196;  // DIRECTIONS column
  const xDirR = 330; // right of DIRECTIONS
  const xPt = 330;   // point-letter column
  const xY = 372;    // Y coordinate column
  const xYR = 560;
  const xX = 560;    // X coordinate column
  const xXR = 720;
  const xDsm = 720;  // D.S.M No. box
  const tableRight = tx + tw;

  // ---- figure transform (centre area) ----
  const fig = { x: 110, y: 440, w: 780, h: 700 };
  const pad = 90;
  const es = points.map((p) => p.east);
  const nsv = points.map((p) => p.north);
  // Figure bounds include any extra (non-traverse) marks so they stay visible.
  const bE = [...es, ...(extraPoints ?? []).map((p) => p.east)];
  const bN = [...nsv, ...(extraPoints ?? []).map((p) => p.north)];
  const minE = Math.min(...bE), maxE = Math.max(...bE);
  const minN = Math.min(...bN), maxN = Math.max(...bN);
  const spanE = Math.max(maxE - minE, 1e-6);
  const spanN = Math.max(maxN - minN, 1e-6);
  const sc = Math.min((fig.w - 2 * pad) / spanE, (fig.h - 2 * pad) / spanN);
  const dw = spanE * sc, dh = spanN * sc;
  const offX = fig.x + (fig.w - dw) / 2;
  const offY = fig.y + (fig.h - dh) / 2;
  const toX = (e: number) => offX + (e - minE) * sc;
  const toY = (north: number) => offY + (maxN - north) * sc;
  const cx = toX(avg(es)), cy = toY(avg(nsv));
  const polyPoints = points.map((p) => `${toX(p.east)},${toY(p.north)}`).join(" ");
  const figureLetters =
    points.map((p) => p.name ?? "?").join(" ") + (meta.closed ? ` ${points[0]?.name ?? ""}` : "");
  // "LAND CALLED" line carries the village/location too, e.g. "LOT 323 CHARLESHILL".
  const landCalled =
    meta.location && !meta.lotName.toUpperCase().includes(meta.location.trim().toUpperCase())
      ? `${meta.lotName} ${meta.location}`
      : meta.lotName;

  // ---- bottom deeds/annexure table ----
  const annTop = 1490;
  const annBottom = VB_H - 16;
  const annC1 = 392; // divider after left column
  const annC2 = 600; // divider after middle column
  const dash = (v?: string) => (v && v.trim() ? v : "");

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      xmlns="http://www.w3.org/2000/svg"
      fill="#000"
      style={{ width: "100%", height: "auto", background: "white", color: "#000", fontFamily: "Arial, Helvetica, sans-serif" }}
    >
      {/* outer border */}
      <rect x={10} y={10} width={VB_W - 20} height={VB_H - 20} fill="white" stroke="black" strokeWidth={2} />

      {/* ===================== TOP DATA TABLE ===================== */}
      <g>
        <rect x={tx} y={ty} width={tw} height={tableBottom - ty} fill="none" stroke="black" strokeWidth={1} />
        {/* vertical dividers */}
        <line x1={xMetR} y1={ty} x2={xMetR} y2={tableBottom} stroke="black" strokeWidth={0.7} />
        <line x1={xDirR} y1={ty} x2={xDirR} y2={tableBottom} stroke="black" strokeWidth={0.7} />
        <line x1={xY} y1={ty + 44} x2={xY} y2={tableBottom} stroke="black" strokeWidth={0.5} />
        <line x1={xX} y1={ty + 22} x2={xX} y2={tableBottom} stroke="black" strokeWidth={0.5} />
        <line x1={xDsm} y1={ty} x2={xDsm} y2={tableBottom} stroke="black" strokeWidth={0.7} />
        {/* header underline */}
        <line x1={tx} y1={ty + headH} x2={xDsm} y2={ty + headH} stroke="black" strokeWidth={0.7} />
        <line x1={xDsm} y1={ty + 44} x2={tableRight} y2={ty + 44} stroke="black" strokeWidth={0.5} />

        {/* header row 1 */}
        <text x={(tx + xMetR) / 2} y={ty + 16} textAnchor="middle" fontWeight="bold" fontSize={13}>SIDES</text>
        <text x={(xDir + xDirR) / 2} y={ty + 16} textAnchor="middle" fontWeight="bold" fontSize={13}>DIRECTIONS</text>
        <text x={(xPt + xXR) / 2} y={ty + 16} textAnchor="middle" fontWeight="bold" fontSize={13}>CO-ORDINATES</text>
        <text x={(xDsm + tableRight) / 2} y={ty + 16} textAnchor="middle" fontWeight="bold" fontSize={13}>D.S.M No.</text>
        {/* header row 2 */}
        <text x={(tx + xMetR) / 2} y={ty + 36} textAnchor="middle" fontWeight="bold" fontSize={12}>METRES</text>
        <text x={xPt + 30} y={ty + 36} textAnchor="middle" fontSize={11} fontWeight="bold">Y</text>
        <text x={(xY + xXR) / 2} y={ty + 36} textAnchor="middle" fontSize={11}>System {fmtSystem(meta.coordinateSystem)}</text>
        <text x={xX + 110} y={ty + 36} textAnchor="middle" fontSize={11} fontWeight="bold">X</text>
        <text x={(xDsm + tableRight) / 2} y={ty + 38} textAnchor="middle" fontSize={13}>{meta.dsmNo || ""}</text>
        {/* header row 3 — constants */}
        <text x={(xDir + xDirR) / 2} y={ty + 58} textAnchor="middle" fontWeight="bold" fontSize={11}>CONSTANTS</text>
        <text x={xY + 8} y={ty + 58} fontSize={11}>+    0,00</text>
        <text x={xX + 8} y={ty + 58} fontSize={11}>+    0,00</text>

        {/* data rows */}
        {Array.from({ length: n }).map((_, i) => {
          const s = sides[i];
          const p = points[i];
          const y = ty + headH + i * rowH + 14;
          return (
            <g key={`row${i}`} fontSize={13}>
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
      <text x={tx + 4} y={tableBottom + 32} fontSize={14} fontWeight="bold" textDecoration="underline">
        BEACON DESCRIPTION
      </text>
      {meta.beaconDescription.split(/\s*[;\n]\s*/).filter(Boolean).map((ln, i) => (
        <text key={`bd${i}`} x={tx + 4} y={tableBottom + 52 + i * 18} fontSize={14}>{ln}</text>
      ))}
      <text x={420} y={tableBottom + 88} textAnchor="middle" fontSize={15} letterSpacing="1">{meta.location}</text>

      {/* ===================== Director of Surveys block (right, under D.S.M) ===================== */}
      <text x={xDsm + 16} y={tableBottom + 32} fontSize={13}>Director of Surveys</text>
      <text x={xDsm + 16} y={tableBottom + 48} fontSize={13}>and Mapping</text>

      {/* ===================== North arrow + scale (right) ===================== */}
      <g transform={`translate(${850}, ${fig.y - 8})`}>
        <line x1={0} y1={46} x2={0} y2={-34} stroke="black" strokeWidth={1.3} />
        <polygon points="0,-46 -8,-22 0,-32 8,-22" fill="black" />
        <line x1={-14} y1={2} x2={14} y2={2} stroke="black" strokeWidth={0.8} />
        <text x={9} y={-2} fontSize={12} fontWeight="bold">N</text>
        <text x={-16} y={-2} fontSize={11}>T</text>
        {meta.scale > 0 && (
          <text x={0} y={70} textAnchor="middle" fontSize={11} fontWeight="bold">SCALE 1:{meta.scale.toLocaleString()}</text>
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
        const dx = bx - cx, dy = by - cy, len = Math.hypot(dx, dy) || 1;
        const lx = bx + (dx / len) * 18, ly = by + (dy / len) * 18;
        return (
          <g key={`bcn${i}`}>
            <circle cx={bx} cy={by} r={4} fill="white" stroke="black" strokeWidth={1.2} />
            <text x={lx} y={ly + 4} textAnchor="middle" fontSize={15} fontWeight="bold">{p.name}</text>
          </g>
        );
      })}
      {/* Extra points: shown as marks only (dot + label) — NOT part of the traverse
          (no boundary side, no coordinate-table row). */}
      {(extraPoints ?? []).map((p, i) => (
        <g key={`xp${i}`}>
          <circle cx={toX(p.east)} cy={toY(p.north)} r={3.2} fill="black" />
          <text x={toX(p.east) + 8} y={toY(p.north) + 4} fontSize={13}>{p.name}</text>
        </g>
      ))}

      {/* ===================== LEGAL DESCRIPTION ===================== */}
      <g textAnchor="middle">
        <text x={VB_W / 2} y={1200} fontSize={15} fontWeight="bold">
          THE FIGURE {figureLetters} REPRESENTS {areaText(meta.areaHa)} OF LAND CALLED
        </text>
        <text x={VB_W / 2} y={1224} fontSize={15} fontWeight="bold" textDecoration="underline">{landCalled}</text>
        <text x={VB_W / 2} y={1247} fontSize={14}>({meta.parent})</text>
        <text x={VB_W / 2} y={1269} fontSize={14}>SITUATE AT {meta.location} IN THE {meta.tribalArea}</text>
      </g>

      {/* ===================== certification + surveyor ===================== */}
      <text x={tx + 20} y={1330} fontSize={14}>
        {meta.kind === "compiled"
          ? `Compiled from ${dash(meta.sourceRef) || "—"}`
          : meta.kind === "framed"
          ? `Framed from ${dash(meta.sourceRef) || "—"}`
          : "Surveyed"}
      </text>
      <text x={tx + 40} y={1352} fontSize={14}>IN {meta.surveyedDate} BY ME,</text>
      <text x={VB_W - 300} y={1350} fontSize={14} fontWeight="bold">{meta.surveyor}</text>
      <text x={VB_W - 300} y={1370} fontSize={12}>LAND SURVEYOR</text>

      {/* ===================== DEDUCTIONS + deeds/annexure table ===================== */}
      <text x={tx + 4} y={annTop - 6} fontSize={9}>DEDUCTIONS FROM THIS DIAGRAM ARE MADE ON THE BACK HEREOF</text>
      <g fontSize={10}>
        <rect x={tx} y={annTop} width={tw} height={annBottom - annTop} fill="none" stroke="black" strokeWidth={0.8} />
        <line x1={annC1} y1={annTop} x2={annC1} y2={annBottom} stroke="black" strokeWidth={0.6} />
        <line x1={annC2} y1={annTop} x2={annC2} y2={annBottom} stroke="black" strokeWidth={0.6} />

        {/* left — Deeds Registry annexure */}
        <text x={tx + 8} y={annTop + 18}>This diagram is annexed to</text>
        <text x={tx + 8} y={annTop + 44}>No. {dash(meta.annexedToNo)}</text>
        <text x={tx + 8} y={annTop + 70}>Dated {dash(meta.annexedDate)}</text>
        <text x={annC1 - 70} y={annTop + 70}>in favour</text>
        <text x={tx + 8} y={annTop + 96}>of {dash(meta.annexedInFavourOf)}</text>
        {meta.annexName && meta.annexName.trim() && (
          <text x={(tx + annC1) / 2} y={annBottom - 24} textAnchor="middle" fontSize={11}>{meta.annexName}</text>
        )}
        <line x1={tx + 30} y1={annBottom - 18} x2={annC1 - 20} y2={annBottom - 18} stroke="black" strokeWidth={0.4} />
        <text x={(tx + annC1) / 2} y={annBottom - 8} textAnchor="middle">Registrar of Deeds</text>

        {/* middle — immediate parent diagram */}
        <text x={annC1 + 8} y={annTop + 18}>The immediate parent diagram is</text>
        <text x={annC2 - 12} y={annTop + 44} textAnchor="end">Annexed</text>
        <text x={annC1 + 8} y={annTop + 70}>to</text>
        <text x={annC1 + 40} y={annTop + 70}>No. {dash(meta.parentDiagramNo || meta.parentDiagram)}</text>

        {/* right — registration numbers (label + value in an aligned column, with a gap) */}
        <text x={annC2 + 10} y={annTop + 18}>General Plan No.</text>
        <text x={annC2 + 125} y={annTop + 18}>{dash(meta.gpNo)}</text>
        <text x={annC2 + 10} y={annTop + 44}>S.R No.</text>
        <text x={annC2 + 125} y={annTop + 44}>{dash(meta.srNo)}</text>
        <text x={annC2 + 10} y={annTop + 70}>D.S.M File:</text>
        <text x={annC2 + 125} y={annTop + 70}>{dash(meta.dsmFile)}</text>
        <text x={annC2 + 10} y={annTop + 96}>Comp.</text>
        <text x={annC2 + 125} y={annTop + 96}>{dash(meta.comp)}</text>
        <text x={annC2 + 10} y={annTop + 122}>Degree Square:</text>
        <text x={annC2 + 125} y={annTop + 122}>{dash(meta.degreeSquare)}</text>
        <text x={annC2 + 10} y={annTop + 148}>LIR No:</text>
        <text x={annC2 + 125} y={annTop + 148}>{dash(meta.lirNo)}</text>
      </g>
    </svg>
  );
});
