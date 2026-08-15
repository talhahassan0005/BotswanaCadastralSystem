"use client";

// Cadastral work station (client req 2026-08-12): a window where all COGO
// calculations are conducted. Clicking the "COGO" button activates the
// workspace — imported points are plotted by name, each COGO tool is
// represented by an icon, and the cursor's world coordinates track live in
// the status bar, mirroring the reference CAD tool screenshots the client
// provided. A second toolbar row adds basic drafting (add/delete point,
// undo/redo, zoom-extents) so the canvas isn't view-only.

import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode, type WheelEvent as RWheelEvent } from "react";
import type { ToolId } from "@/components/CogoTools";
import { CogoDrawingToolbar } from "@/components/CogoDrawingToolbar";
import { CogoCommandBar, type CogoCommandBarHandle } from "@/components/CogoCommandBar";
import { inverse } from "@/lib/server/geometry";
import { formatDms } from "@/lib/server/angles";
import * as curveMath from "@/lib/cogoTools/curveTools";
import * as lineMath from "@/lib/cogoTools/lineTools";
import type { ToolDef, ToolResult, WArc, WLine, WPoint, WPolygon, WText } from "@/lib/cogoTools/types";

const W = 720;
const H = 460;
const CLICK_SLOP_PX = 4; // pointerdown→up movement under this = a click, not a pan

// "select"/"addpoint"/"move" are single-click canvas modes (Row 2). The rest
// are click-to-draw tools (client req 2026-08-14): clicking their toolbar
// icon (Rows 3-6) activates the mode below instead of opening a modal; the
// user then clicks points directly on the canvas, like a CAD tool.
type DraftTool = "select" | "addpoint" | "move" | "line" | "polyline" | "curve" | "polygon" | "offset";
type DraftPt = { east: number; north: number; name: string; newId?: string };

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
  const [moving, setMoving] = useState<string | null>(null); // point picked up by the Move tool, awaiting drop
  const [snapEnabled, setSnapEnabled] = useState(false);
  // ---- click-to-draw state (Line/Polyline/Curve/Polygon/Offset) ----
  const [draft, setDraft] = useState<DraftPt[]>([]); // vertices placed so far for the active draw tool
  const [rename, setRename] = useState<{ east: number; north: number; value: string; targetId: string } | null>(null); // inline name field for a freshly-placed single point
  const [offsetLineId, setOffsetLineId] = useState<string | null>(null); // source line picked for the Offset tool
  const [offsetInput, setOffsetInput] = useState<{ screenX: number; screenY: number; side: 1 | -1; value: string } | null>(null);
  const draftIdRef = useRef(1);
  // ---- bottom-docked command bar for numeric-input tools (Part 5) ----
  const [formTool, setFormTool] = useState<ToolDef | null>(null);
  const commandBarRef = useRef<CogoCommandBarHandle>(null);
  const [lines, setLines] = useState<WLine[]>([]);
  const [arcs, setArcs] = useState<WArc[]>([]);
  const [polygons, setPolygons] = useState<WPolygon[]>([]);
  const [texts, setTexts] = useState<WText[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const idRef = useRef(1);
  const lineIdRef = useRef(1);
  const arcIdRef = useRef(1);
  const polyIdRef = useRef(1);
  const textIdRef = useRef(1);
  type HistEntry = { extra: WPoint[]; hidden: Set<string>; lines: WLine[]; arcs: WArc[]; polygons: WPolygon[]; texts: WText[] };
  const past = useRef<HistEntry[]>([]);
  const future = useRef<HistEntry[]>([]);
  const [, setHistVer] = useState(0);

  const visible = [...basePoints.filter((p) => !hidden.has(p.id)), ...extra];

  function snapshot() {
    past.current.push({ extra, hidden: new Set(hidden), lines, arcs, polygons, texts });
    if (past.current.length > 100) past.current.shift();
    future.current = [];
    setHistVer((v) => v + 1);
  }
  function undo() {
    if (!past.current.length) return;
    future.current.push({ extra, hidden: new Set(hidden), lines, arcs, polygons, texts });
    const prev = past.current.pop()!;
    setExtra(prev.extra);
    setHidden(prev.hidden);
    setLines(prev.lines);
    setArcs(prev.arcs);
    setPolygons(prev.polygons);
    setTexts(prev.texts);
    setSelected(null);
    setHistVer((v) => v + 1);
  }
  function redo() {
    if (!future.current.length) return;
    past.current.push({ extra, hidden: new Set(hidden), lines, arcs, polygons, texts });
    const next = future.current.pop()!;
    setExtra(next.extra);
    setHidden(next.hidden);
    setLines(next.lines);
    setArcs(next.arcs);
    setPolygons(next.polygons);
    setTexts(next.texts);
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
    // Frame each arc's bounding box corners (centre ± radius), not just its endpoints.
    const arcPts: WPoint[] = arcs.flatMap((a) => [
      { id: `${a.id}-n`, name: "", east: a.cE, north: a.cN + a.radius },
      { id: `${a.id}-s`, name: "", east: a.cE, north: a.cN - a.radius },
      { id: `${a.id}-e`, name: "", east: a.cE + a.radius, north: a.cN },
      { id: `${a.id}-w`, name: "", east: a.cE - a.radius, north: a.cN },
    ]);
    const polyPts: WPoint[] = polygons.flatMap((p) => p.points.map((v, i) => ({ id: `${p.id}-${i}`, name: "", east: v.east, north: v.north })));
    const textPts: WPoint[] = texts.map((t) => ({ id: t.id, name: "", east: t.east, north: t.north }));
    frameOn([...visible, ...linePts, ...arcPts, ...polyPts, ...textPts]);
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

  function addToolResult(result: ToolResult) {
    snapshot();
    if (result.replaceLineIds?.length) {
      const drop = new Set(result.replaceLineIds);
      setLines((ls) => ls.filter((l) => !drop.has(l.id)));
    }
    if (result.replacePolygonIds?.length) {
      const drop = new Set(result.replacePolygonIds);
      setPolygons((ps) => ps.filter((p) => !drop.has(p.id)));
    }
    if (result.points?.length) {
      setExtra((e) => [...e, ...result.points!.map((p, i) => ({ id: `tool-${Date.now()}-${idRef.current + i}`, ...p }))]);
      idRef.current += result.points.length;
    }
    if (result.lines?.length) {
      setLines((ls) => [...ls, ...result.lines!.map((l, i) => ({ id: `line-${Date.now()}-${lineIdRef.current + i}`, ...l }))]);
      lineIdRef.current += result.lines.length;
    }
    if (result.arcs?.length) {
      setArcs((as) => [...as, ...result.arcs!.map((a, i) => ({ id: `arc-${Date.now()}-${arcIdRef.current + i}`, ...a }))]);
      arcIdRef.current += result.arcs.length;
    }
    if (result.polygons?.length) {
      setPolygons((ps) => [...ps, ...result.polygons!.map((p, i) => ({ id: `poly-${Date.now()}-${polyIdRef.current + i}`, ...p }))]);
      polyIdRef.current += result.polygons.length;
    }
    if (result.texts?.length) {
      setTexts((ts) => [
        ...ts,
        ...result.texts!.map((t, i) => ({ ...t, id: `text-${Date.now()}-${textIdRef.current + i}`, size: t.size ?? 12 })),
      ]);
      textIdRef.current += result.texts.length;
    }
  }

  // ---- click-to-draw: each click either snaps onto an existing point or
  // plots a new auto-named one immediately (so the user sees it appear).
  // Returns the vertex descriptor; the caller decides whether to append it
  // to `draft` (multi-click shapes) or finish immediately (fixed-count ones) —
  // finishing needs the vertex list as a plain argument, not the (stale,
  // not-yet-re-rendered) `draft` state, since React state updates aren't
  // synchronous within the same event handler. ----
  function addVertexPoint(v: { east: number; north: number; existingId?: string }): DraftPt {
    if (v.existingId) {
      const existing = visible.find((p) => p.id === v.existingId);
      return { east: v.east, north: v.north, name: existing?.name ?? "?" };
    }
    const name = `T${draftIdRef.current}`;
    const newId = `draft-${Date.now()}-${draftIdRef.current}`;
    draftIdRef.current += 1;
    snapshot();
    setExtra((e) => [...e, { id: newId, name, east: v.east, north: v.north }]);
    return { east: v.east, north: v.north, name, newId };
  }
  /** Ctrl+Z while drawing: remove only the last placed vertex (and the point
   *  marker it created, if it wasn't an existing point) — not a full undo. */
  function removeLastDraftVertex() {
    setDraft((d) => {
      if (!d.length) return d;
      const last = d[d.length - 1];
      if (last.newId) setExtra((e) => e.filter((p) => p.id !== last.newId));
      return d.slice(0, -1);
    });
  }
  function cancelDraft() {
    const newIds = new Set(draft.filter((d) => d.newId).map((d) => d.newId!));
    if (newIds.size) setExtra((e) => e.filter((p) => !newIds.has(p.id)));
    setDraft([]);
    setDraftTool("select");
    setOffsetLineId(null);
    setOffsetInput(null);
  }
  /** Switch to a different canvas mode, discarding any in-progress draft from
   *  whichever tool was active before (so switching tools mid-shape can't
   *  leave orphaned draft vertices behind). */
  function activateDrawTool(tool: DraftTool) {
    const newIds = new Set(draft.filter((d) => d.newId).map((d) => d.newId!));
    if (newIds.size) setExtra((e) => e.filter((p) => !newIds.has(p.id)));
    setDraft([]);
    setOffsetLineId(null);
    setOffsetInput(null);
    setMoving(null);
    setRename(null);
    setFormTool(null);
    setDraftTool(tool);
  }
  /** Open the command bar for a numeric-input tool, discarding any
   *  in-progress click-to-draw shape first (only one mode at a time). */
  function openFormTool(tool: ToolDef) {
    activateDrawTool("select");
    setFormTool(tool);
  }
  function finishDraftWith(rawPts: DraftPt[]) {
    // A double-click's second click can land on (and snap to) the vertex the
    // first click just placed — drop that back-to-back duplicate.
    const pts = rawPts.filter((p, i) => i === 0 || Math.hypot(p.east - rawPts[i - 1].east, p.north - rawPts[i - 1].north) > 1e-6);
    if (draftTool === "line" && pts.length >= 2) {
      addToolResult({ lines: [{ aE: pts[0].east, aN: pts[0].north, bE: pts[1].east, bN: pts[1].north }] });
    } else if (draftTool === "polyline" && pts.length >= 2) {
      const segs: NonNullable<ToolResult["lines"]> = [];
      for (let i = 0; i < pts.length - 1; i++) segs.push({ aE: pts[i].east, aN: pts[i].north, bE: pts[i + 1].east, bN: pts[i + 1].north });
      addToolResult({ lines: segs });
    } else if (draftTool === "polygon" && pts.length >= 3) {
      const segs: NonNullable<ToolResult["lines"]> = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        segs.push({ aE: a.east, aN: a.north, bE: b.east, bN: b.north });
      }
      addToolResult({ lines: segs, polygons: [{ points: pts.map((p) => ({ name: p.name, east: p.east, north: p.north })) }] });
    } else if (draftTool === "curve" && pts.length >= 3) {
      // Click order: start, end, a point on the arc between them.
      try {
        const result = curveMath.arcBy3Points({
          pointA: { id: "a", name: "A", east: pts[0].east, north: pts[0].north },
          pointB: { id: "m", name: "M", east: pts[2].east, north: pts[2].north },
          pointC: { id: "b", name: "B", east: pts[1].east, north: pts[1].north },
        });
        addToolResult(result);
      } catch (e: any) {
        window.alert(e.message ?? String(e));
      }
    }
    setDraft([]);
    setDraftTool("select");
  }
  function finishDraft() {
    finishDraftWith(draft);
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

  const SNAP_PX = 10;
  /** Nearest existing point within snap radius (screen space), if any. Point
   *  snapping is always on while drawing — needed to close traverses/
   *  polygons cleanly onto an existing vertex. */
  function snapPoint(sx: number, sy: number): WPoint | null {
    let best: WPoint | null = null;
    let bestD = SNAP_PX * SNAP_PX;
    for (const p of visible) {
      const [x, y] = toScreen(p.east, p.north);
      const d = (x - sx) ** 2 + (y - sy) ** 2;
      if (d <= bestD) { bestD = d; best = p; }
    }
    return best;
  }
  /** Resolve a screen click to a world vertex: snap to an existing point first
   *  (always on); else, if the Snap toggle is on, snap to the nearest line or
   *  the metre grid; else the raw click position. Reports the existing
   *  point's id when one was hit, so callers can avoid plotting a duplicate. */
  function resolveVertex(sx: number, sy: number): { east: number; north: number; existingId?: string } {
    const p = snapPoint(sx, sy);
    if (p) return { east: p.east, north: p.north, existingId: p.id };
    const [wx, wy] = toWorld(sx, sy);
    if (!snapEnabled) return { east: wx, north: wy };
    for (const l of lines) {
      const [x1, y1] = toScreen(l.aE, l.aN);
      const [x2, y2] = toScreen(l.bE, l.bN);
      const dx = x2 - x1, dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? ((sx - x1) * dx + (sy - y1) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = x1 + t * dx, py = y1 + t * dy;
      if ((px - sx) ** 2 + (py - sy) ** 2 <= SNAP_PX * SNAP_PX) {
        const [gwx, gwy] = toWorld(px, py);
        return { east: gwx, north: gwy };
      }
    }
    return { east: Math.round(wx), north: Math.round(wy) };
  }
  /** Same priority (point -> line -> grid), returning just world coords —
   *  used by Add Point / Move, which don't need the existingId. */
  function snapWorld(wx: number, wy: number): [number, number] {
    const [sx, sy] = toScreen(wx, wy);
    const v = resolveVertex(sx, sy);
    return [v.east, v.north];
  }
  /** Nearest line within a pixel radius (foot-of-perpendicular test) —
   *  used by the Offset tool to pick its source line by clicking it. */
  function nearestLineHit(sx: number, sy: number): WLine | null {
    let best: WLine | null = null;
    let bestD = SNAP_PX * SNAP_PX;
    for (const l of lines) {
      const [x1, y1] = toScreen(l.aE, l.aN);
      const [x2, y2] = toScreen(l.bE, l.bN);
      const dx = x2 - x1, dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? ((sx - x1) * dx + (sy - y1) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = x1 + t * dx, py = y1 + t * dy;
      const d = (px - sx) ** 2 + (py - sy) ** 2;
      if (d <= bestD) { bestD = d; best = l; }
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
  const DRAW_TOOLS: DraftTool[] = ["line", "polyline", "curve", "polygon", "offset"];

  function commitOffset(input: { screenX: number; screenY: number; side: 1 | -1; value: string }) {
    const line = lines.find((l) => l.id === offsetLineId);
    const magnitude = Math.abs(Number(input.value)) || 0;
    if (line && magnitude > 0) {
      try {
        addToolResult(lineMath.offsetLine({ line, offset: magnitude * input.side }));
      } catch (e: any) {
        window.alert(e.message ?? String(e));
      }
    }
    setOffsetLineId(null);
    setOffsetInput(null);
    setDraftTool("select");
  }

  function onPointerUp(ev: RPointerEvent<SVGSVGElement>) {
    const wasClick = !!pan.current && pan.current.moved < CLICK_SLOP_PX;
    if (wasClick) {
      const [vbx, vby] = eventToVb(ev);
      if (formTool) {
        // Command bar open (Part 5): clicking a point/line on canvas fills
        // whichever field is focused (or the first empty matching field)
        // instead of doing the normal select/pan/draw behaviour.
        const p = snapPoint(vbx, vby);
        if (p) commandBarRef.current?.pickFromCanvas("point", p.id);
        else {
          const l = nearestLineHit(vbx, vby);
          if (l) commandBarRef.current?.pickFromCanvas("line", l.id);
        }
      } else if (draftTool === "addpoint") {
        const v = resolveVertex(vbx, vby);
        if (!v.existingId) {
          const name = `New${idRef.current}`;
          const newId = `new-${Date.now()}-${idRef.current}`;
          idRef.current += 1;
          snapshot();
          setExtra((e) => [...e, { id: newId, name, east: v.east, north: v.north }]);
          setRename({ east: v.east, north: v.north, value: name, targetId: newId });
        }
      } else if (draftTool === "move") {
        if (!moving) {
          const hit = nearestVisible(vbx, vby);
          if (hit) { setMoving(hit.id); setSelected(hit.id); }
        } else {
          const [wx, wy] = snapWorld(...toWorld(vbx, vby));
          snapshot();
          if (moving.startsWith("imp-")) {
            const orig = basePoints.find((p) => p.id === moving);
            setHidden((h) => new Set(h).add(moving));
            setExtra((e) => [...e, { id: `moved-${Date.now()}`, name: orig?.name ?? "Moved", east: wx, north: wy }]);
          } else {
            setExtra((e) => e.map((p) => (p.id === moving ? { ...p, east: wx, north: wy } : p)));
          }
          setMoving(null);
          setSelected(null);
        }
      } else if (draftTool === "line" || draftTool === "curve") {
        const vertex = addVertexPoint(resolveVertex(vbx, vby));
        const nextDraft = [...draft, vertex];
        const limit = draftTool === "line" ? 2 : 3;
        if (nextDraft.length >= limit) finishDraftWith(nextDraft);
        else setDraft(nextDraft);
      } else if (draftTool === "polyline" || draftTool === "polygon") {
        const vertex = addVertexPoint(resolveVertex(vbx, vby));
        setDraft((d) => [...d, vertex]);
      } else if (draftTool === "offset") {
        if (!offsetLineId) {
          const hit = nearestLineHit(vbx, vby);
          if (hit) setOffsetLineId(hit.id);
        } else if (!offsetInput) {
          const line = lines.find((l) => l.id === offsetLineId);
          if (line) {
            const [wx, wy] = toWorld(vbx, vby);
            const dE = line.bE - line.aE, dN = line.bN - line.aN;
            const cross = (wx - line.aE) * dN - (wy - line.aN) * dE;
            setOffsetInput({ screenX: vbx, screenY: vby, side: cross > 0 ? 1 : -1, value: "" });
          }
        }
      } else {
        const hit = nearestVisible(vbx, vby);
        setSelected(hit?.id ?? null);
      }
    }
    pan.current = null;
  }
  function onDoubleClick() {
    if (draftTool === "polyline" || draftTool === "polygon") finishDraft();
  }
  function onWheel(ev: RWheelEvent<SVGSVGElement>) {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
    setView((v) => ({ ...v, zoom: Math.min(50, Math.max(0.01, v.zoom * factor)) }));
  }

  // Escape cancels an in-progress draw (or closes the command bar); Enter
  // finishes a polyline/polygon; Ctrl+Z (while drawing) removes only the
  // last placed vertex.
  useEffect(() => {
    if (!DRAW_TOOLS.includes(draftTool) && !formTool) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        if (formTool) setFormTool(null);
        else cancelDraft();
      } else if (e.key === "Enter" && (draftTool === "polyline" || draftTool === "polygon")) {
        e.preventDefault();
        finishDraft();
      } else if (e.key.toLowerCase() === "z" && (e.ctrlKey || e.metaKey) && draft.length) {
        e.preventDefault();
        removeLastDraftVertex();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftTool, draft, formTool]);

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
            Work station active — {visible.length} point(s)
            {lines.length > 0 ? `, ${lines.length} line(s)` : ""}
            {arcs.length > 0 ? `, ${arcs.length} arc(s)` : ""}
            {polygons.length > 0 ? `, ${polygons.length} polygon(s)` : ""}
            {texts.length > 0 ? `, ${texts.length} label(s)` : ""}
          </span>
        )}
      </div>

      {active && (
        <>
          {/* Row 1 — COGO calculation tools */}
          <ToolGroup label="COGO Calculators">
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
          </ToolGroup>

          {/* Row 2 — drafting basics on the plotted points */}
          <ToolGroup label="Edit Tools">
            <DraftButton
              active={draftTool === "select"}
              label="Select / move"
              onClick={() => activateDrawTool("select")}
              icon={iconSelect}
            />
            <DraftButton
              active={draftTool === "addpoint"}
              label="Add point"
              onClick={() => activateDrawTool("addpoint")}
              icon={iconAddPoint}
            />
            <DraftButton
              active={draftTool === "move"}
              label="Move point (click to pick up, click again to drop)"
              onClick={() => activateDrawTool("move")}
              icon={iconMove}
            />
            <DraftButton label="Delete selected point" onClick={deleteSelected} disabled={!selected} icon={iconDelete} />
            <div className="mx-1 h-5 w-px bg-slate-200" />
            <DraftButton label="Undo" onClick={undo} disabled={!past.current.length} icon={iconUndo} />
            <DraftButton label="Redo" onClick={redo} disabled={!future.current.length} icon={iconRedo} />
            <div className="mx-1 h-5 w-px bg-slate-200" />
            <DraftButton label="Zoom to extents (fit all)" onClick={zoomExtents} icon={iconZoomExtents} />
            <DraftButton
              active={snapEnabled}
              label="Snap to point / line / grid"
              onClick={() => setSnapEnabled((s) => !s)}
              icon={iconSnap}
            />
          </ToolGroup>

          {/* Row 3 — registry-driven COGO point-construction tools. "Add Point"
              is click-to-draw (Part 1); the rest open the command bar (Part 5). */}
          <CogoDrawingToolbar
            category="point"
            onOpenTool={openFormTool}
            interceptIds={{ "add-point": () => activateDrawTool("addpoint") }}
            activeId={draftTool === "addpoint" ? "add-point" : null}
          />

          {/* Row 4 — registry-driven COGO line-construction tools. Line,
              Polyline and Offset are click-to-draw; Bearing&Distance/Extend/
              Trim/Perpendicular open the command bar (need exact numeric input). */}
          <CogoDrawingToolbar
            category="line"
            onOpenTool={openFormTool}
            interceptIds={{
              "line-between-points": () => activateDrawTool("line"),
              "polyline-traverse": () => activateDrawTool("polyline"),
              "offset-line": () => activateDrawTool("offset"),
            }}
            activeId={draftTool === "line" ? "line-between-points" : draftTool === "polyline" ? "polyline-traverse" : draftTool === "offset" ? "offset-line" : null}
          />

          {/* Row 5 — registry-driven COGO curve-construction tools. Arc by 3
              Points is click-to-draw; the numeric-input arc methods + Fillet open the command bar. */}
          <CogoDrawingToolbar
            category="curve"
            onOpenTool={openFormTool}
            interceptIds={{ "arc-3points": () => activateDrawTool("curve") }}
            activeId={draftTool === "curve" ? "arc-3points" : null}
          />

          {/* Row 6 — registry-driven COGO polygon-construction tools. Draw
              Polygon is click-to-draw; Split/Merge/Offset/Area open the command bar. */}
          <CogoDrawingToolbar
            category="polygon"
            onOpenTool={openFormTool}
            interceptIds={{ "draw-polygon": () => activateDrawTool("polygon") }}
            activeId={draftTool === "polygon" ? "draw-polygon" : null}
          />

          {/* Row 7 — registry-driven traverse & adjustment tools (same computeTraverse() engine as the COGO Engine tab) */}
          <CogoDrawingToolbar category="traverse" onOpenTool={openFormTool} />

          {/* Row 8 — registry-driven query tools (read-only) */}
          <CogoDrawingToolbar category="query" onOpenTool={openFormTool} />

          {/* Row 9 — registry-driven annotation tools */}
          <CogoDrawingToolbar category="annotation" onOpenTool={openFormTool} />

          {(draftTool === "polyline" || draftTool === "polygon") && (
            <div className="flex items-center gap-2 border-b border-slate-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
              <span>
                {draft.length} vertex(es) placed — double-click, press Enter, or Finish to complete
                {draftTool === "polygon" ? " (closes back to the first point)" : ""}. Ctrl+Z removes the last vertex, Escape cancels.
              </span>
              <button type="button" onClick={finishDraft} disabled={draft.length < (draftTool === "polygon" ? 3 : 2)} className="ml-auto rounded-md bg-brand px-2 py-1 font-semibold text-white disabled:opacity-40">
                Finish
              </button>
              <button type="button" onClick={cancelDraft} className="rounded-md border border-amber-300 px-2 py-1 font-semibold text-amber-800">
                Cancel
              </button>
            </div>
          )}
          {draftTool === "offset" && (
            <div className="flex items-center gap-2 border-b border-slate-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
              <span>
                {!offsetLineId ? "Click the line to offset." : !offsetInput ? "Click either side to set the offset direction." : "Type the offset distance and press Enter."}
              </span>
              <button type="button" onClick={cancelDraft} className="ml-auto rounded-md border border-amber-300 px-2 py-1 font-semibold text-amber-800">
                Cancel
              </button>
            </div>
          )}

          <div className="relative">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="w-full touch-none bg-slate-50"
            style={{
              cursor: DRAW_TOOLS.includes(draftTool) || draftTool === "addpoint" || draftTool === "move" ? "crosshair" : pan.current ? "grabbing" : "default",
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={onDoubleClick}
            onPointerLeave={() => (pan.current = null)}
            onWheel={onWheel}
          >
            {polygons.map((p) => (
              <polygon
                key={p.id}
                points={p.points.map((v) => toScreen(v.east, v.north).join(",")).join(" ")}
                fill="#f59e0b"
                fillOpacity={0.15}
                stroke="#d97706"
                strokeWidth={1.4}
              />
            ))}
            {lines.map((l) => {
              const [x1, y1] = toScreen(l.aE, l.aN);
              const [x2, y2] = toScreen(l.bE, l.bN);
              return <line key={l.id} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#2563eb" strokeWidth={1.6} />;
            })}
            {arcs.map((a) => {
              const startRad = (a.startBearing * Math.PI) / 180;
              const endRad = (a.endBearing * Math.PI) / 180;
              const [x1, y1] = toScreen(a.cE + a.radius * Math.sin(startRad), a.cN + a.radius * Math.cos(startRad));
              const [x2, y2] = toScreen(a.cE + a.radius * Math.sin(endRad), a.cN + a.radius * Math.cos(endRad));
              const r = a.radius * view.zoom;
              return (
                <path
                  key={a.id}
                  d={`M ${x1} ${y1} A ${r} ${r} 0 ${a.largeArc} ${a.sweep} ${x2} ${y2}`}
                  fill="none"
                  stroke="#9333ea"
                  strokeWidth={1.8}
                />
              );
            })}
            {texts.map((t) => {
              const [x, y] = toScreen(t.east, t.north);
              return (
                <text key={t.id} x={x} y={y} fontSize={t.size} className="fill-slate-800 font-medium">
                  {t.text}
                </text>
              );
            })}
            {visible.length === 0 && lines.length === 0 && arcs.length === 0 && polygons.length === 0 && texts.length === 0 ? (
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
            {/* Rubber-band preview: dashed guide from the last placed vertex to the cursor. */}
            {DRAW_TOOLS.includes(draftTool) && draftTool !== "offset" && draft.length > 0 && cursor && (() => {
              const last = draft[draft.length - 1];
              const [x1, y1] = toScreen(last.east, last.north);
              const [x2, y2] = toScreen(cursor.e, cursor.n);
              return (
                <>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#059669" strokeWidth={1.4} strokeDasharray="5 4" />
                  {draftTool === "polygon" && draft.length >= 2 && (() => {
                    const [x0, y0] = toScreen(draft[0].east, draft[0].north);
                    return <line x1={x2} y1={y2} x2={x0} y2={y0} stroke="#059669" strokeWidth={1} strokeDasharray="2 4" opacity={0.5} />;
                  })()}
                </>
              );
            })()}
            {/* Offset tool preview: parallel dashed line at the cursor's live offset distance. */}
            {draftTool === "offset" && offsetLineId && !offsetInput && cursor && (() => {
              const line = lines.find((l) => l.id === offsetLineId);
              if (!line) return null;
              const dE = line.bE - line.aE, dN = line.bN - line.aN;
              const len = Math.hypot(dE, dN) || 1;
              const cross = ((cursor.e - line.aE) * dN - (cursor.n - line.aN) * dE) / len;
              const nE = dN / len, nN = -dE / len; // unit normal toward "right"/+offset
              const [x1, y1] = toScreen(line.aE + nE * cross, line.aN + nN * cross);
              const [x2, y2] = toScreen(line.bE + nE * cross, line.bN + nN * cross);
              return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#9333ea" strokeWidth={1.4} strokeDasharray="5 4" />;
            })()}
            {/* Snap highlight: ring around the existing point the cursor would snap to. */}
            {(draftTool === "addpoint" || draftTool === "move" || DRAW_TOOLS.includes(draftTool)) && cursor && (() => {
              const [sx, sy] = toScreen(cursor.e, cursor.n);
              const hit = snapPoint(sx, sy);
              if (!hit) return null;
              const [x, y] = toScreen(hit.east, hit.north);
              return <circle cx={x} cy={y} r={9} fill="none" stroke="#059669" strokeWidth={1.6} />;
            })()}
          </svg>

          {rename && (
            <input
              autoFocus
              value={rename.value}
              onChange={(e) => setRename({ ...rename, value: e.target.value })}
              onBlur={() => {
                setExtra((es) => es.map((p) => (p.id === rename.targetId ? { ...p, name: rename.value || p.name } : p)));
                setRename(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setRename(null);
              }}
              className="absolute z-10 w-24 rounded border border-brand bg-white px-1.5 py-0.5 text-xs shadow-md"
              style={{ left: `${(toScreen(rename.east, rename.north)[0] / W) * 100}%`, top: `${(toScreen(rename.east, rename.north)[1] / H) * 100 - 3}%` }}
            />
          )}
          {offsetInput && (
            <input
              autoFocus
              type="number"
              placeholder="Offset (m)"
              value={offsetInput.value}
              onChange={(e) => setOffsetInput({ ...offsetInput, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitOffset(offsetInput);
                if (e.key === "Escape") cancelDraft();
              }}
              className="absolute z-10 w-24 rounded border border-brand bg-white px-1.5 py-0.5 text-xs shadow-md"
              style={{ left: `${(offsetInput.screenX / W) * 100}%`, top: `${(offsetInput.screenY / H) * 100 - 3}%` }}
            />
          )}
          </div>

          {/* Bottom-docked command bar (Part 5) — numeric-input tools land here
              instead of a centered modal, so the canvas stays visible/pannable
              while typing. Point/line fields can also be filled by clicking
              the canvas (see the formTool branch in onPointerUp). */}
          <CogoCommandBar
            ref={commandBarRef}
            tool={formTool}
            points={visible}
            lines={lines}
            polygons={polygons}
            onResult={(result) => { addToolResult(result); setFormTool(null); }}
            onClose={() => setFormTool(null)}
          />

          {!formTool && (
          <div className="flex items-center justify-between border-t border-slate-200 px-3 py-1.5 text-xs text-slate-500">
            <span>
              {draftTool === "addpoint"
                ? `Click to place a point${snapEnabled ? " (snap on)" : ""}`
                : draftTool === "move"
                ? moving
                  ? `Click where to drop it${snapEnabled ? " (snap on)" : ""}`
                  : "Click a point to pick it up"
                : draftTool === "line"
                ? draft.length === 0 ? "Click the start point" : "Click the end point"
                : draftTool === "curve"
                ? ["Click the start point", "Click the end point", "Click a point on the arc"][draft.length] ?? "Click a point on the arc"
                : draftTool === "polyline" || draftTool === "polygon"
                ? draft.length === 0 ? "Click the first vertex" : "Click the next vertex · double-click / Enter to finish"
                : draftTool === "offset"
                ? "Click a line, then a side, then type the distance"
                : "Click a point to select · Drag to pan · Scroll to zoom"}
            </span>
            <span className="font-mono">
              {DRAW_TOOLS.includes(draftTool) && draft.length > 0 && cursor
                ? (() => {
                    const last = draft[draft.length - 1];
                    const [brg, dist] = inverse({ east: last.east, north: last.north }, { east: cursor.e, north: cursor.n });
                    return `Brg ${formatDms(brg)}  Dist ${dist.toFixed(3)}m`;
                  })()
                : <>Y = {cursor ? cursor.e.toFixed(3) : "—"}&nbsp;&nbsp;X = {cursor ? cursor.n.toFixed(3) : "—"}</>}
            </span>
          </div>
          )}
        </>
      )}
    </div>
  );
}

/** Labelled icon-row wrapper — same "heading above the strip" pattern as
 *  CogoDrawingToolbar's registry-driven rows, so a dense toolbar reads as
 *  named groups instead of one unbroken run of icons (client req 2026-08-14). */
function ToolGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-b border-slate-200 bg-slate-50">
      <div className="px-2 pt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="flex flex-wrap items-center gap-1 px-2 pb-1.5">{children}</div>
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
function iconMove(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M12 3v18M3 12h18" />
      <path d="M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5" strokeLinecap="round" />
    </svg>
  );
}
function iconSnap(c: string) {
  // A magnet — distinct from the corner-bracket "zoom to extents" icon so the
  // two aren't mistaken for each other (client feedback 2026-08-14).
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M6 4v8a6 6 0 0 0 12 0V4" strokeLinecap="round" />
      <path d="M6 4h5v5H6zM13 4h5v5h-5z" fill={c} fillOpacity="0.15" />
    </svg>
  );
}
