"use client";

import { forwardRef } from "react";
import { fmtCoord, fmtDist, type DiagramMeta, type DiagramPoint } from "./SgDiagram";

interface Props {
  meta: DiagramMeta;
  points: DiagramPoint[]; // reference marks the borehole is tied to
}

// Decimal degrees -> Botswana dotted DIRECTIONS notation "DDD.MM.SS".
function decToDotted(deg: number): string {
  deg = ((deg % 360) + 360) % 360;
  let d = Math.floor(deg);
  const rem = (deg - d) * 60;
  let m = Math.floor(rem);
  let s = Math.round((rem - m) * 60);
  if (s >= 60) {
    s -= 60;
    m += 1;
  }
  if (m >= 60) {
    m -= 60;
    d += 1;
  }
  return `${d}.${String(m).padStart(2, "0")}.${String(s).padStart(2, "0")}`;
}

const avg = (ns: number[]) => ns.reduce((a, b) => a + b, 0) / (ns.length || 1);

/**
 * Borehole site diagram — the surveyed borehole position connected by
 * bearing + distance ties to the surrounding reference marks, with the
 * coordinate schedule and certification block. Distinct template from the
 * parcel diagrams (no closed figure; the borehole is a single surveyed point).
 */
export const BoreholeDiagram = forwardRef<SVGSVGElement, Props>(function BoreholeDiagram(
  { meta, points },
  ref
) {
  const VB_W = 1400;
  const VB_H = 990;

  // Borehole position: the surveyed coordinate if entered, else the centroid of
  // the supplied reference marks as a placeholder.
  const bhE = meta.boreholeE ? meta.boreholeE : avg(points.map((p) => p.east));
  const bhN = meta.boreholeN ? meta.boreholeN : avg(points.map((p) => p.north));

  const draw = { x: 24, y: 70, w: 770, h: 850 };
  const pad = 90;
  const es = [...points.map((p) => p.east), bhE];
  const ns = [...points.map((p) => p.north), bhN];
  const minE = Math.min(...es),
    maxE = Math.max(...es);
  const minN = Math.min(...ns),
    maxN = Math.max(...ns);
  const spanE = Math.max(maxE - minE, 1e-6);
  const spanN = Math.max(maxN - minN, 1e-6);
  const scale = Math.min((draw.w - 2 * pad) / spanE, (draw.h - 2 * pad) / spanN);
  const offX = draw.x + (draw.w - spanE * scale) / 2;
  const offY = draw.y + (draw.h - spanN * scale) / 2;
  const toX = (e: number) => offX + (e - minE) * scale;
  const toY = (n: number) => offY + (maxN - n) * scale; // north up

  const bx = toX(bhE),
    by = toY(bhN);

  // Ties: bearing + distance from the borehole to each reference mark.
  const ties = points.map((p) => {
    const de = p.east - bhE;
    const dn = p.north - bhN;
    const dist = Math.hypot(de, dn);
    const brg = (Math.atan2(de, dn) * 180) / Math.PI;
    return { p, dist, brg };
  });

  const tbl = { x: 812, y: 70, w: 564 };
  const rowH = 24;
  const col = { name: tbl.x + 10, y: tbl.x + 180, x: tbl.x + 360 };

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: "100%", height: "auto", background: "white", fontFamily: "Arial, sans-serif" }}
    >
      <rect x={8} y={8} width={VB_W - 16} height={VB_H - 16} fill="white" stroke="black" strokeWidth={2} />
      <rect x={14} y={14} width={VB_W - 28} height={VB_H - 28} fill="none" stroke="black" strokeWidth={0.5} />

      {/* Caption */}
      <text x={draw.x + draw.w / 2} y={56} textAnchor="middle" fontSize={14} fontWeight="bold" textDecoration="underline">
        BOREHOLE DIAGRAM
      </text>

      {/* North arrow */}
      <g transform={`translate(${draw.x + draw.w - 60}, 100)`}>
        <line x1={0} y1={28} x2={0} y2={-22} stroke="black" strokeWidth={1.2} />
        <polygon points="0,-30 -6,-16 6,-16" fill="black" />
        <text x={0} y={44} textAnchor="middle" fontSize={13} fontWeight="bold">N</text>
      </g>

      {/* Tie lines + bearing/distance labels */}
      {ties.map((t, i) => {
        const px = toX(t.p.east),
          py = toY(t.p.north);
        const mx = (bx + px) / 2,
          my = (by + py) / 2;
        return (
          <g key={`tie${i}`}>
            <line x1={bx} y1={by} x2={px} y2={py} stroke="black" strokeWidth={1} strokeDasharray="6 3" />
            <text x={mx} y={my - 6} textAnchor="middle" fontSize={9.5}>{decToDotted(t.brg)}</text>
            <text x={mx} y={my + 6} textAnchor="middle" fontSize={9.5}>{fmtDist(t.dist)}</text>
          </g>
        );
      })}

      {/* Reference marks */}
      {points.map((p, i) => {
        const px = toX(p.east),
          py = toY(p.north);
        return (
          <g key={`rm${i}`}>
            <polygon
              points={`${px},${py - 6} ${px + 6},${py} ${px},${py + 6} ${px - 6},${py}`}
              fill="white"
              stroke="black"
              strokeWidth={1.2}
            />
            <text x={px} y={py - 10} textAnchor="middle" fontSize={11} fontWeight="bold">{p.name}</text>
          </g>
        );
      })}

      {/* Borehole symbol (circle + cross) */}
      <g>
        <circle cx={bx} cy={by} r={7} fill="white" stroke="black" strokeWidth={1.6} />
        <line x1={bx - 10} y1={by} x2={bx + 10} y2={by} stroke="black" strokeWidth={1} />
        <line x1={bx} y1={by - 10} x2={bx} y2={by + 10} stroke="black" strokeWidth={1} />
        <text x={bx + 12} y={by - 8} fontSize={11} fontWeight="bold">
          BH {meta.boreholeNo || ""}
        </text>
      </g>

      <text x={draw.x + draw.w / 2} y={draw.y + draw.h + 6} textAnchor="middle" fontSize={12} fontWeight="bold">
        SCALE 1:{meta.scale.toLocaleString()}
      </text>

      {/* Coordinate schedule */}
      <g fontSize={10.5}>
        <rect x={tbl.x} y={tbl.y} width={tbl.w} height={(points.length + 2) * rowH + 8} fill="none" stroke="black" strokeWidth={1} />
        <text x={col.name} y={tbl.y + 16} fontSize={9} fontWeight="bold">POINT</text>
        <text x={col.y} y={tbl.y + 16} fontSize={9} fontWeight="bold">Y</text>
        <text x={col.x} y={tbl.y + 16} fontSize={9} fontWeight="bold">X</text>
        <text x={col.x + 130} y={tbl.y + 16} fontSize={8.5}>System {meta.coordinateSystem}</text>
        <line x1={tbl.x} y1={tbl.y + rowH} x2={tbl.x + tbl.w} y2={tbl.y + rowH} stroke="black" strokeWidth={0.5} />
        {/* Borehole row */}
        <text x={col.name} y={tbl.y + rowH + 16} fontWeight="bold">BH {meta.boreholeNo || ""}</text>
        <text x={col.y} y={tbl.y + rowH + 16}>{fmtCoord(bhE)}</text>
        <text x={col.x} y={tbl.y + rowH + 16}>{fmtCoord(bhN)}</text>
        {/* Reference marks */}
        {points.map((p, i) => {
          const y = tbl.y + (i + 2) * rowH + 16;
          return (
            <g key={`cr${i}`}>
              <text x={col.name} y={y} fontWeight="bold">{p.name}</text>
              <text x={col.y} y={y}>{fmtCoord(p.east)}</text>
              <text x={col.x} y={y}>{fmtCoord(p.north)}</text>
            </g>
          );
        })}
      </g>

      {/* D.S.M No */}
      <text x={VB_W - 30} y={40} textAnchor="end" fontSize={11} fontWeight="bold">
        D.S.M No. {meta.dsmNo || "—"}
      </text>

      {/* Legal description */}
      <g textAnchor="middle" fontSize={12}>
        <text x={420} y={VB_H - 150} fontWeight="bold">
          THIS DIAGRAM REPRESENTS BOREHOLE {meta.boreholeNo || "—"}
        </text>
        <text x={420} y={VB_H - 132} fontWeight="bold" textDecoration="underline">{meta.lotName}</text>
        <text x={420} y={VB_H - 114} fontSize={11}>
          SITUATE AT {meta.location} IN THE {meta.tribalArea}
        </text>
      </g>

      {/* Surveyor + registration block */}
      <g fontSize={10}>
        <line x1={24} y1={VB_H - 80} x2={VB_W - 24} y2={VB_H - 80} stroke="black" strokeWidth={0.7} />
        <text x={36} y={VB_H - 60}>Surveyed in {meta.surveyedDate} by me</text>
        <text x={VB_W - 260} y={VB_H - 62} fontWeight="bold">{meta.surveyor}</text>
        <text x={VB_W - 260} y={VB_H - 48} fontSize={9}>Land Surveyor</text>
        <line x1={24} y1={VB_H - 44} x2={VB_W - 24} y2={VB_H - 44} stroke="black" strokeWidth={0.5} />
        <text x={36} y={VB_H - 26} fontSize={9.5}>S.R No. {meta.srNo || "—"}</text>
        <text x={640} y={VB_H - 26} fontSize={9.5}>Degree Square: {meta.degreeSquare || "—"}</text>
        <text x={980} y={VB_H - 26} fontSize={9.5}>System: {meta.coordinateSystem}</text>
      </g>
    </svg>
  );
});
