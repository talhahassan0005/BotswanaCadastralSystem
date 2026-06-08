"use client";

import { forwardRef } from "react";
import { fmtCoord, fmtDist, toDotted, type DiagramPoint, type DiagramSide } from "./SgDiagram";

/** Land Board "Tribal Lease Sketch" — compiled by Mapping from a base map. */
export interface LeaseMeta {
  fileNo: string; // e.g. "B"
  date: string; // e.g. "16/09/2025"
  compiledBy: string; // e.g. "O. Ithuteng"
  applicantName: string; // e.g. "Aobakwe Thuo Chijoro"
  useType: string; // e.g. "Residential"
  tribalLot: string; // e.g. "4266"
  village: string; // e.g. "Mmopane, Block 1"
  postal: string; // e.g. "P O Box 80934 Gaborone"
  coordinateSystem: string; // e.g. "Lo 25"
  localityScale: number; // e.g. 1530
  boundaryScale: number; // e.g. 1250
  areaM2: number;
}

interface Props {
  meta: LeaseMeta;
  points: DiagramPoint[];
  sides: DiagramSide[];
}

const avg = (ns: number[]) => ns.reduce((a, b) => a + b, 0) / (ns.length || 1);

/**
 * Reproduces the Mogoditshane-style Tribal Lease Sketch: a locality sketch
 * (surrounding tribal lots — populated from the imported base map), a boundary
 * sketch of the subject plot, the beacon-description / coordinate schedule, the
 * lease declaration and the witness blocks. Portrait A4.
 */
export const TribalLeaseSketch = forwardRef<SVGSVGElement, Props>(function TribalLeaseSketch(
  { meta, points, sides },
  ref
) {
  const W = 1000;
  const H = 1400;
  const figureLetters = points.map((p) => p.name ?? "?").join("");

  // ---- Boundary sketch figure transform (bottom-right panel) ----
  const bs = { x: 560, y: 760, w: 400, h: 230 };
  const pad = 46;
  const es = points.map((p) => p.east);
  const ns = points.map((p) => p.north);
  const minE = Math.min(...es), maxE = Math.max(...es);
  const minN = Math.min(...ns), maxN = Math.max(...ns);
  const spanE = Math.max(maxE - minE, 1e-6);
  const spanN = Math.max(maxN - minN, 1e-6);
  const sc = Math.min((bs.w - 2 * pad) / spanE, (bs.h - 2 * pad) / spanN);
  const offX = bs.x + (bs.w - spanE * sc) / 2;
  const offY = bs.y + (bs.h - spanN * sc) / 2;
  const toX = (e: number) => offX + (e - minE) * sc;
  const toY = (n: number) => offY + (maxN - n) * sc;
  const cE = avg(es), cN = avg(ns);
  const poly = points.map((p) => `${toX(p.east)},${toY(p.north)}`).join(" ");

  // ---- Beacon-description table (bottom-left) ----
  const tbl = { x: 40, y: 740, w: 480 };
  const rowH = 22;
  const c = { side: tbl.x + 6, dist: tbl.x + 70, dir: tbl.x + 150, pt: tbl.x + 250, y: tbl.x + 300, x: tbl.x + 400 };
  const headTop = tbl.y;
  const dataTop = headTop + rowH * 2.5;

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${W} ${H}`}
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: "100%", height: "auto", background: "white", fontFamily: "Arial, sans-serif" }}
    >
      <rect x={10} y={10} width={W - 20} height={H - 20} fill="white" stroke="black" strokeWidth={2} />

      {/* ---------- Header ---------- */}
      <text x={40} y={56} fontSize={15} fontWeight="bold" textDecoration="underline">TRIBAL LEASE SKETCH FOR :</text>
      <g fontSize={12}>
        <text x={300} y={56}>{meta.applicantName}</text>
        <text x={300} y={74}>{meta.useType}</text>
        <text x={300} y={92}>Tribal Lot {meta.tribalLot}</text>
        <text x={300} y={110}>{meta.village}</text>
        <text x={300} y={128}>{meta.postal}</text>
      </g>
      {/* File No box */}
      <text x={W - 150} y={40} fontSize={11}>FILE No</text>
      <rect x={W - 110} y={48} width={70} height={62} fill="none" stroke="black" strokeWidth={1.5} />
      <text x={W - 75} y={94} textAnchor="middle" fontSize={34} fontWeight="bold">{meta.fileNo}</text>
      <text x={W - 150} y={130} fontSize={11}>{meta.date}</text>

      <text x={40} y={150} fontSize={12}>COMPILED BY  {meta.compiledBy}</text>
      <text x={40} y={166} fontSize={11}>P.T.O (Mapping)</text>
      <text x={40} y={190} fontSize={12} fontStyle="italic">Portion Of Tribal Lots</text>

      {/* ---------- Locality sketch ---------- */}
      <text x={W - 60} y={196} textAnchor="end" fontSize={16} fontWeight="bold">Locality Sketch</text>
      <NorthArrow x={W - 40} y={210} />
      <text x={40} y={214} fontSize={11} fontWeight="bold">SCALE 1 : {meta.localityScale.toLocaleString()}</text>
      <rect x={40} y={224} width={W - 80} height={300} fill="#fbfbfb" stroke="#cbd5e1" strokeWidth={1} strokeDasharray="5 4" />
      {/* subject plot sketched small + dependency note */}
      <polygon
        points={points.map((p) => `${500 + (p.east - cE) * 0.5},${380 - (p.north - cN) * 0.5}`).join(" ")}
        fill="#d1fae5"
        stroke="#065f46"
        strokeWidth={1.5}
      />
      <text x={500} y={388} textAnchor="middle" fontSize={11} fontWeight="bold">{meta.tribalLot}</text>
      <text x={W / 2} y={500} textAnchor="middle" fontSize={11} fill="#64748b">
        Surrounding tribal lots are populated from the imported base map (DXF / Shapefile).
      </text>

      {/* ---------- Boundary sketch ---------- */}
      <text x={bs.x + bs.w} y={742} textAnchor="end" fontSize={15} fontWeight="bold">Boundary Sketch</text>
      <NorthArrow x={bs.x + bs.w + 18} y={756} />
      <polygon points={poly} fill="none" stroke="black" strokeWidth={1.6} />
      {points.map((p, i) => {
        const bx = toX(p.east), by = toY(p.north);
        const dx = bx - (offX + (cE - minE) * sc), dy = by - (offY + (maxN - cN) * sc);
        const len = Math.hypot(dx, dy) || 1;
        return (
          <g key={`b${i}`}>
            <circle cx={bx} cy={by} r={3} fill="white" stroke="black" strokeWidth={1.2} />
            <text x={bx + (dx / len) * 14} y={by + (dy / len) * 14 + 3} textAnchor="middle" fontSize={11} fontWeight="bold">
              {p.name}
            </text>
          </g>
        );
      })}

      {/* ---------- Beacon descriptions table ---------- */}
      <text x={tbl.x} y={tbl.y - 26} fontSize={11} fontWeight="bold">SCALE 1 : {meta.boundaryScale.toLocaleString()}</text>
      <text x={tbl.x} y={tbl.y - 10} fontSize={12} fontWeight="bold">BEACON DESCRIPTIONS</text>
      <g fontSize={10}>
        <rect x={tbl.x} y={tbl.y} width={tbl.w} height={dataTop + Math.max(points.length, sides.length) * rowH - tbl.y} fill="none" stroke="black" strokeWidth={1} />
        <text x={c.side} y={headTop + 14} fontSize={8.5} fontWeight="bold">Sides Metres</text>
        <text x={c.dir} y={headTop + 14} fontSize={8.5} fontWeight="bold">Directions</text>
        <text x={c.y + 50} y={headTop + 14} fontSize={8.5} fontWeight="bold" textAnchor="middle">Co-ordinates</text>
        <text x={c.y + 50} y={headTop + 26} fontSize={8} textAnchor="middle">System {meta.coordinateSystem}</text>
        <text x={c.y} y={headTop + rowH * 2 - 2} fontSize={8.5} fontWeight="bold">Y</text>
        <text x={c.x} y={headTop + rowH * 2 - 2} fontSize={8.5} fontWeight="bold">X</text>
        {/* constants */}
        <text x={c.side} y={dataTop - 4} fontStyle="italic">Constants</text>
        <text x={c.y} y={dataTop - 4}>0,00</text>
        <text x={c.x} y={dataTop - 4}>0,00</text>
        <line x1={c.pt - 10} y1={tbl.y} x2={c.pt - 10} y2={dataTop + Math.max(points.length, sides.length) * rowH} stroke="black" strokeWidth={0.5} />
        <line x1={tbl.x} y1={dataTop} x2={tbl.x + tbl.w} y2={dataTop} stroke="black" strokeWidth={0.5} />
        {Array.from({ length: Math.max(points.length, sides.length) }).map((_, i) => {
          const s = sides[i];
          const p = points[i];
          const y = dataTop + i * rowH + 15;
          return (
            <g key={`r${i}`}>
              {s && (
                <>
                  <text x={c.side} y={y}>{`${s.from ?? ""}${s.to ?? ""}`}</text>
                  <text x={c.dist} y={y} textAnchor="end">{fmtDist(s.distance)}</text>
                  <text x={c.dir} y={y}>{toDotted(s.bearing_dms)}</text>
                </>
              )}
              {p && (
                <>
                  <text x={c.pt} y={y} fontWeight="bold">{p.name}</text>
                  <text x={c.y} y={y}>{fmtCoord(p.east)}</text>
                  <text x={c.x} y={y}>{fmtCoord(p.north)}</text>
                </>
              )}
            </g>
          );
        })}
      </g>

      {/* ---------- Declaration ---------- */}
      <g fontSize={12}>
        <text x={40} y={1075}>
          The figure {figureLetters} represents about {Math.round(meta.areaM2).toLocaleString()} square metres of land
        </text>
        <text x={40} y={1098} fontSize={11}>
          This sketch is to be submitted to the land board in support of an application for tribal lease. It does
        </text>
        <text x={40} y={1114} fontSize={11}>not imply any rights to the land.</text>
      </g>

      {/* ---------- Witness blocks ---------- */}
      <g fontSize={11}>
        <line x1={40} y1={1135} x2={W - 40} y2={1135} stroke="black" strokeWidth={0.7} />
        <text x={48} y={1158} fontWeight="bold">LAND BOARD WITNESSES</text>
        <text x={W / 2 + 20} y={1158} fontWeight="bold">LESSEE WITNESSES</text>
        <line x1={W / 2} y1={1135} x2={W / 2} y2={1300} stroke="black" strokeWidth={0.5} />
        <line x1={40} y1={1300} x2={W - 40} y2={1300} stroke="black" strokeWidth={0.7} />
      </g>
    </svg>
  );
});

function NorthArrow({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x}, ${y})`}>
      <line x1={0} y1={22} x2={0} y2={-14} stroke="black" strokeWidth={1.1} />
      <polygon points="0,-20 -5,-9 5,-9" fill="black" />
      <text x={0} y={36} textAnchor="middle" fontSize={11} fontWeight="bold">N</text>
    </g>
  );
}
