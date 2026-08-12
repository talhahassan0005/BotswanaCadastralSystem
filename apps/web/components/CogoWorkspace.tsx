"use client";

// Cadastral work station (client req 2026-08-12): a window where all COGO
// calculations are conducted. Clicking the "COGO" button activates the
// workspace — imported points are plotted by name, each COGO tool is
// represented by an icon, and the cursor's world coordinates track live in
// the status bar, mirroring the reference CAD tool screenshots the client
// provided.

import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type WheelEvent as RWheelEvent } from "react";
import type { ToolId } from "@/components/CogoTools";

const W = 720;
const H = 460;

const TOOLS: { id: ToolId; label: string; icon: (c: string) => JSX.Element }[] = [
  { id: "inverse", label: "Forward / Inverse", icon: iconInverse },
  { id: "intersection", label: "Intersection", icon: iconIntersection },
  { id: "curve", label: "Curve", icon: iconCurve },
  { id: "area", label: "Area", icon: iconArea },
  { id: "transform", label: "Transform", icon: iconTransform },
];

export function CogoWorkspace({
  points,
  onTool,
}: {
  points: { name?: string | null; east: number; north: number }[];
  onTool: (id: ToolId) => void;
}) {
  const [active, setActive] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ cx: 0, cy: 0, zoom: 1 });
  const [cursor, setCursor] = useState<{ e: number; n: number } | null>(null);
  const pan = useRef<{ vbx: number; vby: number; cx: number; cy: number } | null>(null);
  const framedCount = useRef(0);

  // Auto-frame the imported points whenever the point set changes size (e.g. a
  // fresh import) so newly loaded beacons are visible without manual panning.
  useEffect(() => {
    if (!points.length || points.length === framedCount.current) return;
    framedCount.current = points.length;
    const es = points.map((p) => p.east), ns = points.map((p) => p.north);
    const cx = (Math.min(...es) + Math.max(...es)) / 2;
    const cy = (Math.min(...ns) + Math.max(...ns)) / 2;
    const span = Math.max(Math.max(...es) - Math.min(...es), Math.max(...ns) - Math.min(...ns), 1);
    const zoom = (Math.min(W, H) * 0.7) / span;
    if (Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(zoom) && zoom > 0) setView({ cx, cy, zoom });
  }, [points]);

  const toScreen = (e: number, n: number): [number, number] => [
    (e - view.cx) * view.zoom + W / 2,
    H / 2 - (n - view.cy) * view.zoom,
  ];
  const toWorld = (sx: number, sy: number): [number, number] => [
    view.cx + (sx - W / 2) / view.zoom,
    view.cy - (sy - H / 2) / view.zoom,
  ];
  function eventToVb(ev: RPointerEvent | RWheelEvent): [number, number] {
    const r = svgRef.current!.getBoundingClientRect();
    return [((ev.clientX - r.left) / r.width) * W, ((ev.clientY - r.top) / r.height) * H];
  }

  function onPointerMove(ev: RPointerEvent<SVGSVGElement>) {
    const [vbx, vby] = eventToVb(ev);
    const [e, n] = toWorld(vbx, vby);
    setCursor({ e, n });
    if (pan.current) {
      const dx = (vbx - pan.current.vbx) / view.zoom;
      const dy = (vby - pan.current.vby) / view.zoom;
      setView((v) => ({ ...v, cx: pan.current!.cx - dx, cy: pan.current!.cy + dy }));
    }
  }
  function onPointerDown(ev: RPointerEvent<SVGSVGElement>) {
    svgRef.current?.setPointerCapture(ev.pointerId);
    const [vbx, vby] = eventToVb(ev);
    pan.current = { vbx, vby, cx: view.cx, cy: view.cy };
  }
  function onPointerUp() {
    pan.current = null;
  }
  function onWheel(ev: RWheelEvent<SVGSVGElement>) {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
    setView((v) => ({ ...v, zoom: Math.min(50, Math.max(0.01, v.zoom * factor)) }));
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
        <button
          type="button"
          onClick={() => setActive((v) => !v)}
          title="Activate the COGO work station"
          className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
            active ? "bg-brand text-white" : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
          }`}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
            <circle cx="5" cy="6" r="1.6" fill="currentColor" stroke="none" />
            <circle cx="19" cy="6" r="1.6" fill="currentColor" stroke="none" />
            <circle cx="5" cy="18" r="1.6" fill="currentColor" stroke="none" />
            <circle cx="19" cy="18" r="1.6" fill="currentColor" stroke="none" />
            <path d="M12 12L5 6M12 12L19 6M12 12L5 18M12 12L19 18" />
          </svg>
          COGO
        </button>
        {active && <span className="text-xs text-slate-400">Work station active — {points.length} point(s) loaded</span>}
      </div>

      {active && (
        <>
          <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 bg-slate-50 px-2 py-1.5">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onTool(t.id)}
                title={t.label}
                aria-label={t.label}
                className="grid h-9 w-9 place-items-center rounded-md text-slate-600 hover:bg-white hover:text-brand-dark hover:shadow-sm"
              >
                {t.icon("currentColor")}
              </button>
            ))}
          </div>

          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="w-full touch-none bg-slate-50"
            style={{ cursor: pan.current ? "grabbing" : "crosshair" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            onWheel={onWheel}
          >
            {points.length === 0 ? (
              <text x={W / 2} y={H / 2} textAnchor="middle" className="fill-slate-400 text-sm">
                Import points to see them plotted here
              </text>
            ) : (
              points.map((p, i) => {
                const [x, y] = toScreen(p.east, p.north);
                return (
                  <g key={p.name ?? i}>
                    <circle cx={x} cy={y} r={4} fill="#059669" />
                    <text x={x + 7} y={y - 6} className="fill-slate-700 text-[11px] font-medium">
                      {p.name ?? `P${i + 1}`}
                    </text>
                  </g>
                );
              })
            )}
          </svg>

          <div className="flex items-center justify-between border-t border-slate-200 px-3 py-1.5 text-xs text-slate-500">
            <span>Drag to pan · Scroll to zoom</span>
            <span className="font-mono">
              Y = {cursor ? cursor.e.toFixed(3) : "—"}&nbsp;&nbsp;X = {cursor ? cursor.n.toFixed(3) : "—"}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function iconInverse(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <circle cx="5" cy="19" r="1.8" />
      <circle cx="19" cy="5" r="1.8" />
      <path d="M6.3 17.7L17.7 6.3" strokeDasharray="2.5 2.5" />
    </svg>
  );
}
function iconIntersection(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M4 4l16 16M20 4L4 20" />
      <circle cx="12" cy="12" r="2.2" fill={c} stroke="none" />
    </svg>
  );
}
function iconCurve(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M4 18C4 9 9 4 18 4" />
      <circle cx="4" cy="18" r="1.6" fill={c} stroke="none" />
      <circle cx="18" cy="4" r="1.6" fill={c} stroke="none" />
    </svg>
  );
}
function iconArea(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M4 6l8-2 8 3-3 11-11 1z" fill={c} fillOpacity="0.12" />
    </svg>
  );
}
function iconTransform(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M4 8h11M15 8l-3-3M15 8l-3 3" />
      <path d="M20 16H9M9 16l3-3M9 16l3 3" />
    </svg>
  );
}
