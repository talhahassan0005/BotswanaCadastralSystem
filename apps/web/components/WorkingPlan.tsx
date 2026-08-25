"use client";

import { forwardRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { ManualAnnotation, ManualText } from "./SgDiagram";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface WorkingPlanPoint {
  name: string | null;
  east: number;
  north: number;
}

export interface WorkingPlanSide {
  from: string | null;
  to: string | null;
  bearing_dms: string;
  distance: number;
}

export interface WorkingPlanMeta {
  lotName: string;            // "LOT 2773 TLOKWENG"
  tribalArea: string;         // "BATLOKWA TRIBAL TERRITORY"
  scale: number;              // 750
  coordinateSystem: string;   // "Lo 25"
  observedFrom: string;       // "TLO8"
  checkedFrom: string;        // "WP1"
  referenceMarkDescription: string;   // "All Reference Marks: 20mm Iron Peg in Concrete"
  workingStationDescription: string;  // "WP1: 12mm Iron Peg"
  placedBeaconDescription: string;    // "ALL: 12mm Iron Peg"
  surveyor?: string;                  // Land Surveyor — auto from the project surveyor
  dateOfSurvey?: string;              // "Date of survey" — entered manually
}

interface Props {
  meta: WorkingPlanMeta;
  points: WorkingPlanPoint[];
  sides: WorkingPlanSide[];
  /** Reference-mark points (client req 2026-08-20, Part 12b) — excluded from
   *  the Cadastral work station, but shown here in the locality inset since
   *  this is where reference marks are actually used/referenced. */
  refMarks?: WorkingPlanPoint[];
  /** The same hand-drawn extension lines and text notes added under
   *  Diagrams (client req 2026-08-26: "I want to see these edits also
   *  appearing at the working plan") — read-only here, anchored in the same
   *  real east/north coordinates and converted through this view's own
   *  scale/position, same as the boundary itself. */
  manualAnnotations?: ManualAnnotation[];
  manualTexts?: ManualText[];
  /** Per-point label nudge + size, keyed by point name (client req
   *  2026-08-26, Part 29a: "will it be possible to snap/click on the text
   *  then... manually move it?", extended same day: "I want to be able to
   *  move and resize text" — labels near tightly-spaced beacons like D/E/F
   *  can end up sitting on top of each other). dx/dy is applied on top of
   *  the auto-computed label position, and scale on top of the base font
   *  size, so both stay small corrections rather than absolute values that
   *  could drift if the figure changes. */
  labelOffsets?: Record<string, { dx: number; dy: number; scale?: number }>;
  selectedLabel?: string | null;
  onLabelClick?: (name: string, e: ReactMouseEvent<SVGElement>) => void;
  onLabelPointerDown?: (name: string, e: ReactPointerEvent<SVGElement>) => void;
  onLabelPointerMove?: (name: string, e: ReactPointerEvent<SVGElement>) => void;
  onLabelPointerUp?: (name: string, e: ReactPointerEvent<SVGElement>) => void;
  onLabelResize?: (name: string, delta: number) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const avg = (ns: number[]) => ns.reduce((a, b) => a + b, 0) / (ns.length || 1);

/** Pick a "nice" grid step so 3–6 gridlines span the given range. */
function niceStep(span: number): number {
  if (!(span > 0)) return 1;
  const target = span / 4; // aim for ~4–5 lines
  const mag = Math.pow(10, Math.floor(Math.log10(target)));
  const norm = target / mag;
  let mult: number;
  if (norm <= 1) mult = 1;
  else if (norm <= 2) mult = 2;
  else if (norm <= 5) mult = 5;
  else mult = 10;
  return mult * mag;
}

/** Gridline values (multiples of step) covering [lo, hi]. */
function gridValues(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  const start = Math.ceil(lo / step) * step;
  for (let v = start; v <= hi + 1e-6; v += step) {
    // round to clean integer/decimal to avoid float dust
    out.push(Math.round(v * 1e6) / 1e6);
  }
  return out;
}

const GRID_BLUE = "#2563eb";
const INSET_GREEN = "#16a34a";
const REF_RED = "#dc2626";

// ---------------------------------------------------------------------------
// Component — Botswana Working Plan as a scalable portrait SVG.
// ---------------------------------------------------------------------------
export const WorkingPlan = forwardRef<SVGSVGElement, Props>(function WorkingPlan(
  {
    meta,
    points,
    refMarks,
    manualAnnotations,
    manualTexts,
    labelOffsets,
    selectedLabel,
    onLabelClick,
    onLabelPointerDown,
    onLabelPointerMove,
    onLabelPointerUp,
    onLabelResize,
  },
  ref
) {
  const VB_W = 600;
  const VB_H = 800;

  // ---- Empty / degenerate state ----
  if (points.length < 3) {
    return (
      <svg
        ref={ref}
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: "100%", height: "auto", background: "white", fontFamily: "'Courier New', Courier, monospace" }}
      >
        <rect x={6} y={6} width={VB_W - 12} height={VB_H - 12} fill="white" stroke="black" strokeWidth={1.5} />
        <text x={VB_W / 2} y={VB_H / 2} textAnchor="middle" fontSize={16} fill="#333">
          No figure — run a closed traverse or build a parcel first.
        </text>
      </svg>
    );
  }

  // ---- Figure transform (north-up, fit to drawing panel) ----
  // h shrunk from 420 (client req 2026-08-26, Part 29d "label both sides") —
  // the newly-added bottom-edge grid labels need clearance below the panel
  // before the "observed from / checked from" note and the description
  // blocks start; a full 420 left no room and the two collided.
  const draw = { x: 70, y: 130, w: 460, h: 390 };
  const pad = 56;
  const es = points.map((p) => p.east);
  const ns = points.map((p) => p.north);
  const minE = Math.min(...es), maxE = Math.max(...es);
  const minN = Math.min(...ns), maxN = Math.max(...ns);
  const spanE = Math.max(maxE - minE, 1e-6);
  const spanN = Math.max(maxN - minN, 1e-6);
  const fit = Math.min((draw.w - 2 * pad) / spanE, (draw.h - 2 * pad) / spanN);
  const drawW = spanE * fit;
  const drawH = spanN * fit;
  const offX = draw.x + (draw.w - drawW) / 2;
  const offY = draw.y + (draw.h - drawH) / 2;
  const toX = (e: number) => offX + (e - minE) * fit;
  const toY = (n: number) => offY + (maxN - n) * fit; // flip Y so north is up

  const cE = avg(es), cN = avg(ns);
  const cx = toX(cE), cy = toY(cN);

  const polyPoints = points.map((p) => `${toX(p.east)},${toY(p.north)}`).join(" ");

  // ---- Coordinate grid (blue, nice intervals across the figure bounds) ----
  const stepE = niceStep(spanE);
  const stepN = niceStep(spanN);
  // expand a little beyond the strict bounds so the figure sits inside the grid
  const eLines = gridValues(minE - stepE, maxE + stepE, stepE).filter(
    (v) => toX(v) >= draw.x - 2 && toX(v) <= draw.x + draw.w + 2
  );
  const nLines = gridValues(minN - stepN, maxN + stepN, stepN).filter(
    (v) => toY(v) >= draw.y - 2 && toY(v) <= draw.y + draw.h + 2
  );
  const fmtGrid = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  // "X-2732200" / "Y+91000" (client req 2026-08-26, Part 29c) — axis letter
  // directly against the signed value, sign always shown (so a positive
  // value still gets an explicit "+", matching fmtGrid's own bare minus for
  // negatives). Y = easting (vertical gridlines), X = northing (horizontal
  // gridlines) — the same convention as the printed diagram's Y/X table.
  const fmtAxis = (axis: "X" | "Y", v: number) => `${axis}${v >= 0 ? "+" : ""}${fmtGrid(v)}`;

  // ---- Inset (locality, not to scale) ----
  const inset = { x: 26, y: VB_H - 130, w: 150, h: 104 };
  const insetPad = 24;
  const iFit = Math.min((inset.w - 2 * insetPad) / spanE, (inset.h - 2 * insetPad) / spanN);
  const iDrawW = spanE * iFit;
  const iDrawH = spanN * iFit;
  const iOffX = inset.x + (inset.w - iDrawW) / 2;
  const iOffY = inset.y + (inset.h - iDrawH) / 2;
  const iX = (e: number) => iOffX + (e - minE) * iFit;
  const iY = (n: number) => iOffY + (maxN - n) * iFit;
  const insetPoly = points.map((p) => `${iX(p.east)},${iY(p.north)}`).join(" ");
  // Real reference-mark points (client req 2026-08-20, Part 12b) — clamped to
  // stay inside the inset box since it's an explicitly "not to scale" locality
  // diagram and a ref mark's true coordinates are usually outside the tight
  // parcel bounding box the inset is fitted to.
  const refDots = (refMarks ?? []).map((r) => ({
    x: Math.min(inset.x + inset.w - 8, Math.max(inset.x + 8, iX(r.east))),
    y: Math.min(inset.y + inset.h - 8, Math.max(inset.y + 8, iY(r.north))),
    label: r.name || "RM",
  }));

  // ---- Bottom description blocks ----
  const descTop = VB_H - 200;
  // ---- Certification box (bottom-right, narrower to match the template) ----
  const cert = { x: 300, y: VB_H - 130, w: 260, h: 104 };

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      xmlns="http://www.w3.org/2000/svg"
      fill="#000"
      style={{ width: "100%", height: "auto", background: "white", color: "#000", fontFamily: "'Courier New', Courier, monospace" }}
    >
      {/* Outer border */}
      <rect x={6} y={6} width={VB_W - 12} height={VB_H - 12} fill="white" stroke="black" strokeWidth={2} />
      <rect x={12} y={12} width={VB_W - 24} height={VB_H - 24} fill="none" stroke="black" strokeWidth={0.5} />

      {/* ---------- Title block (top-centre) ---------- */}
      <g textAnchor="middle" fontWeight="bold">
        <text x={VB_W / 2} y={40} fontSize={14} textDecoration="underline">WORKING PLAN OF</text>
        <text x={VB_W / 2} y={62} fontSize={14} textDecoration="underline">{meta.lotName}</text>
        <text x={VB_W / 2} y={84} fontSize={12} textDecoration="underline">{meta.tribalArea}</text>
        <text x={VB_W / 2} y={104} fontSize={12} textDecoration="underline">1:{meta.scale}</text>
      </g>

      {/* ---------- North arrow (top-right) — "T N" below the arrow ---------- */}
      <g transform={`translate(${VB_W - 60}, 70)`}>
        <line x1={0} y1={24} x2={0} y2={-20} stroke="black" strokeWidth={1.2} />
        <polygon points="0,-28 -6,-14 6,-14" fill="black" />
        <line x1={0} y1={30} x2={0} y2={44} stroke="black" strokeWidth={0.6} />
        <text x={-9} y={42} textAnchor="middle" fontSize={11} fontWeight="bold">T</text>
        <text x={9} y={42} textAnchor="middle" fontSize={11} fontWeight="bold">N</text>
      </g>

      {/* ---------- Coordinate grid (blue) ---------- */}
      <g stroke={GRID_BLUE} strokeWidth={0.5}>
        {eLines.map((v, i) => (
          <line key={`ev${i}`} x1={toX(v)} y1={draw.y} x2={toX(v)} y2={draw.y + draw.h} />
        ))}
        {nLines.map((v, i) => (
          <line key={`nv${i}`} x1={draw.x} y1={toY(v)} x2={draw.x + draw.w} y2={toY(v)} />
        ))}
      </g>
      {/* Grid axis labels — both edges, "X"/"Y"-prefixed signed format
          (client req 2026-08-26, Part 29c/29d: "Label both sides") — a
          coordinate near one edge of the sheet used to have no nearby
          label at all if that edge wasn't the labelled one. */}
      <g fill={GRID_BLUE} fontSize={8}>
        {eLines.map((v, i) => (
          <text
            key={`elt${i}`}
            x={toX(v)}
            y={draw.y - 4}
            textAnchor="start"
            transform={`rotate(-90 ${toX(v)} ${draw.y - 4})`}
          >
            {fmtAxis("Y", v)}
          </text>
        ))}
        {eLines.map((v, i) => (
          // Same rotate(-90) as the top labels (client req 2026-08-26:
          // "rotate the Y-Axis to face the same direction with the one at
          // the top" — rotate(90) read mirrored/upside-down against the top
          // ones). anchor="end" (not "start") is what keeps the text
          // extending downward, away from the drawing, under this shared
          // rotation instead of back up into it.
          <text
            key={`elb${i}`}
            x={toX(v)}
            y={draw.y + draw.h + 4}
            textAnchor="end"
            transform={`rotate(-90 ${toX(v)} ${draw.y + draw.h + 4})`}
          >
            {fmtAxis("Y", v)}
          </text>
        ))}
        {nLines.map((v, i) => (
          <text key={`nll${i}`} x={draw.x - 4} y={toY(v) + 3} textAnchor="end">
            {fmtAxis("X", v)}
          </text>
        ))}
        {nLines.map((v, i) => (
          <text key={`nlr${i}`} x={draw.x + draw.w + 4} y={toY(v) + 3} textAnchor="start">
            {fmtAxis("X", v)}
          </text>
        ))}
      </g>

      {/* ---------- Figure ---------- */}
      <polygon points={polyPoints} fill="none" stroke="black" strokeWidth={1.6} strokeLinejoin="round" />

      {/* Side distances are intentionally NOT shown on the working plan (client request). */}

      {/* Beacons: open circles + bold, DRAGGABLE labels placed outside the
          figure (client req 2026-08-26, Part 29a: "snap/click on the text
          then... manually move it" — tightly-spaced beacons like D/E/F can
          end up with labels sitting on top of each other). Click to
          select, then drag; a selected label gets a dashed handle box. */}
      {points.map((p, i) => {
        const bx = toX(p.east), by = toY(p.north);
        const dx = bx - cx, dy = by - cy;
        const len = Math.hypot(dx, dy) || 1;
        const off = (p.name && labelOffsets?.[p.name]) || { dx: 0, dy: 0, scale: 1 };
        const scale = off.scale ?? 1;
        const fs = 10 * scale;
        const lx = bx + (dx / len) * 16 + off.dx;
        const ly = by + (dy / len) * 16 + off.dy;
        const isSel = !!p.name && selectedLabel === p.name;
        const boxW = 10 * scale, boxH = 7 * scale;
        return (
          <g key={`b${i}`}>
            <circle cx={bx} cy={by} r={2.8} fill="white" stroke="black" strokeWidth={1.1} />
            <text
              x={lx} y={ly + 3}
              textAnchor="middle"
              fontSize={fs}
              fontWeight="bold"
              fill={isSel ? "#dc2626" : "#000"}
              style={{ cursor: p.name ? (isSel ? "move" : "pointer") : "default" }}
              onClick={(e) => { e.stopPropagation(); if (p.name) onLabelClick?.(p.name, e); }}
              onPointerDown={(e) => { if (isSel && p.name) { e.stopPropagation(); onLabelPointerDown?.(p.name, e); } }}
              onPointerMove={(e) => { if (p.name) onLabelPointerMove?.(p.name, e); }}
              onPointerUp={(e) => { if (p.name) onLabelPointerUp?.(p.name, e); }}
            >
              {p.name}
            </text>
            {isSel && (
              <>
                <rect
                  x={lx - boxW} y={ly - boxH} width={boxW * 2} height={boxH * 2}
                  fill="none" stroke="#dc2626" strokeWidth={0.8} strokeDasharray="2 2"
                  style={{ pointerEvents: "none" }}
                />
                {/* Resize handles (client req 2026-08-26: "I want to be able
                    to move and resize text") — small +/- buttons next to the
                    selection box, since a drag-handle would be hard to grab
                    reliably on text this small. */}
                <g style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); if (p.name) onLabelResize?.(p.name, 0.1); }}>
                  <circle cx={lx + boxW + 8} cy={ly - 6} r={6} fill="white" stroke="#dc2626" strokeWidth={1} />
                  <text x={lx + boxW + 8} y={ly - 3} textAnchor="middle" fontSize={9} fill="#dc2626">+</text>
                </g>
                <g style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); if (p.name) onLabelResize?.(p.name, -0.1); }}>
                  <circle cx={lx + boxW + 8} cy={ly + 8} r={6} fill="white" stroke="#dc2626" strokeWidth={1} />
                  <text x={lx + boxW + 8} y={ly + 11} textAnchor="middle" fontSize={9} fill="#dc2626">−</text>
                </g>
              </>
            )}
          </g>
        );
      })}

      {/* ---------- Manual extension lines + text notes from Diagrams (read-only) ---------- */}
      {(manualAnnotations ?? []).map((a) => (
        <line
          key={a.id}
          x1={toX(a.e1)} y1={toY(a.n1)} x2={toX(a.e2)} y2={toY(a.n2)}
          stroke="black" strokeWidth={1} strokeDasharray="6 4"
        />
      ))}
      {(manualTexts ?? []).map((t) => {
        const x = toX(t.east), y = toY(t.north);
        return (
          <text
            key={t.id}
            x={x} y={y}
            fontSize={10}
            transform={t.angle ? `rotate(${t.angle} ${x} ${y})` : undefined}
          >
            {t.text}
          </text>
        );
      })}

      {/* ---------- Note under figure ---------- */}
      <text x={VB_W / 2} y={draw.y + draw.h + 50} textAnchor="middle" fontSize={9.5} fill="#111">
        All beacons observed from {meta.observedFrom} and checked from {meta.checkedFrom}
      </text>

      {/* ---------- Bottom-left: station description + inset ---------- */}
      <g fontSize={8.5}>
        <text x={26} y={descTop} fontSize={10} fontWeight="bold" textDecoration="underline">
          STATION DESCRIPTION
        </text>
        <text x={26} y={descTop + 16} fontWeight="bold">REFERENCE MARKS</text>
        <text x={26} y={descTop + 28}>{meta.referenceMarkDescription}</text>
        <text x={26} y={descTop + 44} fontWeight="bold">WORKING STATION</text>
        <text x={26} y={descTop + 56}>{meta.workingStationDescription}</text>
      </g>

      {/* ---------- Right column: beacon description (left-aligned, like the template) ---------- */}
      <g fontSize={8.5}>
        <text x={340} y={descTop} fontSize={10} fontWeight="bold" textDecoration="underline">
          BEACON DESCRIPTION
        </text>
        <text x={340} y={descTop + 16} fontWeight="bold">PLACED BEACONS</text>
        <text x={340} y={descTop + 28}>{meta.placedBeaconDescription}</text>
        <text x={340} y={descTop + 44} fontSize={8}>System {meta.coordinateSystem}</text>
      </g>

      {/* ---------- Inset locality box (green border, not to scale) ---------- */}
      <g>
        <rect x={inset.x} y={inset.y} width={inset.w} height={inset.h} fill="white" stroke={INSET_GREEN} strokeWidth={1.2} />
        <text x={inset.x + inset.w / 2} y={inset.y - 4} textAnchor="middle" fontSize={7.5} fill={INSET_GREEN}>
          INSET NOT TO SCALE
        </text>
        <polygon points={insetPoly} fill="none" stroke="black" strokeWidth={1} strokeLinejoin="round" />
        {refDots.map((d, i) => (
          <g key={`rm${i}`}>
            <circle cx={d.x} cy={d.y} r={2.2} fill={REF_RED} />
            <text x={d.x + 5} y={d.y + 3} fontSize={7} fill={REF_RED}>{d.label}</text>
          </g>
        ))}
      </g>

      {/* ---------- Certification box (bottom-right) ---------- */}
      <g fontSize={8} fill="#000">
        <rect x={cert.x} y={cert.y} width={cert.w} height={cert.h} fill="white" stroke="black" strokeWidth={0.7} />
        <text x={cert.x + 8} y={cert.y + 15}>Surveyed by me in accordance</text>
        <text x={cert.x + 8} y={cert.y + 26}>with the provisions of the Land</text>
        <text x={cert.x + 8} y={cert.y + 37}>Survey Act and the regulations</text>
        <text x={cert.x + 8} y={cert.y + 48}>framed thereunder.</text>
        <text x={cert.x + 8} y={cert.y + 72}>Date of survey:</text>
        <text x={cert.x + 70} y={cert.y + 72}>{meta.dateOfSurvey || ""}</text>
        <line x1={cert.x + 70} y1={cert.y + 74} x2={cert.x + cert.w - 12} y2={cert.y + 74} stroke="black" strokeWidth={0.4} />
        <text x={cert.x + 8} y={cert.y + 92}>Land Surveyor:</text>
        <text x={cert.x + cert.w - 12} y={cert.y + 92} textAnchor="end" fontWeight="bold">{meta.surveyor || ""}</text>
      </g>
    </svg>
  );
});
