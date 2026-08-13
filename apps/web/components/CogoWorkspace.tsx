"use client";

// Cadastral work station (client req 2026-08-12): a window where all COGO
// calculations are conducted. Clicking the "COGO" button activates the
// workspace — imported points are plotted by name, each COGO tool is
// represented by an icon, and the cursor's world coordinates track live in
// the status bar, mirroring the reference CAD tool screenshots the client
// provided. A second toolbar row adds basic drafting (add/delete point,
// undo/redo, zoom-extents) so the canvas isn't view-only.

import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type WheelEvent as RWheelEvent } from "react";
import type { ToolId } from "@/components/CogoTools";
import { CogoDrawingToolbar } from "@/components/CogoDrawingToolbar";
import type { WLine, WPoint } from "@/lib/cogoTools/types";

const W = 720;
const H = 460;
const CLICK_SLOP_PX = 4; // pointerdown→up movement under this = a click, not a pan

type DraftTool = "select" | "addpoint";

const COGO_TOOLS: { id: ToolId; label: string; icon: (c: string) => JSX.Element }[] = [
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
  const pan = useRef<{ vbx: number; vby: number; cx: number; cy: number; moved: number } | null>(null);
  const framedCount = useRef(0);

  // Imported points, keyed so drafting edits (delete) can hide one without
  // mutating the source import.
  const basePoints: WPoint[] = points.map((p, i) => ({
    id: `imp-${i}`,
    name: p.name ?? `P${i + 1}`,
    east: p.east,
    north: p.north,
  }));

  // ---- drafting state: points/lines added/removed in the workspace only ----
  const [draftTool, setDraftTool] = useState<DraftTool>("select");
  const [extra, setExtra] = useState<WPoint[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [lines, setLines] = useState<WLine[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const idRef = useRef(1);
  const lineIdRef = useRef(1);
  const past = useRef<{ extra: WPoint[]; hidden: Set<string>; lines: WLine[] }[]>([]);
  const future = useRef<{ extra: WPoint[]; hidden: Set<string>; lines: WLine[] }[]>([]);
  const [, setHistVer] = useState(0);

  const visible = [...basePoints.filter((p) => !hidden.has(p.id)), ...extra];

  function snapshot() {
    past.current.push({ extra, hidden: new Set(hidden), lines });
    if (past.current.length > 100) past.current.shift();
    future.current = [];
    setHistVer((v) => v + 1);
  }
  function undo() {
    if (!past.current.length) return;
    future.current.push({ extra, hidden: new Set(hidden), lines });
    const prev = past.current.pop()!;
    setExtra(prev.extra);
    setHidden(prev.hidden);
    setLines(prev.lines);
    setSelected(null);
    setHistVer((v) => v + 1);
  }
  function redo() {
    if (!future.current.length) return;
    past.current.push({ extra, hidden: new Set(hidden), lines });
    const next = future.current.pop()!;
    setExtra(next.extra);
    setHidden(next.hidden);
    setLines(next.lines);
    setSelected(null);
    setHistVer((v) => v + 1);
  }
  function deleteSelected() {
    if (!selected) return;
    snapshot();
    if (selected.startsWith("imp-")) setHidden((h) => new Set(h).add(selected));
    else setExtra((e) => e.filter((p) => p.id !== selected));
    setSelected(null);
  }
  function zoomExtents() {
    const linePts: WPoint[] = lines.flatMap((l) => [
      { id: `${l.id}-a`, name: "", east: l.aE, north: l.aN },
      { id: `${l.id}-b`, name: "", east: l.bE, north: l.bN },
    ]);
    frameOn([...visible, ...linePts]);
  }

  function frameOn(pts: WPoint[]) {
    if (!pts.length) return;
    const es = pts.map((p) => p.east), ns = pts.map((p) => p.north);
    const cx = (Math.min(...es) + Math.max(...es)) / 2;
    const cy = (Math.min(...ns) + Math.max(...ns)) / 2;
    const span = Math.max(Math.max(...es) - Math.min(...es), Math.max(...ns) - Math.min(...ns), 1);
    const zoom = (Math.min(W, H) * 0.7) / span;
    if (Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(zoom) && zoom > 0) setView({ cx, cy, zoom });
  }

  function addToolResult(result: { points?: { name: string; east: number; north: number }[]; lines?: { name?: string; aE: number; aN: number; bE: number; bN: number }[] }) {
    snapshot();
    if (result.points?.length) {
      setExtra((e) => [...e, ...result.points!.map((p, i) => ({ id: `tool-${Date.now()}-${idRef.current + i}`, ...p }))]);
      idRef.current += result.points.length;
    }
    if (result.lines?.length) {
      setLines((ls) => [...ls, ...result.lines!.map((l, i) => ({ id: `line-${Date.now()}-${lineIdRef.current + i}`, ...l }))]);
      lineIdRef.current += result.lines.length;
    }
  }

  // Auto-frame the imported points whenever the point set changes size (e.g. a
  // fresh import) so newly loaded beacons are visible without manual panning.
  useEffect(() => {
    if (!basePoints.length || basePoints.length === framedCount.current) return;
    framedCount.current = basePoints.length;
    frameOn(basePoints);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  function nearestVisible(sx: number, sy: number): WPoint | null {
    let best: WPoint | null = null;
    let bestD = 12 * 12;
    for (const p of visible) {
      const [x, y] = toScreen(p.east, p.north);
      const d = (x - sx) ** 2 + (y - sy) ** 2;
      if (d <= bestD) { bestD = d; best = p; }
    }
    return best;
  }

  function onPointerMove(ev: RPointerEvent<SVGSVGElement>) {
    const [vbx, vby] = eventToVb(ev);
    const [e, n] = toWorld(vbx, vby);
    setCursor({ e, n });
    if (pan.current) {
      const dx = (vbx - pan.current.vbx) / view.zoom;
      const dy = (vby - pan.current.vby) / view.zoom;
      pan.current.moved += Math.abs(vbx - pan.current.vbx) + Math.abs(vby - pan.current.vby);
      setView((v) => ({ ...v, cx: pan.current!.cx - dx, cy: pan.current!.cy + dy }));
    }
  }
  function onPointerDown(ev: RPointerEvent<SVGSVGElement>) {
    svgRef.current?.setPointerCapture(ev.pointerId);
    const [vbx, vby] = eventToVb(ev);
    pan.current = { vbx, vby, cx: view.cx, cy: view.cy, moved: 0 };
  }
  function onPointerUp(ev: RPointerEvent<SVGSVGElement>) {
    const wasClick = !!pan.current && pan.current.moved < CLICK_SLOP_PX;
    if (wasClick) {
      const [vbx, vby] = eventToVb(ev);
      if (draftTool === "addpoint") {
        const [wx, wy] = toWorld(vbx, vby);
        const name = window.prompt("Point name", `New${idRef.current}`) ?? `New${idRef.current}`;
        idRef.current += 1;
        snapshot();
        setExtra((e) => [...e, { id: `new-${Date.now()}-${idRef.current}`, name, east: wx, north: wy }]);
      } else {
        const hit = nearestVisible(vbx, vby);
        setSelected(hit?.id ?? null);
      }
    }
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
        {active && (
          <span className="text-xs text-slate-400">
            Work station active — {visible.length} point(s){lines.length > 0 ? `, ${lines.length} line(s)` : ""}
          </span>
        )}
      </div>

      {active && (
        <>
          {/* Row 1 — COGO calculation tools */}
          <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 bg-slate-50 px-2 py-1.5">
            {COGO_TOOLS.map((t) => (
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

          {/* Row 2 — drafting basics on the plotted points */}
          <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 bg-slate-50 px-2 py-1.5">
            <DraftButton
              active={draftTool === "select"}
              label="Select / move"
              onClick={() => setDraftTool("select")}
              icon={iconSelect}
            />
            <DraftButton
              active={draftTool === "addpoint"}
              label="Add point"
              onClick={() => setDraftTool("addpoint")}
              icon={iconAddPoint}
            />
            <DraftButton label="Delete selected point" onClick={deleteSelected} disabled={!selected} icon={iconDelete} />
            <div className="mx-1 h-5 w-px bg-slate-200" />
            <DraftButton label="Undo" onClick={undo} disabled={!past.current.length} icon={iconUndo} />
            <DraftButton label="Redo" onClick={redo} disabled={!future.current.length} icon={iconRedo} />
            <div className="mx-1 h-5 w-px bg-slate-200" />
            <DraftButton label="Zoom to extents" onClick={zoomExtents} icon={iconZoomExtents} />
          </div>

          {/* Row 3 — registry-driven COGO point-construction tools */}
          <CogoDrawingToolbar points={visible} lines={lines} category="point" onResult={addToolResult} />

          {/* Row 4 — registry-driven COGO line-construction tools */}
          <CogoDrawingToolbar points={visible} lines={lines} category="line" onResult={addToolResult} />

          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="w-full touch-none bg-slate-50"
            style={{ cursor: draftTool === "addpoint" ? "crosshair" : pan.current ? "grabbing" : "default" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => (pan.current = null)}
            onWheel={onWheel}
          >
            {lines.map((l) => {
              const [x1, y1] = toScreen(l.aE, l.aN);
              const [x2, y2] = toScreen(l.bE, l.bN);
              return <line key={l.id} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#2563eb" strokeWidth={1.6} />;
            })}
            {visible.length === 0 && lines.length === 0 ? (
              <text x={W / 2} y={H / 2} textAnchor="middle" className="fill-slate-400 text-sm">
                Import points, or use "Add point" to place one here
              </text>
            ) : (
              visible.map((p) => {
                const [x, y] = toScreen(p.east, p.north);
                const isSel = p.id === selected;
                return (
                  <g key={p.id}>
                    <circle cx={x} cy={y} r={isSel ? 6 : 4} fill={isSel ? "#dc2626" : "#059669"} />
                    <text x={x + 7} y={y - 6} className="fill-slate-700 text-[11px] font-medium">
                      {p.name}
                    </text>
                  </g>
                );
              })
            )}
          </svg>

          <div className="flex items-center justify-between border-t border-slate-200 px-3 py-1.5 text-xs text-slate-500">
            <span>
              {draftTool === "addpoint" ? "Click to place a point" : "Click a point to select · Drag to pan · Scroll to zoom"}
            </span>
            <span className="font-mono">
              Y = {cursor ? cursor.e.toFixed(3) : "—"}&nbsp;&nbsp;X = {cursor ? cursor.n.toFixed(3) : "—"}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function DraftButton({
  label,
  onClick,
  icon,
  active,
  disabled,
}: {
  label: string;
  onClick: () => void;
  icon: (c: string) => JSX.Element;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`grid h-9 w-9 place-items-center rounded-md transition disabled:cursor-not-allowed disabled:opacity-30 ${
        active ? "bg-brand text-white" : "text-slate-600 hover:bg-white hover:text-brand-dark hover:shadow-sm"
      }`}
    >
      {icon("currentColor")}
    </button>
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
function iconSelect(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M5 3l6 16 2.2-6.8L20 10 5 3z" fill={c} fillOpacity="0.12" strokeLinejoin="round" />
    </svg>
  );
}
function iconAddPoint(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <circle cx="12" cy="12" r="2.4" fill={c} stroke="none" />
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
    </svg>
  );
}
function iconDelete(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M5 6h14M9 6V4h6v2M7 6l1 14h8l1-14" strokeLinejoin="round" />
    </svg>
  );
}
function iconUndo(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M7 8H4V5" />
      <path d="M4 8c2-3 5-4.5 8.5-4.5A8.5 8.5 0 1 1 4.6 15" strokeLinecap="round" />
    </svg>
  );
}
function iconRedo(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M17 8h3V5" />
      <path d="M20 8c-2-3-5-4.5-8.5-4.5A8.5 8.5 0 1 0 19.4 15" strokeLinecap="round" />
    </svg>
  );
}
function iconZoomExtents(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="1.6" fill={c} stroke="none" />
    </svg>
  );
}
