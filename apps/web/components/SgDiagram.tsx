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
  lotName: string;        // e.g. "LOT 14182 CHARLESHILL"
  parent: string;         // e.g. "A PORTION OF CADASTRE 243"
  location: string;       // e.g. "CHARLESHILL"
  tribalArea: string;     // e.g. "GHANZI TRIBAL AREA"
  surveyor: string;       // e.g. "G. G. SESINYI"
  surveyedDate: string;   // e.g. "FEBRUARY 2026"
  coordinateSystem: string; // e.g. "Lo 21"
  scale: number;          // e.g. 5000
  dsmNo: string;
  srNo: string;
  gpNo: string;
  degreeSquare: string;
  beaconDescription: string; // e.g. "ALL: 12mm iron peg"
  areaHa: number;
  closed: boolean;
  kind?: DiagramKind;        // template variant (defaults to "surveyed")
  sourceRef?: string;        // Compiled-from / Framed-from source document
  boreholeNo?: string;       // borehole identifier (borehole template)
}

const KIND_CAPTION: Record<DiagramKind, string> = {
  surveyed: "SURVEYED DIAGRAM",
  compiled: "COMPILED DIAGRAM",
  framed: "FRAMED DIAGRAM",
  borehole: "BOREHOLE DIAGRAM",
  lease: "TRIBAL LEASE SKETCH",
};

/** Certification line wording — differs per diagram type per SG convention. */
export function certificationLine(meta: DiagramMeta): string {
  switch (meta.kind) {
    case "compiled":
      return `Compiled in ${meta.surveyedDate} by me${meta.sourceRef ? ` from ${meta.sourceRef}` : ""}`;
    case "framed":
      return `Framed${meta.sourceRef ? ` from ${meta.sourceRef}` : ""} in ${meta.surveyedDate} by me`;
    default:
      return `Surveyed in ${meta.surveyedDate} by me`;
  }
}

interface Props {
  meta: DiagramMeta;
  points: DiagramPoint[];
  sides: DiagramSide[];
}

// ---------------------------------------------------------------------------
// Botswana number formatting (European: space thousands, comma decimal)
// ---------------------------------------------------------------------------
function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Signed coordinate: 93205.88 -> "+93 205,88" */
export function fmtCoord(n: number): string {
  const sign = n < 0 ? "-" : "+";
  const [i, f] = Math.abs(n).toFixed(2).split(".");
  return `${sign}${groupThousands(i)},${f}`;
}

/** Distance: 408.24 -> "408,24" */
export function fmtDist(n: number): string {
  const [i, f] = n.toFixed(2).split(".");
  return `${groupThousands(i)},${f}`;
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
// Component — renders a Botswana SG-style cadastral diagram as scalable SVG.
// ---------------------------------------------------------------------------
export const SgDiagram = forwardRef<SVGSVGElement, Props>(function SgDiagram(
  { meta, points, sides },
  ref
) {
  const VB_W = 1400;
  const VB_H = 990;

  // ---- Figure transform (north-up, fit to drawing panel) ----
  const draw = { x: 24, y: 70, w: 770, h: 850 };
  const pad = 70;
  const es = points.map((p) => p.east);
  const ns = points.map((p) => p.north);
  const minE = Math.min(...es), maxE = Math.max(...es);
  const minN = Math.min(...ns), maxN = Math.max(...ns);
  const spanE = Math.max(maxE - minE, 1e-6);
  const spanN = Math.max(maxN - minN, 1e-6);
  const scale = Math.min((draw.w - 2 * pad) / spanE, (draw.h - 2 * pad) / spanN);
  const drawW = spanE * scale;
  const drawH = spanN * scale;
  const offX = draw.x + (draw.w - drawW) / 2;
  const offY = draw.y + (draw.h - drawH) / 2;
  const toX = (e: number) => offX + (e - minE) * scale;
  const toY = (n: number) => offY + (maxN - n) * scale; // flip Y so north is up

  const cE = avg(es), cN = avg(ns);
  const cx = toX(cE), cy = toY(cN);

  const polyPoints = points.map((p) => `${toX(p.east)},${toY(p.north)}`).join(" ");

  // ---- Coordinate table layout ----
  const tbl = { x: 812, y: 24, w: 564 };
  const col = {
    side: tbl.x + 6,
    dist: tbl.x + 70,
    dir: tbl.x + 180,
    pt: tbl.x + 300,
    y: tbl.x + 330,
    x: tbl.x + 448,
  };
  const rowH = 22;
  const headTop = tbl.y;
  const dataTop = headTop + rowH * 3; // 3 header rows (group, labels, constants)
  const nRows = Math.max(points.length, sides.length);

  const figureLetters =
    points.map((p) => p.name ?? "?").join(" ") + (meta.closed ? ` ${points[0]?.name ?? ""}` : "");

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: "100%", height: "auto", background: "white", fontFamily: "Arial, sans-serif" }}
    >
      {/* Outer border */}
      <rect x={8} y={8} width={VB_W - 16} height={VB_H - 16} fill="white" stroke="black" strokeWidth={2} />
      <rect x={14} y={14} width={VB_W - 28} height={VB_H - 28} fill="none" stroke="black" strokeWidth={0.5} />

      {/* ---------- Diagram-type caption ---------- */}
      <text
        x={draw.x + draw.w / 2}
        y={56}
        textAnchor="middle"
        fontSize={14}
        fontWeight="bold"
        textDecoration="underline"
      >
        {KIND_CAPTION[meta.kind ?? "surveyed"]}
      </text>

      {/* ---------- North arrow ---------- */}
      <g transform={`translate(${draw.x + draw.w - 70}, 96)`}>
        <line x1={0} y1={28} x2={0} y2={-22} stroke="black" strokeWidth={1.2} />
        <polygon points="0,-30 -6,-16 6,-16" fill="black" />
        <text x={0} y={44} textAnchor="middle" fontSize={13} fontWeight="bold">N</text>
        <text x={-22} y={6} textAnchor="middle" fontSize={10}>T</text>
      </g>

      {/* ---------- Figure ---------- */}
      <polygon
        points={polyPoints}
        fill="none"
        stroke="black"
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
      {/* Side labels: bearing (dotted) + distance at edge midpoints */}
      {sides.map((s, i) => {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        if (!a || !b) return null;
        const mx = (toX(a.east) + toX(b.east)) / 2;
        const my = (toY(a.north) + toY(b.north)) / 2;
        // perpendicular offset, away from centroid
        const dx = mx - cx, dy = my - cy;
        const len = Math.hypot(dx, dy) || 1;
        const ox = mx + (dx / len) * 16;
        const oy = my + (dy / len) * 16;
        return (
          <g key={`s${i}`}>
            <text x={ox} y={oy - 5} textAnchor="middle" fontSize={9.5} fill="#111">
              {toDotted(s.bearing_dms)}
            </text>
            <text x={ox} y={oy + 6} textAnchor="middle" fontSize={9.5} fill="#111">
              {fmtDist(s.distance)}
            </text>
          </g>
        );
      })}
      {/* Beacons */}
      {points.map((p, i) => {
        const bx = toX(p.east), by = toY(p.north);
        const dx = bx - cx, dy = by - cy;
        const len = Math.hypot(dx, dy) || 1;
        const lx = bx + (dx / len) * 20;
        const ly = by + (dy / len) * 20;
        return (
          <g key={`b${i}`}>
            <circle cx={bx} cy={by} r={3.2} fill="white" stroke="black" strokeWidth={1.2} />
            <text x={lx} y={ly + 3} textAnchor="middle" fontSize={12} fontWeight="bold">
              {p.name}
            </text>
          </g>
        );
      })}

      {/* Scale text under figure */}
      <text x={draw.x + draw.w / 2} y={draw.y + draw.h + 6} textAnchor="middle" fontSize={12} fontWeight="bold">
        SCALE 1:{meta.scale.toLocaleString()}
      </text>

      {/* ---------- Coordinate table ---------- */}
      <g fontSize={10.5}>
        {/* outer box */}
        <rect x={tbl.x} y={tbl.y} width={tbl.w} height={dataTop + nRows * rowH - tbl.y} fill="none" stroke="black" strokeWidth={1} />
        {/* group header */}
        <text x={col.side} y={headTop + 15} fontSize={9} fontWeight="bold">SIDES</text>
        <text x={col.side} y={headTop + 15 + 10} fontSize={9} fontWeight="bold">METRES</text>
        <text x={col.dir} y={headTop + 15} fontSize={9} fontWeight="bold">DIRECTIONS</text>
        <text x={col.y + 40} y={headTop + 15} fontSize={9} fontWeight="bold" textAnchor="middle">
          CO-ORDINATES
        </text>
        <text x={col.y + 40} y={headTop + 15 + 10} fontSize={8.5} textAnchor="middle">
          System {meta.coordinateSystem}
        </text>
        {/* sub labels */}
        <text x={col.y} y={headTop + rowH * 2 - 4} fontSize={9} fontWeight="bold">Y</text>
        <text x={col.x} y={headTop + rowH * 2 - 4} fontSize={9} fontWeight="bold">X</text>
        {/* constants row */}
        <text x={col.side} y={dataTop - 5} fontSize={9} fontWeight="bold">CONSTANTS</text>
        <text x={col.y} y={dataTop - 5} fontSize={9}>+ 0,00</text>
        <text x={col.x} y={dataTop - 5} fontSize={9}>+ 0,00</text>
        {/* column separators */}
        <line x1={col.pt - 12} y1={tbl.y} x2={col.pt - 12} y2={dataTop + nRows * rowH} stroke="black" strokeWidth={0.5} />
        <line x1={tbl.x} y1={dataTop} x2={tbl.x + tbl.w} y2={dataTop} stroke="black" strokeWidth={0.5} />
        {/* data rows */}
        {Array.from({ length: nRows }).map((_, i) => {
          const s = sides[i];
          const p = points[i];
          const y = dataTop + i * rowH + 15;
          return (
            <g key={`r${i}`}>
              {s && (
                <>
                  <text x={col.side} y={y}>{`${s.from ?? ""}${s.to ?? ""}`}</text>
                  <text x={col.dist} y={y} textAnchor="end">{fmtDist(s.distance)}</text>
                  <text x={col.dir} y={y}>{toDotted(s.bearing_dms)}</text>
                </>
              )}
              {p && (
                <>
                  <text x={col.pt} y={y} fontWeight="bold">{p.name}</text>
                  <text x={col.y} y={y}>{fmtCoord(p.east)}</text>
                  <text x={col.x} y={y}>{fmtCoord(p.north)}</text>
                </>
              )}
            </g>
          );
        })}
      </g>

      {/* ---------- Beacon description ---------- */}
      <g>
        <text x={tbl.x} y={dataTop + nRows * rowH + 30} fontSize={11} fontWeight="bold" textDecoration="underline">
          Description of Beacons
        </text>
        <text x={tbl.x} y={dataTop + nRows * rowH + 48} fontSize={11}>
          {meta.beaconDescription}
        </text>
      </g>

      {/* ---------- DSM No (top-right corner) + Approval ---------- */}
      <g>
        <text x={VB_W - 30} y={40} textAnchor="end" fontSize={11} fontWeight="bold">
          D.S.M No. {meta.dsmNo || "—"}
        </text>
      </g>
      <g>
        <rect x={VB_W - 320} y={dataTop + nRows * rowH + 70} width={290} height={90} fill="none" stroke="black" strokeWidth={0.7} />
        <text x={VB_W - 175} y={dataTop + nRows * rowH + 92} textAnchor="middle" fontSize={10}>Approved</text>
        <line x1={VB_W - 300} y1={dataTop + nRows * rowH + 130} x2={VB_W - 50} y2={dataTop + nRows * rowH + 130} stroke="black" strokeWidth={0.5} />
        <text x={VB_W - 175} y={dataTop + nRows * rowH + 148} textAnchor="middle" fontSize={9.5}>
          Director of Surveys and Mapping
        </text>
      </g>

      {/* ---------- Legal description (bottom-center) ---------- */}
      <g textAnchor="middle" fontSize={12}>
        <text x={420} y={VB_H - 150} fontWeight="bold">
          THE FIGURE {figureLetters} REPRESENTS {meta.areaHa.toFixed(4)} HECTARES OF LAND CALLED
        </text>
        <text x={420} y={VB_H - 132} fontWeight="bold" textDecoration="underline">{meta.lotName}</text>
        <text x={420} y={VB_H - 114} fontSize={11}>({meta.parent})</text>
        <text x={420} y={VB_H - 96} fontSize={11}>
          SITUATE AT {meta.location} IN THE {meta.tribalArea}
        </text>
      </g>

      {/* ---------- Surveyor + registration block (bottom) ---------- */}
      <g fontSize={10}>
        <line x1={24} y1={VB_H - 80} x2={VB_W - 24} y2={VB_H - 80} stroke="black" strokeWidth={0.7} />
        <text x={36} y={VB_H - 60}>{certificationLine(meta)}</text>
        <text x={VB_W - 260} y={VB_H - 62} fontWeight="bold">{meta.surveyor}</text>
        <text x={VB_W - 260} y={VB_H - 48} fontSize={9}>Land Surveyor</text>
        <line x1={24} y1={VB_H - 44} x2={VB_W - 24} y2={VB_H - 44} stroke="black" strokeWidth={0.5} />
        <text x={36} y={VB_H - 26} fontSize={9.5}>S.R No. {meta.srNo || "—"}</text>
        <text x={300} y={VB_H - 26} fontSize={9.5}>General Plan No. {meta.gpNo || "—"}</text>
        <text x={640} y={VB_H - 26} fontSize={9.5}>Degree Square: {meta.degreeSquare || "—"}</text>
        <text x={980} y={VB_H - 26} fontSize={9.5}>System: {meta.coordinateSystem}</text>
      </g>
    </svg>
  );
});
