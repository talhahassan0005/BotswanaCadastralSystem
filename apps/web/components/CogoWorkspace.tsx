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
import { forward, inverse, polygonArea } from "@/lib/server/geometry";
import { formatDms, normalizeDeg, parseBearing } from "@/lib/server/angles";
import { CogoTraversePanel } from "@/components/CogoTraversePanel";
import { CogoTablesPanel, type LineMeta, type PointMeta, type PolygonMeta } from "@/components/CogoTablesPanel";
import { useStore } from "@/lib/store";
import type { CogoLeg, CogoResult } from "@/lib/types";
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

// Edit Tools (Select/Add/Move/Delete/Undo/Redo/Zoom/Snap) stay permanently
// visible — they're used constantly regardless of which drawing category is
// open. Everything else is tabbed so the toolbar doesn't read as a wall of icons.
const TOOL_GROUPS = [
  { id: "cogo", label: "COGO Calculators" },
  { id: "point", label: "Point Tools" },
  { id: "line", label: "Line Tools" },
  { id: "curve", label: "Curve Tools" },
  { id: "polygon", label: "Polygon Tools" },
  { id: "traverse", label: "Traverse & Adjustment" },
  { id: "query", label: "Query Tools" },
  { id: "annotation", label: "Annotation Tools" },
] as const;
type ToolGroupId = (typeof TOOL_GROUPS)[number]["id"];

export function CogoWorkspace({
  points,
  onTool,
}: {
  points: { name?: string | null; east: number; north: number }[];
  onTool: (id: ToolId) => void;
}) {
  const { config, setDiagramFigure, setDiagramInput, setActiveTab } = useStore();
  const [active, setActive] = useState(false);
  // Which toolbar group's icon row is showing — a tab bar instead of 9
  // permanently-stacked rows, so the toolbar reads as one screenful instead
  // of a wall of icons (client req 2026-08-16).
  const [activeGroup, setActiveGroup] = useState<ToolGroupId>("point");
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
  // ---- Add Point by Coordinates (Part 8e) — a typed alternative to
  // click-to-place, available while the Add Point tool is active. ----
  const [coordEntry, setCoordEntry] = useState<{ name: string; east: string; north: string } | null>(null);
  // ---- Move Point by typed Y/X (Part 8f) — once a point is picked up with
  // the Move tool, its coordinates can be typed instead of dragged. ----
  const [moveCoordInput, setMoveCoordInput] = useState<{ east: string; north: string } | null>(null);
  // ---- Points/Lines/Polygons data table panel (Part 9) ----
  const [tablesOpen, setTablesOpen] = useState(false);
  const [tableTab, setTableTab] = useState<"points" | "lines" | "polygons">("points");
  const [tableSelected, setTableSelected] = useState<Set<string>>(new Set());
  const [tableAnchor, setTableAnchor] = useState<string | null>(null);
  const [pointMeta, setPointMeta] = useState<Record<string, PointMeta>>({});
  const [lineMeta, setLineMeta] = useState<Record<string, LineMeta>>({});
  const [polygonMeta, setPolygonMeta] = useState<Record<string, PolygonMeta>>({});
  const [polygonAttrDialog, setPolygonAttrDialog] = useState<{ id: string; position: string; erf: string; area: string } | null>(null);
  // ---- bottom-docked command bar for numeric-input tools (Part 5) ----
  const [formTool, setFormTool] = useState<ToolDef | null>(null);
  const commandBarRef = useRef<CogoCommandBarHandle>(null);
  // Live "ghost" preview (Part 8b) of whatever the open command-bar tool would
  // currently produce — rendered dashed/translucent on the canvas.
  const [cmdPreview, setCmdPreview] = useState<ToolResult | null>(null);
  // ---- side-docked traverse leg-entry panel (Part 6b) — supersedes the
  // command bar for Line by Bearing&Distance / Polyline-Traverse / Traverse
  // Input: live preview line while typing, immediate draw + label on Add Leg. ----
  const [travOpen, setTravOpen] = useState(false);
  const [travStartPoint, setTravStartPoint] = useState<WPoint | null>(null);
  const [travStartHistory, setTravStartHistory] = useState<WPoint[]>([]); // previous start-point picks, for Undo-before-any-leg (7b)
  const [travFrom, setTravFrom] = useState<WPoint | null>(null);
  const [travToName, setTravToName] = useState("");
  const [travDir, setTravDir] = useState("");
  const [travDist, setTravDist] = useState("");
  const [travPickingStart, setTravPickingStart] = useState(false);
  const [travChoosingTo, setTravChoosingTo] = useState(false);
  const [travPointSource, setTravPointSource] = useState<"table" | "background-point" | "background-line">("table");
  const [travMemory, setTravMemory] = useState<{ dir: string; dist: string } | null>(null);
  const [travEditIndex, setTravEditIndex] = useState<number | null>(null);
  interface TravLeg { point: WPoint; direction: string; distance: string; lineId: string; labelId: string; fromName: string }
  const [travLegs, setTravLegs] = useState<TravLeg[]>([]);
  const travIdRef = useRef(1);
  // ---- per-plot diagram generation (Part 7d): click a specific plot on the
  // canvas, confirm a scale, generate the Diagrams-tab sheet for just that plot. ----
  const [diagramPicking, setDiagramPicking] = useState(false);
  const [diagramPrompt, setDiagramPrompt] = useState<{ polygon: WPolygon; screenX: number; screenY: number; value: string } | null>(null);
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
  function zoomBy(f: number) {
    setView((v) => ({ ...v, zoom: Math.min(50, Math.max(0.01, v.zoom * f)) }));
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

  function addToolResult(result: ToolResult): { pointIds: string[]; lineIds: string[] } {
    snapshot();
    if (result.replaceLineIds?.length) {
      const drop = new Set(result.replaceLineIds);
      setLines((ls) => ls.filter((l) => !drop.has(l.id)));
    }
    if (result.replacePolygonIds?.length) {
      const drop = new Set(result.replacePolygonIds);
      setPolygons((ps) => ps.filter((p) => !drop.has(p.id)));
    }
    const now = Date.now();
    let pointIds: string[] = [];
    let lineIds: string[] = [];
    if (result.points?.length) {
      pointIds = result.points.map((_, i) => `tool-${now}-${idRef.current + i}`);
      setExtra((e) => [...e, ...result.points!.map((p, i) => ({ id: pointIds[i], ...p }))]);
      idRef.current += result.points.length;
    }
    if (result.lines?.length) {
      lineIds = result.lines.map((_, i) => `line-${now}-${lineIdRef.current + i}`);
      setLines((ls) => [...ls, ...result.lines!.map((l, i) => ({ id: lineIds[i], ...l }))]);
      lineIdRef.current += result.lines.length;
    }
    if (result.arcs?.length) {
      setArcs((as) => [...as, ...result.arcs!.map((a, i) => ({ id: `arc-${now}-${arcIdRef.current + i}`, ...a }))]);
      arcIdRef.current += result.arcs.length;
    }
    if (result.polygons?.length) {
      setPolygons((ps) => [...ps, ...result.polygons!.map((p, i) => ({ id: `poly-${now}-${polyIdRef.current + i}`, ...p }))]);
      polyIdRef.current += result.polygons.length;
    }
    if (result.texts?.length) {
      setTexts((ts) => [
        ...ts,
        ...result.texts!.map((t, i) => ({ ...t, id: `text-${now}-${textIdRef.current + i}`, size: t.size ?? 12 })),
      ]);
      textIdRef.current += result.texts.length;
    }
    return { pointIds, lineIds };
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
    setTravOpen(false);
    setTravPickingStart(false);
    setTravChoosingTo(false);
    setDiagramPicking(false);
    setDiagramPrompt(null);
    setCoordEntry(null);
    setMoveCoordInput(null);
    setDraftTool(tool);
  }

  // ---- Add Point by Coordinates (Part 8e) — Name/Y/X form as an alternative
  // to clicking on the canvas. ----
  function coordEntryOpen() {
    setCoordEntry({ name: `New${idRef.current}`, east: "", north: "" });
  }
  function coordEntryUpdate() {
    if (!coordEntry) return;
    const east = Number(coordEntry.east), north = Number(coordEntry.north);
    if (!Number.isFinite(east) || !Number.isFinite(north)) { window.alert("Enter valid Y (Easting) and X (Northing) values."); return; }
    snapshot();
    const newId = `coord-${Date.now()}-${idRef.current}`;
    const name = coordEntry.name || `New${idRef.current}`;
    idRef.current += 1;
    setExtra((e) => [...e, { id: newId, name, east, north }]);
    setCoordEntry({ name: `New${idRef.current}`, east: "", north: "" });
  }
  function coordEntryNew() {
    setCoordEntry({ name: `New${idRef.current}`, east: "", north: "" });
  }

  // ---- Move Point by typed Y/X (Part 8f) ----
  function applyMoveCoords() {
    if (!moving || !moveCoordInput) return;
    const east = Number(moveCoordInput.east), north = Number(moveCoordInput.north);
    if (!Number.isFinite(east) || !Number.isFinite(north)) { window.alert("Enter valid Y (Easting) and X (Northing) values."); return; }
    snapshot();
    if (moving.startsWith("imp-")) {
      const orig = basePoints.find((p) => p.id === moving);
      setHidden((h) => new Set(h).add(moving));
      setExtra((e) => [...e, { id: `moved-${Date.now()}`, name: orig?.name ?? "Moved", east, north }]);
    } else {
      setExtra((e) => e.map((p) => (p.id === moving ? { ...p, east, north } : p)));
    }
    setMoving(null);
    setSelected(null);
    setMoveCoordInput(null);
  }

  // ---- Points/Lines/Polygons data table panel (Part 9) ----
  function currentTableIds(): string[] {
    if (tableTab === "points") return visible.map((p) => p.id);
    if (tableTab === "lines") return lines.map((l) => l.id);
    return polygons.map((p) => p.id);
  }
  function tableRowMouseDown(id: string, shiftKey: boolean) {
    if (shiftKey && tableAnchor) {
      const ids = currentTableIds();
      const ai = ids.indexOf(tableAnchor), bi = ids.indexOf(id);
      if (ai !== -1 && bi !== -1) {
        const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai];
        setTableSelected(new Set(ids.slice(lo, hi + 1)));
        return;
      }
    }
    setTableAnchor(id);
    setTableSelected(new Set([id]));
    if (tableTab === "points") setSelected(id); // two-way sync: table click also highlights the point on canvas
  }
  function tableRowMouseEnter(id: string) {
    if (!tableAnchor) return;
    const ids = currentTableIds();
    const ai = ids.indexOf(tableAnchor), bi = ids.indexOf(id);
    if (ai === -1 || bi === -1) return;
    const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai];
    setTableSelected(new Set(ids.slice(lo, hi + 1)));
  }
  function deleteTableSelection() {
    if (!tableSelected.size) return;
    snapshot();
    if (tableTab === "points") {
      setExtra((e) => e.filter((p) => !tableSelected.has(p.id)));
      setHidden((h) => { const n = new Set(h); tableSelected.forEach((id) => n.add(id)); return n; });
    } else if (tableTab === "lines") {
      setLines((ls) => ls.filter((l) => !tableSelected.has(l.id)));
    } else {
      setPolygons((ps) => ps.filter((p) => !tableSelected.has(p.id)));
    }
    setTableSelected(new Set());
    setTableAnchor(null);
    setSelected(null);
  }
  function openPolygonAttrs(id: string) {
    const poly = polygons.find((p) => p.id === id);
    if (!poly) return;
    const m = polygonMeta[id] ?? {};
    const areaM2 = polygonArea(poly.points.map((v) => ({ east: v.east, north: v.north })));
    setPolygonAttrDialog({ id, position: m.position ?? "", erf: m.erf ?? "", area: `${(areaM2 / 10000).toFixed(4)} ha` });
  }
  function savePolygonAttrs() {
    if (!polygonAttrDialog) return;
    const { id, position, erf } = polygonAttrDialog;
    setPolygonMeta((m) => ({ ...m, [id]: { ...m[id], position, erf } }));
    setPolygonAttrDialog(null);
  }
  /** Open the command bar for a numeric-input tool, discarding any
   *  in-progress click-to-draw shape first (only one mode at a time). */
  function openFormTool(tool: ToolDef) {
    activateDrawTool("select");
    setFormTool(tool);
    setTravOpen(false);
  }

  // ---- traverse leg-entry panel (Part 6b) ----
  function openTraversePanel() {
    activateDrawTool("select");
    setFormTool(null);
    setTravOpen(true);
  }
  /** Live preview endpoint — recomputed on every render as travDir/travDist
   *  change, so the dashed preview line updates on every keystroke with no
   *  extra wiring. Null (no preview) on any unparsable/incomplete input. */
  const travPreview = (() => {
    if (!travOpen || !travFrom || !travDir.trim() || !travDist.trim()) return null;
    try {
      const brg = parseBearing(travDir);
      const dist = Number(travDist);
      if (!Number.isFinite(dist) || dist <= 0) return null;
      return forward({ east: travFrom.east, north: travFrom.north }, brg, dist);
    } catch {
      return null;
    }
  })();
  /** Client requirement 2026-08-17 (7a): joining points must snap to an
   *  existing point — clicking near-but-not-on one must never silently
   *  create a new point. New points only ever come from the explicit Add
   *  Point (by click or by coordinate) tool. So Start Pt stays armed and
   *  does nothing on a miss, rather than falling back to creating a point. */
  function travSetStart(v: { east: number; north: number; existingId?: string }) {
    if (!v.existingId) return;
    const p = visible.find((pp) => pp.id === v.existingId)!;
    if (travLegs.length) {
      // 7c: picking a new start point after legs already exist begins the
      // NEXT adjacent plot in the same sheet — everything already drawn
      // stays on the canvas, only the leg-tracking chain resets.
      setTravLegs([]);
      setTravEditIndex(null);
    }
    // 7b: remember the previous pick so a wrong snap can be undone before
    // any leg is committed (the Undo button below does double duty).
    setTravStartHistory((h) => (travStartPoint ? [...h, travStartPoint] : h));
    setTravStartPoint(p);
    setTravFrom(p);
    setTravPickingStart(false);
  }
  /** "Choose To": click an existing point instead of typing — back-computes
   *  the direction/distance from the current from-point to it. */
  function travChooseTo(v: { east: number; north: number; existingId?: string }) {
    setTravChoosingTo(false);
    if (!travFrom) { window.alert("Pick a start point first."); return; }
    if (!v.existingId) { window.alert("Click an existing point for Choose To."); return; }
    const target = visible.find((p) => p.id === v.existingId)!;
    const [brg, dist] = inverse({ east: travFrom.east, north: travFrom.north }, { east: target.east, north: target.north });
    setTravDir(formatDms(brg));
    setTravDist(dist.toFixed(3));
    setTravToName(target.name);
  }
  function travEditDirDistHint() {
    if (travEditIndex == null) window.alert("Click a leg in the list above to edit it.");
  }
  function travAddLeg() {
    if (!travFrom) { window.alert("Pick a start point first (Start Pt)."); return; }
    if (!travPreview) { window.alert("Enter a valid direction and distance."); return; }
    const name = travToName.trim() || `T${travIdRef.current}`;
    const pointId = `trav-${Date.now()}-${travIdRef.current}`;
    const lineId = `travline-${Date.now()}-${travIdRef.current}`;
    const labelId = `travlabel-${Date.now()}-${travIdRef.current}`;
    travIdRef.current += 1;
    const midE = (travFrom.east + travPreview.east) / 2;
    const midN = (travFrom.north + travPreview.north) / 2;
    snapshot();
    if (travEditIndex != null) {
      // Editing an already-committed leg: drop it and everything chained after
      // it, then re-add from here — simplest correct way to cascade the change.
      const stale = travLegs.slice(travEditIndex);
      const staleIds = new Set(stale.flatMap((l) => [l.point.id, l.lineId, l.labelId]));
      setExtra((e) => e.filter((p) => !staleIds.has(p.id)));
      setLines((ls) => ls.filter((l) => !staleIds.has(l.id)));
      setTexts((ts) => ts.filter((t) => !staleIds.has(t.id)));
      setTravLegs((legs) => legs.slice(0, travEditIndex));
      setTravEditIndex(null);
    }
    const newPoint: WPoint = { id: pointId, name, east: travPreview.east, north: travPreview.north };
    setExtra((e) => [...e, newPoint]);
    setLines((ls) => [...ls, { id: lineId, aE: travFrom.east, aN: travFrom.north, bE: travPreview.east, bN: travPreview.north }]);
    setTexts((ts) => [...ts, { id: labelId, text: `${travDir}  ${travDist}m`, east: midE, north: midN, size: 11 }]);
    setTravLegs((legs) => [...legs, { point: newPoint, direction: travDir, distance: travDist, lineId, labelId, fromName: travFrom.name }]);
    setTravFrom(newPoint);
    setTravToName("");
    setTravDir("");
    setTravDist("");
  }
  function travEditLeg(i: number) {
    const leg = travLegs[i];
    const from = i === 0 ? travStartPoint : travLegs[i - 1].point;
    if (!from) return;
    setTravFrom(from);
    setTravToName(leg.point.name);
    setTravDir(leg.direction);
    setTravDist(leg.distance);
    setTravEditIndex(i);
  }
  /** Undoes the last committed leg — or, if no leg has been committed yet
   *  (7b), the last point *pick* instead, so an accidental snap-to-the-
   *  wrong-point during Start Pt can be corrected before it ever becomes a leg. */
  function travUndo() {
    if (travLegs.length) {
      setTravLegs((legs) => {
        if (!legs.length) return legs;
        const last = legs[legs.length - 1];
        setExtra((e) => e.filter((p) => p.id !== last.point.id));
        setLines((ls) => ls.filter((l) => l.id !== last.lineId));
        setTexts((ts) => ts.filter((t) => t.id !== last.labelId));
        const rest = legs.slice(0, -1);
        setTravFrom(rest.length ? rest[rest.length - 1].point : travStartPoint);
        return rest;
      });
      return;
    }
    if (travStartHistory.length) {
      const prev = travStartHistory[travStartHistory.length - 1];
      setTravStartHistory((h) => h.slice(0, -1));
      setTravStartPoint(prev);
      setTravFrom(prev);
    } else if (travStartPoint) {
      setTravStartPoint(null);
      setTravFrom(null);
    } else {
      window.alert("Nothing to undo.");
    }
  }
  function travClear() {
    const ids = new Set(travLegs.flatMap((l) => [l.point.id, l.lineId, l.labelId]));
    if (ids.size) {
      setExtra((e) => e.filter((p) => !ids.has(p.id)));
      setLines((ls) => ls.filter((l) => !ids.has(l.id)));
      setTexts((ts) => ts.filter((t) => !ids.has(t.id)));
    }
    setTravLegs([]);
    setTravFrom(travStartPoint);
    setTravToName("");
    setTravDir("");
    setTravDist("");
    setTravEditIndex(null);
    setTravStartHistory([]);
  }
  function travSwapDir() {
    try {
      setTravDir(formatDms(normalizeDeg(parseBearing(travDir) + 180)));
    } catch {
      /* nothing valid typed yet — ignore */
    }
  }
  function travMemorize() {
    if (travDir.trim() || travDist.trim()) setTravMemory({ dir: travDir, dist: travDist });
  }
  function travRecall() {
    if (travMemory) { setTravDir(travMemory.dir); setTravDist(travMemory.dist); }
  }
  function travCalculate() {
    if (!travLegs.length) { window.alert("No legs entered yet."); return; }
    const totalDist = travLegs.reduce((s, l) => s + (Number(l.distance) || 0), 0);
    const last = travLegs[travLegs.length - 1].point;
    const closeMsg = travStartPoint
      ? `  ·  Distance back to start: ${inverse({ east: travStartPoint.east, north: travStartPoint.north }, { east: last.east, north: last.north })[1].toFixed(3)}m`
      : "";
    window.alert(`Legs: ${travLegs.length}  ·  Total distance: ${totalDist.toFixed(3)}m${closeMsg}`);
  }
  function travClose() {
    setTravOpen(false);
    setTravPickingStart(false);
    setTravChoosingTo(false);
    setTravEditIndex(null);
  }

  // ---- per-plot diagram generation (Part 7d) ----
  function pointInPolygon(wx: number, wy: number, poly: WPolygon): boolean {
    const pts = poly.points;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      const hit = a.north > wy !== b.north > wy && wx < ((b.east - a.east) * (wy - a.north)) / (b.north - a.north) + a.east;
      if (hit) inside = !inside;
    }
    return inside;
  }
  function diagramPickAt(sx: number, sy: number, screenX: number, screenY: number) {
    const [wx, wy] = toWorld(sx, sy);
    const hit = polygons.find((p) => pointInPolygon(wx, wy, p));
    setDiagramPicking(false);
    if (!hit) { window.alert("Click inside one of the drawn plots (polygons) to generate its diagram."); return; }
    setDiagramPrompt({ polygon: hit, screenX, screenY, value: "2000" });
  }
  function diagramConfirm() {
    if (!diagramPrompt) return;
    const scale = Number(diagramPrompt.value) || 2000;
    const poly = diagramPrompt.polygon;
    const pts = poly.points;
    const legsOut: CogoLeg[] = pts.map((p, i) => {
      const next = pts[(i + 1) % pts.length];
      const [brg, dist] = inverse({ east: p.east, north: p.north }, { east: next.east, north: next.north });
      return { index: i + 1, from: p.name, to: next.name, bearing: brg, bearing_dms: formatDms(brg), distance: dist, d_east_adj: next.east - p.east, d_north_adj: next.north - p.north };
    });
    const areaM2 = Math.abs(polygonArea(pts));
    const perim = legsOut.reduce((s, l) => s + l.distance, 0);
    const fig: CogoResult = {
      type: "closed",
      adjustment: "none",
      closure: { misclose_east: 0, misclose_north: 0, linear_misclosure: 0, total_distance: perim, relative_precision: null, relative_precision_text: "exact (plot boundary)" },
      area_m2: areaM2,
      area_ha: areaM2 / 10000,
      sigma0: 0,
      points: pts.map((p) => ({ name: p.name, east: p.east, north: p.north })),
      legs: legsOut,
      residuals: [],
    };
    setDiagramFigure(fig);
    setDiagramInput({
      kind: "surveyed",
      meta: {
        lotName: poly.name || "PLOT",
        parent: "",
        location: "",
        tribalArea: "",
        surveyor: config.surveyor ? config.surveyor.toUpperCase() : "",
        surveyedDate: "",
        coordinateSystem: config.coordinateSystem.replace(" Botswana", ""),
        scale,
        dsmNo: "",
        srNo: "",
        gpNo: "",
        degreeSquare: "",
        parentDiagram: "",
        beaconDescription: "ALL: 12mm iron peg",
        areaHa: areaM2 / 10000,
        sourceRef: "",
        boreholeNo: "",
        boreholeE: 0,
        boreholeN: 0,
      },
    });
    setDiagramPrompt(null);
    setActiveTab("diagrams");
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

  const SNAP_PX = 16; // generous/forgiving on purpose (client req 2026-08-17, 7a) — "close enough" should snap
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
      if (diagramPicking) {
        // "Diagram" action (7d): the next canvas click picks which specific
        // plot/polygon to generate a diagram for.
        diagramPickAt(vbx, vby, vbx, vby);
      } else if (travPickingStart) {
        // Traverse panel's "Start Pt" — the next canvas click sets/replaces
        // the point the leg-entry chain begins from.
        travSetStart(resolveVertex(vbx, vby));
      } else if (travChoosingTo) {
        // Traverse panel's "Choose To" — click an existing point to back-fill
        // Direction/Distance instead of typing them.
        travChooseTo(resolveVertex(vbx, vby));
      } else if (formTool) {
        // Command bar open (Part 5): clicking a point/line on canvas fills
        // whichever field is focused (or the first empty matching field)
        // instead of doing the normal select/pan/draw behaviour. If a
        // "bearing"-type field is focused, a line click instead copies that
        // line's bearing into it as text (Part 8a).
        if (commandBarRef.current?.getFocusedFieldType() === "bearing") {
          const l = nearestLineHit(vbx, vby);
          if (l) {
            const [brg] = inverse({ east: l.aE, north: l.aN }, { east: l.bE, north: l.bN });
            commandBarRef.current.pickFromCanvas("bearing", formatDms(brg));
          }
        } else {
          const p = snapPoint(vbx, vby);
          if (p) commandBarRef.current?.pickFromCanvas("point", p.id);
          else {
            const l = nearestLineHit(vbx, vby);
            if (l) commandBarRef.current?.pickFromCanvas("line", l.id);
          }
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
          if (hit) { setMoving(hit.id); setSelected(hit.id); setMoveCoordInput({ east: hit.east.toFixed(3), north: hit.north.toFixed(3) }); }
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
          setMoveCoordInput(null);
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
        if (tablesOpen && tableTab === "points") {
          // Two-way canvas<->table highlight sync (Part 9e).
          setTableAnchor(hit?.id ?? null);
          setTableSelected(hit ? new Set([hit.id]) : new Set());
        }
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
    if (!DRAW_TOOLS.includes(draftTool) && !formTool && !travOpen && !diagramPicking && !diagramPrompt && !coordEntry && !moveCoordInput) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        if (diagramPrompt) setDiagramPrompt(null);
        else if (diagramPicking) setDiagramPicking(false);
        else if (travOpen) travClose();
        else if (formTool) setFormTool(null);
        else if (coordEntry) setCoordEntry(null);
        else if (moveCoordInput) { setMoving(null); setSelected(null); setMoveCoordInput(null); }
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
  }, [draftTool, draft, formTool, travOpen, diagramPicking, diagramPrompt, coordEntry, moveCoordInput]);

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
          {/* Always-visible — used constantly regardless of which drawing
              category tab (below) is open. */}
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
            <DraftButton label="Zoom in" onClick={() => zoomBy(1.25)} icon={iconZoomIn} />
            <DraftButton label="Zoom out" onClick={() => zoomBy(1 / 1.25)} icon={iconZoomOut} />
            <DraftButton label="Zoom to extents (fit all)" onClick={zoomExtents} icon={iconZoomExtents} />
            <DraftButton
              active={snapEnabled}
              label="Snap to point / line / grid"
              onClick={() => setSnapEnabled((s) => !s)}
              icon={iconSnap}
            />
            <div className="mx-1 h-5 w-px bg-slate-200" />
            <DraftButton
              active={diagramPicking}
              label="Diagram — click a plot to generate its diagram sheet"
              onClick={() => { setDiagramPicking((v) => !v); setDiagramPrompt(null); }}
              icon={iconDiagram}
            />
            <DraftButton
              active={tablesOpen}
              label="Tables — Points / Lines / Polygons data (Part 9)"
              onClick={() => setTablesOpen((v) => !v)}
              icon={iconTables}
            />
          </ToolGroup>

          {/* Tab bar — pick a category to see just its icons, instead of every
              category's row stacked on screen at once (client req 2026-08-16). */}
          <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 bg-white px-2 py-1">
            {TOOL_GROUPS.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => setActiveGroup(g.id)}
                className={`rounded-md px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide transition ${
                  activeGroup === g.id ? "bg-brand text-white" : "text-slate-500 hover:bg-slate-100"
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>

          {/* Only the selected tab's tools render below. */}
          {activeGroup === "cogo" && (
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
          )}
          {/* "Add Point" is click-to-draw (Part 1); the rest open the command bar (Part 5). */}
          {activeGroup === "point" && (
            <CogoDrawingToolbar
              category="point"
              onOpenTool={openFormTool}
              interceptIds={{ "add-point": () => activateDrawTool("addpoint") }}
              activeId={draftTool === "addpoint" ? "add-point" : null}
            />
          )}
          {/* Line and Offset are click-to-draw. Line by Bearing&Distance and
              Polyline/Traverse open the side traverse panel (Part 6b, live
              preview + immediate leg drawing) instead of the click-to-draw
              engine or the bottom command bar. Extend/Trim/Perpendicular
              still open the command bar (need exact numeric input). */}
          {activeGroup === "line" && (
            <CogoDrawingToolbar
              category="line"
              onOpenTool={openFormTool}
              interceptIds={{
                "line-between-points": () => activateDrawTool("line"),
                "line-bearing-distance": () => openTraversePanel(),
                "polyline-traverse": () => openTraversePanel(),
                "offset-line": () => activateDrawTool("offset"),
              }}
              activeId={draftTool === "line" ? "line-between-points" : draftTool === "offset" ? "offset-line" : null}
            />
          )}
          {/* Arc by 3 Points is click-to-draw; the numeric-input arc methods + Fillet open the command bar. */}
          {activeGroup === "curve" && (
            <CogoDrawingToolbar
              category="curve"
              onOpenTool={openFormTool}
              interceptIds={{ "arc-3points": () => activateDrawTool("curve") }}
              activeId={draftTool === "curve" ? "arc-3points" : null}
            />
          )}
          {/* Draw Polygon is click-to-draw; Split/Merge/Offset/Area open the command bar. */}
          {activeGroup === "polygon" && (
            <CogoDrawingToolbar
              category="polygon"
              onOpenTool={openFormTool}
              interceptIds={{ "draw-polygon": () => activateDrawTool("polygon") }}
              activeId={draftTool === "polygon" ? "draw-polygon" : null}
            />
          )}
          {/* Same computeTraverse() engine as the COGO Engine tab. Traverse
              Input opens the side leg-entry panel (Part 6b); Closure Check /
              Bowditch / Transit / Least-Squares open the command bar. */}
          {activeGroup === "traverse" && (
            <CogoDrawingToolbar
              category="traverse"
              onOpenTool={openFormTool}
              interceptIds={{ "traverse-input": () => openTraversePanel() }}
              activeId={travOpen ? "traverse-input" : null}
            />
          )}
          {activeGroup === "query" && <CogoDrawingToolbar category="query" onOpenTool={openFormTool} />}
          {activeGroup === "annotation" && <CogoDrawingToolbar category="annotation" onOpenTool={openFormTool} />}

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

          <div className="flex items-stretch">
          <div className="relative min-w-0 flex-1">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="w-full touch-none bg-slate-50"
            style={{
              cursor: diagramPicking || travPickingStart || travChoosingTo || DRAW_TOOLS.includes(draftTool) || draftTool === "addpoint" || draftTool === "move" ? "crosshair" : pan.current ? "grabbing" : "default",
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={onDoubleClick}
            onPointerLeave={() => (pan.current = null)}
            onWheel={onWheel}
          >
            {polygons.map((p) => {
              const isTableSel = tablesOpen && tableTab === "polygons" && tableSelected.has(p.id);
              return (
                <polygon
                  key={p.id}
                  points={p.points.map((v) => toScreen(v.east, v.north).join(",")).join(" ")}
                  fill={isTableSel ? "#dc2626" : "#f59e0b"}
                  fillOpacity={isTableSel ? 0.28 : 0.15}
                  stroke={isTableSel ? "#dc2626" : "#d97706"}
                  strokeWidth={isTableSel ? 2.4 : 1.4}
                />
              );
            })}
            {lines.map((l) => {
              const [x1, y1] = toScreen(l.aE, l.aN);
              const [x2, y2] = toScreen(l.bE, l.bN);
              const isTableSel = tablesOpen && tableTab === "lines" && tableSelected.has(l.id);
              return <line key={l.id} x1={x1} y1={y1} x2={x2} y2={y2} stroke={isTableSel ? "#dc2626" : "#2563eb"} strokeWidth={isTableSel ? 3 : 1.6} />;
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
                const isSel = p.id === selected || (tablesOpen && tableTab === "points" && tableSelected.has(p.id));
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
            {/* Command bar live "ghost" preview (Part 8b) — what the open
                numeric tool would currently produce, before Compute is pressed. */}
            {cmdPreview?.lines?.map((l, i) => {
              const [x1, y1] = toScreen(l.aE, l.aN);
              const [x2, y2] = toScreen(l.bE, l.bN);
              return <line key={`cp-l-${i}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#0891b2" strokeWidth={1.4} strokeDasharray="5 4" opacity={0.75} />;
            })}
            {cmdPreview?.points?.map((p, i) => {
              const [x, y] = toScreen(p.east, p.north);
              return (
                <g key={`cp-p-${i}`} opacity={0.8}>
                  <circle cx={x} cy={y} r={6} fill="none" stroke="#0891b2" strokeWidth={1.6} strokeDasharray="2 2" />
                  <circle cx={x} cy={y} r={2} fill="#0891b2" />
                </g>
              );
            })}
            {/* Snap highlight: ring around the existing point the cursor would snap to. */}
            {(draftTool === "addpoint" || draftTool === "move" || DRAW_TOOLS.includes(draftTool)) && cursor && (() => {
              const [sx, sy] = toScreen(cursor.e, cursor.n);
              const hit = snapPoint(sx, sy);
              if (!hit) return null;
              const [x, y] = toScreen(hit.east, hit.north);
              return <circle cx={x} cy={y} r={9} fill="none" stroke="#059669" strokeWidth={1.6} />;
            })()}
            {/* Traverse panel (Part 6b): faint dashed preview of the leg being
                typed, updating live on every keystroke — before Add Leg commits it. */}
            {travOpen && travFrom && travPreview && (() => {
              const [x1, y1] = toScreen(travFrom.east, travFrom.north);
              const [x2, y2] = toScreen(travPreview.east, travPreview.north);
              return (
                <>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#0891b2" strokeWidth={1.6} strokeDasharray="6 4" opacity={0.85} />
                  <circle cx={x2} cy={y2} r={4} fill="none" stroke="#0891b2" strokeWidth={1.6} />
                </>
              );
            })()}
            {travOpen && travFrom && (() => {
              const [x, y] = toScreen(travFrom.east, travFrom.north);
              return <circle cx={x} cy={y} r={7} fill="none" stroke="#0891b2" strokeWidth={2} />;
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
          {diagramPrompt && (
            <div
              className="absolute z-10 flex items-center gap-1.5 rounded border border-brand bg-white px-2 py-1.5 text-xs shadow-md"
              style={{ left: `${(diagramPrompt.screenX / W) * 100}%`, top: `${(diagramPrompt.screenY / H) * 100 - 3}%` }}
            >
              <span className="text-slate-500">Scale 1:</span>
              <input
                autoFocus
                type="number"
                value={diagramPrompt.value}
                onChange={(e) => setDiagramPrompt({ ...diagramPrompt, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") diagramConfirm();
                  if (e.key === "Escape") setDiagramPrompt(null);
                }}
                className="w-16 rounded border border-slate-200 px-1 py-0.5"
              />
              <button type="button" onClick={diagramConfirm} className="rounded bg-brand px-1.5 py-0.5 font-semibold text-white">OK</button>
              <button type="button" onClick={() => setDiagramPrompt(null)} className="text-slate-400 hover:text-slate-700">✕</button>
            </div>
          )}

          {/* Add Point by Coordinates (Part 8e) — typed alternative to
              click-to-place, while the Add Point tool is active. */}
          {coordEntry && (
            <div className="absolute right-2 top-2 z-10 w-52 rounded border border-brand bg-white p-2 text-xs shadow-md">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="font-semibold text-brand-dark">Add Point by Coordinates</span>
                <button type="button" onClick={() => setCoordEntry(null)} className="text-slate-400 hover:text-slate-700" aria-label="Close">✕</button>
              </div>
              <label className="mb-1 block">
                <span className="mb-0.5 block text-slate-500">Name</span>
                <input value={coordEntry.name} onChange={(e) => setCoordEntry({ ...coordEntry, name: e.target.value })} className="w-full rounded border border-slate-200 px-1.5 py-1" />
              </label>
              <div className="mb-1.5 grid grid-cols-2 gap-1.5">
                <label className="block">
                  <span className="mb-0.5 block text-slate-500">Y (East)</span>
                  <input type="number" value={coordEntry.east} onChange={(e) => setCoordEntry({ ...coordEntry, east: e.target.value })} className="w-full rounded border border-slate-200 px-1.5 py-1" />
                </label>
                <label className="block">
                  <span className="mb-0.5 block text-slate-500">X (North)</span>
                  <input type="number" value={coordEntry.north} onChange={(e) => setCoordEntry({ ...coordEntry, north: e.target.value })} className="w-full rounded border border-slate-200 px-1.5 py-1" />
                </label>
              </div>
              <div className="grid grid-cols-3 gap-1">
                <button type="button" onClick={coordEntryUpdate} className="rounded bg-brand px-1.5 py-1 font-semibold text-white">Update</button>
                <button type="button" onClick={coordEntryNew} className="rounded border border-slate-200 px-1.5 py-1 hover:bg-slate-50">New</button>
                <button type="button" onClick={() => setCoordEntry(null)} className="rounded border border-slate-200 px-1.5 py-1 hover:bg-slate-50">Cancel</button>
              </div>
            </div>
          )}

          {/* Move Point by typed Y/X (Part 8f) — alternative to dragging, once a point is picked up. */}
          {draftTool === "move" && moving && moveCoordInput && (
            <div className="absolute right-2 top-2 z-10 w-48 rounded border border-brand bg-white p-2 text-xs shadow-md">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="font-semibold text-brand-dark">Move to Coordinates</span>
                <button type="button" onClick={() => { setMoving(null); setSelected(null); setMoveCoordInput(null); }} className="text-slate-400 hover:text-slate-700" aria-label="Cancel">✕</button>
              </div>
              <div className="mb-1.5 grid grid-cols-2 gap-1.5">
                <label className="block">
                  <span className="mb-0.5 block text-slate-500">Y (East)</span>
                  <input type="number" value={moveCoordInput.east} onChange={(e) => setMoveCoordInput({ ...moveCoordInput, east: e.target.value })} className="w-full rounded border border-slate-200 px-1.5 py-1" />
                </label>
                <label className="block">
                  <span className="mb-0.5 block text-slate-500">X (North)</span>
                  <input type="number" value={moveCoordInput.north} onChange={(e) => setMoveCoordInput({ ...moveCoordInput, north: e.target.value })} className="w-full rounded border border-slate-200 px-1.5 py-1" />
                </label>
              </div>
              <button type="button" onClick={applyMoveCoords} className="w-full rounded bg-brand px-1.5 py-1 font-semibold text-white">Apply</button>
            </div>
          )}
          </div>

          {/* Side-docked traverse leg-entry panel (Part 6b) — sits beside the
              canvas (never covers it) while a Line by Bearing&Distance /
              Polyline-Traverse / Traverse Input tool is open. */}
          {travOpen && (
            <CogoTraversePanel
              legs={travLegs}
              startName={travStartPoint?.name ?? null}
              fromName={travFrom?.name ?? null}
              toName={travToName}
              direction={travDir}
              distance={travDist}
              pickingStart={travPickingStart}
              pointSource={travPointSource}
              editIndex={travEditIndex}
              hasMemory={!!travMemory}
              onToName={setTravToName}
              onDirection={setTravDir}
              onDistance={setTravDist}
              onPointSource={setTravPointSource}
              onStartPt={() => setTravPickingStart(true)}
              onChooseTo={() => setTravChoosingTo(true)}
              onAddLeg={travAddLeg}
              onSwapDir={travSwapDir}
              onUndo={travUndo}
              onClear={travClear}
              onEditLeg={travEditLeg}
              onEditDirDist={travEditDirDistHint}
              onMemorize={travMemorize}
              onRecall={travRecall}
              onCalculate={travCalculate}
              onZoom={zoomExtents}
              onClose={travClose}
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
            onResult={(result, opts) => {
              const ids = addToolResult(result);
              if (!opts?.keepOpen) setFormTool(null);
              return ids;
            }}
            onClose={() => setFormTool(null)}
            onPreview={setCmdPreview}
          />

          {!formTool && (
          <div className="flex items-center justify-between border-t border-slate-200 px-3 py-1.5 text-xs text-slate-500">
            <span>
              {diagramPicking
                ? "Click inside a plot (polygon) to generate its diagram"
                : travPickingStart
                ? "Click a point on the canvas to start the traverse from"
                : travChoosingTo
                ? "Click an existing point — its direction & distance from the current point will be filled in"
                : draftTool === "addpoint"
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
            {draftTool === "addpoint" && !coordEntry && (
              <button type="button" onClick={coordEntryOpen} className="rounded border border-slate-200 px-2 py-0.5 text-slate-600 hover:bg-slate-50">
                By Coordinates
              </button>
            )}
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

          {/* Points/Lines/Polygons data table panel (Part 9). */}
          {tablesOpen && (
            <CogoTablesPanel
              tab={tableTab}
              onTab={(t) => { setTableTab(t); setTableSelected(new Set()); setTableAnchor(null); }}
              points={visible}
              lines={lines}
              polygons={polygons}
              pointMeta={pointMeta}
              lineMeta={lineMeta}
              polygonMeta={polygonMeta}
              selected={tableSelected}
              onRowMouseDown={tableRowMouseDown}
              onRowMouseEnter={tableRowMouseEnter}
              onSetPointMeta={(id, patch) => setPointMeta((m) => ({ ...m, [id]: { ...m[id], ...patch } }))}
              onSetLineMeta={(id, patch) => setLineMeta((m) => ({ ...m, [id]: { ...m[id], ...patch } }))}
              onSetPolygonMeta={(id, patch) => setPolygonMeta((m) => ({ ...m, [id]: { ...m[id], ...patch } }))}
              onDeleteSelection={deleteTableSelection}
              onOpenPolygonAttrs={openPolygonAttrs}
              onClose={() => { setTablesOpen(false); setTableSelected(new Set()); setTableAnchor(null); }}
            />
          )}

          {/* Polygon quick-edit dialog (Part 9f) — Position, ID/Erf, Area, Cancel/OK. */}
          {polygonAttrDialog && (
            <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/30" onClick={() => setPolygonAttrDialog(null)}>
              <div className="w-72 rounded-lg bg-white p-4 text-xs shadow-xl" onClick={(e) => e.stopPropagation()}>
                <h3 className="mb-3 text-sm font-semibold text-slate-700">Polygon Attributes</h3>
                <label className="mb-2 block">
                  <span className="mb-0.5 block text-slate-500">Position</span>
                  <input
                    value={polygonAttrDialog.position}
                    onChange={(e) => setPolygonAttrDialog({ ...polygonAttrDialog, position: e.target.value })}
                    className="w-full rounded border border-slate-200 px-2 py-1.5"
                  />
                </label>
                <label className="mb-2 block">
                  <span className="mb-0.5 block text-slate-500">ID / Erf</span>
                  <input
                    value={polygonAttrDialog.erf}
                    onChange={(e) => setPolygonAttrDialog({ ...polygonAttrDialog, erf: e.target.value })}
                    className="w-full rounded border border-slate-200 px-2 py-1.5"
                  />
                </label>
                <label className="mb-3 block">
                  <span className="mb-0.5 block text-slate-500">Area</span>
                  <input value={polygonAttrDialog.area} readOnly className="w-full rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-slate-500" />
                </label>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setPolygonAttrDialog(null)} className="rounded border border-slate-200 px-3 py-1.5 hover:bg-slate-50">Cancel</button>
                  <button type="button" onClick={savePolygonAttrs} className="rounded bg-brand px-3 py-1.5 font-semibold text-white hover:bg-brand-dark">OK</button>
                </div>
              </div>
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
function iconZoomIn(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="2">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L21 21" strokeLinecap="round" />
      <path d="M7.5 10.5h6M10.5 7.5v6" strokeLinecap="round" />
    </svg>
  );
}
function iconZoomOut(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="2">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L21 21" strokeLinecap="round" />
      <path d="M7.5 10.5h6" strokeLinecap="round" />
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
function iconTables(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M3 10h18M3 16h18M9 4v16M15 4v16" strokeWidth="1.3" />
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
function iconDiagram(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.6">
      <rect x="3" y="3" width="18" height="18" rx="1.5" />
      <path d="M8 7l6-2 6 2.5-2 9-8 1z" fill={c} fillOpacity="0.15" />
      <path d="M6 17h5M6 19h3" strokeWidth="1.2" />
    </svg>
  );
}
