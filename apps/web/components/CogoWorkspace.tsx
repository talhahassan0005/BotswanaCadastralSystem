"use client";

// Cadastral work station (client req 2026-08-12): a window where all COGO
// calculations are conducted. Clicking the "COGO" button activates the
// workspace — imported points are plotted by name, each COGO tool is
// represented by an icon, and the cursor's world coordinates track live in
// the status bar, mirroring the reference CAD tool screenshots the client
// provided. A second toolbar row adds basic drafting (add/delete point,
// undo/redo, zoom-extents) so the canvas isn't view-only.

import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode, type WheelEvent as RWheelEvent } from "react";
import { CogoDrawingToolbar } from "@/components/CogoDrawingToolbar";
import { CogoCommandBar, type CogoCommandBarHandle } from "@/components/CogoCommandBar";
import { forward, inverse, polygonArea, formatArea } from "@/lib/server/geometry";
import { formatDms, normalizeDeg, parseBearing } from "@/lib/server/angles";
import { CogoTraversePanel } from "@/components/CogoTraversePanel";
import { CogoTablesPanel, type LineMeta, type PointMeta, type PolygonMeta } from "@/components/CogoTablesPanel";
import { useStore, type CogoPlot } from "@/lib/store";
import { detectRectangularLots } from "@/lib/plots";
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
// "select-box"/"select-lasso" (client req 2026-08-20, Part 10) are area
// multi-select modes — drag a rectangle / freehand outline to add every
// point (and, for the box, every fully-enclosed line/polygon) to the
// current canvasSelection, instead of the plain "select" tool's one-at-a-
// time click-to-add.
// "zoom-window" (client req 2026-08-20, Part 12a) drags the same rectangle
// as "select-box" but zooms the view to exactly that area instead of
// selecting what's inside it — the legacy "Zoom Window" tool.
// "query-point"/"query-line"/"query-parcel" and "delete-line"/"delete-parcel"
// (client req 2026-08-21, Part 15b-e) are dedicated single-click info/erase
// tools — click one feature to inspect (with inline rename for points) or
// immediately delete it, without building up a multi-select first.
type DraftTool =
  | "select" | "select-box" | "select-lasso" | "zoom-window" | "addpoint" | "move"
  | "line" | "polyline" | "curve" | "polygon" | "offset"
  | "query-point" | "query-line" | "query-parcel" | "delete-line" | "delete-parcel";
type DraftPt = { east: number; north: number; name: string; newId?: string };

// Edit Tools (Select/Add/Move/Delete/Undo/Redo/Zoom/Snap) stay permanently
// visible — they're used constantly regardless of which drawing category is
// open. Everything else is tabbed so the toolbar doesn't read as a wall of icons.
const TOOL_GROUPS = [
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
  resultBoundary,
}: {
  points: { name?: string | null; east: number; north: number }[];
  /** A computed traverse/coordinates result (client req 2026-08-21, Part
   *  13a) — when set, its boundary is drawn on the canvas (lines + bearing/
   *  distance labels + closed polygon), the same as a manually click-drawn
   *  one; when cleared (e.g. via "Clear Result"), that drawing is removed. */
  resultBoundary?: {
    points: { name: string | null; east: number; north: number }[];
    legs: { from: string | null; to: string | null; bearing_dms: string; distance: number }[];
    closed: boolean;
  } | null;
}) {
  const { config, setDiagramFigure, setDiagramInput, setActiveTab, cogoPlots, setCogoPlots, cogoWorkspaceDoc, setCogoWorkspaceDoc } = useStore();
  // Restore whatever was drawn here last time (client req 2026-08-23: a
  // polygon/line/point added in this work station must survive a refresh,
  // not need redoing) — read once, synchronously, as each piece of state's
  // own initial value below, so there's no flash of an empty canvas before
  // a later effect kicks in.
  const savedDoc = (cogoWorkspaceDoc ?? {}) as {
    extra?: WPoint[];
    hidden?: string[];
    lines?: WLine[];
    arcs?: WArc[];
    polygons?: WPolygon[];
    texts?: WText[];
    pointMeta?: Record<string, PointMeta>;
    lineMeta?: Record<string, LineMeta>;
    polygonMeta?: Record<string, PolygonMeta>;
    lastPlotNumber?: string | null;
  };
  const [active, setActive] = useState(false);
  // Which toolbar group's icon row is showing — a tab bar instead of 9
  // permanently-stacked rows, so the toolbar reads as one screenful instead
  // of a wall of icons (client req 2026-08-16).
  const [activeGroup, setActiveGroup] = useState<ToolGroupId>("point");
  const svgRef = useRef<SVGSVGElement>(null);
  const bulkImportInputRef = useRef<HTMLInputElement>(null);
  const [autoDetectStart, setAutoDetectStart] = useState("");
  const [view, setView] = useState({ cx: 0, cy: 0, zoom: 1 });
  // Display-only rotation (client req 2026-08-28: "add a rotator... 360
  // takay rotate kar sako", like an image editor's rotate control) lives in
  // `config.displayRotation` — a SHARED project-wide setting, not local view
  // state, so the same rotation the surveyor dials in here also applies in
  // Diagrams/Working Plan/General Plan (client req 2026-08-28: "rotated
  // diagram doesn't show... sirf cogo per hi rotate show hai"). Persisted
  // automatically with the rest of `config`, same as coordinateSystem etc.
  const rotation = config.displayRotation ?? 0;
  // Horizontal mirror (client req 2026-08-28) — rotation alone can never fix
  // a mirrored shape (no angle does that), so this covers that case too;
  // same shared, persisted, display-only setting as rotation above.
  const flip = config.displayFlip ?? false;
  const [cursor, setCursor] = useState<{ e: number; n: number } | null>(null);
  const pan = useRef<{ vbx: number; vby: number; cx: number; cy: number; moved: number } | null>(null);
  /** Middle-mouse-button press-and-hold pan (client req 2026-08-26, Part
   *  36) — deliberately a SEPARATE ref from `pan` above: `pan` doubles as
   *  every tool's own click/drag tracking (vertex placement, box-select,
   *  grip drags, ...), so routing the middle button through it risked a
   *  mid-draw click landing wherever the pan happened to end. This ref
   *  exists only to move the view; it never feeds any tool's click logic. */
  const middlePan = useRef<{ vbx: number; vby: number; cx: number; cy: number } | null>(null);
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
  const [extra, setExtra] = useState<WPoint[]>(savedDoc.extra ?? []);
  const [hidden, setHidden] = useState<Set<string>>(new Set(savedDoc.hidden ?? []));
  const [moving, setMoving] = useState<string | null>(null); // point picked up by the Move tool, awaiting drop
  const [snapEnabled, setSnapEnabled] = useState(false);
  // ---- Visibility toggles (client req 2026-08-21, Part 15a) ----
  const [showPointNames, setShowPointNames] = useState(true);
  const [showSegLabels, setShowSegLabels] = useState(true);
  const [showParcelNumbers, setShowParcelNumbers] = useState(true);
  // ---- Query tools (Part 15b-d) — info panel for whatever was last clicked
  // with the matching query tool active; pointQueryName is the editable
  // draft for the point panel's inline rename. ----
  const [pointQueryId, setPointQueryId] = useState<string | null>(null);
  const [pointQueryName, setPointQueryName] = useState("");
  const [lineQueryId, setLineQueryId] = useState<string | null>(null);
  const [parcelQueryId, setParcelQueryId] = useState<string | null>(null);
  // ---- click-to-draw state (Line/Polyline/Curve/Polygon/Offset) ----
  const [draft, setDraft] = useState<DraftPt[]>([]); // vertices placed so far for the active draw tool
  // Line/Polyline/Polygon must only ever join *existing* points — a click
  // that isn't near one is rejected rather than silently inventing a new
  // point (client req 2026-08-21, Part 22a). This flashes a brief on-screen
  // hint when that happens, instead of failing silently.
  const [snapMiss, setSnapMiss] = useState(false);
  const snapMissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function flashSnapMiss() {
    setSnapMiss(true);
    if (snapMissTimer.current) clearTimeout(snapMissTimer.current);
    snapMissTimer.current = setTimeout(() => setSnapMiss(false), 1600);
  }
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
  const [pointMeta, setPointMeta] = useState<Record<string, PointMeta>>(savedDoc.pointMeta ?? {});
  const [lineMeta, setLineMeta] = useState<Record<string, LineMeta>>(savedDoc.lineMeta ?? {});
  const [polygonMeta, setPolygonMeta] = useState<Record<string, PolygonMeta>>(savedDoc.polygonMeta ?? {});
  // Just Lot Number + (read-only) Area — the "ID / Erf" field was dropped
  // per client req 2026-08-24 ("I think we don't need that part, lets just
  // use Lot Number").
  const [polygonAttrDialog, setPolygonAttrDialog] = useState<{ id: string; position: string; area: string } | null>(null);
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
  // ---- Polygon completion dialog (client req 2026-08-21, Part 16c) — shown
  // when Calculate finishes a traverse: computed Area + an editable Erf/Plot
  // Number pre-filled with the next number after whichever was last
  // confirmed in this sheet. ----
  const [travCompleteDialog, setTravCompleteDialog] = useState<{ areaHa: string; plotNumber: string } | null>(null);
  const [lastPlotNumber, setLastPlotNumber] = useState<string | null>(savedDoc.lastPlotNumber ?? null);
  // ---- per-plot diagram generation (Part 7d): click a specific plot on the
  // canvas, confirm a scale, generate the Diagrams-tab sheet for just that plot. ----
  const [diagramPicking, setDiagramPicking] = useState(false);
  const [diagramPrompt, setDiagramPrompt] = useState<{ polygon: WPolygon; screenX: number; screenY: number; value: string } | null>(null);
  const [lines, setLines] = useState<WLine[]>(savedDoc.lines ?? []);
  const [arcs, setArcs] = useState<WArc[]>(savedDoc.arcs ?? []);
  const [polygons, setPolygons] = useState<WPolygon[]>(savedDoc.polygons ?? []);
  const [texts, setTexts] = useState<WText[]>(savedDoc.texts ?? []);
  const [selected, setSelected] = useState<string | null>(null);
  // ---- Multi-select (Part 10) — click-to-add / box-drag / lasso-drag build
  // up this set; Delete and (for points) Move act on it as a group. ----
  const [canvasSelection, setCanvasSelection] = useState<Set<string>>(new Set());
  const [rectSelect, setRectSelect] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [lassoPath, setLassoPath] = useState<{ x: number; y: number }[] | null>(null);
  const groupMoveOrigin = useRef<Record<string, { east: number; north: number }> | null>(null);
  // ---- Grip-based edit for a selected line (client req 2026-08-24, Part
  // 28 — matches the client's AutoCAD demo): once the Select tool has
  // exactly one line selected, draggable grips appear at its two endpoints
  // and midpoint. Dragging the midpoint grip MOVEs the whole line; dragging
  // an endpoint grip STRETCHes just that end (free length + angle, other
  // end fixed); holding Shift while dragging an endpoint grip ROTATEs the
  // whole line around the *other*, fixed end instead (length held constant
  // at its pre-drag value — only the angle changes), same distinction
  // AutoCAD draws between its Stretch and Rotate grip modes. `orig` is the
  // line's exact pre-drag geometry so Escape can revert to it outright.
  const [gripDrag, setGripDrag] = useState<{
    lineId: string;
    mode: "move" | "stretch-a" | "stretch-b" | "rotate-a" | "rotate-b";
    orig: WLine;
    startWorld: { e: number; n: number };
    lengthText: string;
    angleText: string;
  } | null>(null);
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
    // Part 10e: a multi-selection (box/lasso/click-to-add) deletes as a
    // group, across points/lines/polygons together; otherwise fall back to
    // the single last-clicked point (unchanged single-item behavior).
    if (canvasSelection.size) {
      snapshot();
      const lineIds = new Set<string>(), polyIds = new Set<string>(), pointIds = new Set<string>();
      canvasSelection.forEach((id) => {
        if (lines.some((l) => l.id === id)) lineIds.add(id);
        else if (polygons.some((p) => p.id === id)) polyIds.add(id);
        else pointIds.add(id);
      });
      if (pointIds.size) {
        setExtra((e) => e.filter((p) => !pointIds.has(p.id)));
        setHidden((h) => { const n = new Set(h); pointIds.forEach((id) => n.add(id)); return n; });
      }
      if (lineIds.size) setLines((ls) => ls.filter((l) => !lineIds.has(l.id)));
      if (polyIds.size) setPolygons((ps) => ps.filter((p) => !polyIds.has(p.id)));
      setCanvasSelection(new Set());
      setSelected(null);
      return;
    }
    if (!selected) return;
    snapshot();
    if (selected.startsWith("imp-")) setHidden((h) => new Set(h).add(selected));
    else setExtra((e) => e.filter((p) => p.id !== selected));
    setSelected(null);
  }
  function clearSelection() {
    setCanvasSelection(new Set());
    setSelected(null);
  }
  // ---- Point Query panel (Part 15b) ----
  function pointQueryStep(delta: 1 | -1) {
    if (!pointQueryId) return;
    const ids = visible.map((p) => p.id);
    const i = ids.indexOf(pointQueryId);
    if (i === -1) return;
    const nextId = ids[(i + delta + ids.length) % ids.length];
    const p = visible.find((pp) => pp.id === nextId);
    if (p) { setPointQueryId(nextId); setPointQueryName(p.name); }
  }
  function applyPointRename() {
    if (!pointQueryId) return;
    const name = pointQueryName.trim();
    if (!name) return;
    snapshot();
    if (pointQueryId.startsWith("imp-")) {
      const orig = basePoints.find((p) => p.id === pointQueryId);
      if (!orig) return;
      setHidden((h) => new Set(h).add(pointQueryId));
      const newId = `renamed-${Date.now()}`;
      setExtra((e) => [...e, { id: newId, name, east: orig.east, north: orig.north }]);
      setPointQueryId(newId);
    } else {
      setExtra((e) => e.map((p) => (p.id === pointQueryId ? { ...p, name } : p)));
    }
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
    const all = [...visible, ...linePts, ...arcPts, ...polyPts, ...textPts];
    if (!all.length) {
      // Previously a silent no-op — nothing visibly happened, which reads as
      // "the button is broken" (client report 2026-08-20). There's simply
      // nothing on the canvas to fit yet; say so instead of doing nothing.
      window.alert("Nothing to fit yet — import points or add one first, then Zoom to Extents.");
      return;
    }
    frameOn(all);
  }
  /** Zoom Window (Part 12a) — fits the view to exactly a dragged
   *  rectangle's world-space area, unlike frameOn's "everything with
   *  padding" fit. Uses per-axis zoom (not just the smaller dimension) so
   *  the whole dragged box — not just a square subset of it — fills the
   *  canvas, matching the legacy tool exactly. */
  function zoomToRect(sx1: number, sy1: number, sx2: number, sy2: number) {
    const [wx1, wy1] = toWorld(sx1, sy1);
    const [wx2, wy2] = toWorld(sx2, sy2);
    const cx = (wx1 + wx2) / 2, cy = (wy1 + wy2) / 2;
    const spanX = Math.max(Math.abs(wx2 - wx1), 0.01);
    const spanY = Math.max(Math.abs(wy2 - wy1), 0.01);
    const zoom = Math.min(50, Math.max(0.01, Math.min(W / spanX, H / spanY) * 0.95));
    if (Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(zoom)) setView({ cx, cy, zoom });
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

  function addToolResult(result: ToolResult): { pointIds: string[]; lineIds: string[]; polygonIds: string[] } {
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
    let polygonIds: string[] = [];
    if (result.polygons?.length) {
      polygonIds = result.polygons.map((_, i) => `poly-${now}-${polyIdRef.current + i}`);
      setPolygons((ps) => [...ps, ...result.polygons!.map((p, i) => ({ id: polygonIds[i], ...p }))]);
      polyIdRef.current += result.polygons.length;
      // Land Surveyor defaults to the project's configured surveyor (client
      // req 2026-08-24) — it's the same person for every plot in a project,
      // so retyping it per polygon was pure busywork. Only pre-fills it;
      // the Polygons table cell stays freely editable/overridable per plot.
      if (config.surveyor.trim()) {
        setPolygonMeta((m) => {
          const next = { ...m };
          for (const id of polygonIds) next[id] = { ...next[id], surveyor: next[id]?.surveyor ?? config.surveyor };
          return next;
        });
      }
    }
    if (result.texts?.length) {
      setTexts((ts) => [
        ...ts,
        ...result.texts!.map((t, i) => ({ ...t, id: `text-${now}-${textIdRef.current + i}`, size: t.size ?? 12 })),
      ]);
      textIdRef.current += result.texts.length;
    }
    return { pointIds, lineIds, polygonIds };
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
  /** Escape or the Cancel button. With vertices already placed, this only
   *  discards the in-progress shape and stays in the same draw tool — the
   *  client's "many plots back-to-back" workflow (Part 35) needs Escape to
   *  be usable as a plain mis-click recovery mid-shape without kicking the
   *  user out of Polygon/Line/Polyline/Curve mode entirely. With nothing
   *  drawn yet, there's no in-progress shape to discard, so this is read as
   *  a deliberate "stop drawing" instead and exits to Select. */
  function cancelDraft() {
    const newIds = new Set(draft.filter((d) => d.newId).map((d) => d.newId!));
    if (newIds.size) setExtra((e) => e.filter((p) => !newIds.has(p.id)));
    const hadVertices = draft.length > 0;
    setDraft([]);
    if (!hadVertices) setDraftTool("select");
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
    setRectSelect(null);
    setLassoPath(null);
    groupMoveOrigin.current = null;
    setPointQueryId(null);
    setLineQueryId(null);
    setParcelQueryId(null);
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
  function openPolygonAttrs(id: string, knownPoints?: { east: number; north: number }[]) {
    // `knownPoints`, when given, lets a caller open this dialog for a
    // polygon it JUST created in the same synchronous handler — `polygons`
    // state hasn't re-rendered yet at that point, so looking the id up in
    // it here would still see the old array and silently no-op.
    const poly = knownPoints ? { points: knownPoints } : polygons.find((p) => p.id === id);
    if (!poly) return;
    const m = polygonMeta[id] ?? {};
    const areaM2 = polygonArea(poly.points.map((v) => ({ east: v.east, north: v.north })));
    // Pre-fill Position with the auto-incremented next plot number (same
    // suggestion the Traverse panel's Calculate dialog uses, Part 16c) when
    // this polygon doesn't already have one — so a freshly-drawn/closed
    // polygon always opens with a sensible number ready to accept or edit,
    // instead of a blank field.
    const suggested = lastPlotNumber ? bumpPlotNumber(lastPlotNumber) : "";
    setPolygonAttrDialog({ id, position: m.position ?? suggested, area: formatArea(areaM2) });
  }
  function savePolygonAttrs() {
    if (!polygonAttrDialog) return;
    const { id, position } = polygonAttrDialog;
    setPolygonMeta((m) => ({ ...m, [id]: { ...m[id], position } }));
    if (position.trim()) {
      setLastPlotNumber(position.trim());
      const poly = polygons.find((p) => p.id === id);
      if (poly) savePlotNumber(position, poly.points);
    }
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
    setTexts((ts) => [...ts, { id: labelId, text: `${travDir}  ${travDist}m`, east: midE, north: midN, size: 11, kind: "seglabel", angle: segLabelAngle(travFrom, travPreview) }]);
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
  function bumpPlotNumber(s: string): string {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? String(n + 1) : s;
  }
  function travCalculate() {
    if (!travLegs.length || !travStartPoint) { window.alert("No legs entered yet."); return; }
    const boundary = [travStartPoint, ...travLegs.map((l) => l.point)];
    const areaHa = Math.abs(polygonArea(boundary.map((p) => ({ east: p.east, north: p.north })))) / 10000;
    setTravCompleteDialog({
      areaHa: areaHa.toFixed(4),
      plotNumber: lastPlotNumber ? bumpPlotNumber(lastPlotNumber) : "",
    });
  }
  /** Confirms the completion dialog (Part 16c) — builds the actual closed
   *  WPolygon for this traverse (previously Calculate never created one at
   *  all, just showed a summary), named with the Erf/Plot Number so it
   *  immediately shows up in the Polygons table (Part 9d) and is clickable
   *  by the Diagram tool (Part 7d). Remembers the number so the next plot
   *  in this sheet (Part 7c) suggests the following one. */
  function travCompleteConfirm() {
    if (!travCompleteDialog || !travStartPoint) return;
    const boundary = [travStartPoint, ...travLegs.map((l) => l.point)];
    const plotNumber = travCompleteDialog.plotNumber.trim();
    snapshot();
    const polyId = `travpoly-${Date.now()}`;
    const boundaryPts = boundary.map((p) => ({ name: p.name, east: p.east, north: p.north }));
    setPolygons((ps) => [...ps, { id: polyId, name: plotNumber || undefined, points: boundaryPts }]);
    // Land Surveyor defaults to the project's configured surveyor (client
    // req 2026-08-24) — same reasoning as addToolResult's polygon branch.
    if (config.surveyor.trim()) {
      setPolygonMeta((m) => ({ ...m, [polyId]: { ...m[polyId], surveyor: m[polyId]?.surveyor ?? config.surveyor } }));
    }
    if (plotNumber) {
      setPolygonMeta((m) => ({ ...m, [polyId]: { ...m[polyId], position: plotNumber } }));
      setLastPlotNumber(plotNumber);
      savePlotNumber(plotNumber, boundaryPts);
    }
    setTravCompleteDialog(null);
  }
  function travClose() {
    setTravOpen(false);
    setTravPickingStart(false);
    setTravChoosingTo(false);
    setTravEditIndex(null);
    setTravCompleteDialog(null);
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
  /** Screen-space point-in-polygon test — used by the freehand lasso select
   *  (Part 10a) to test each point's on-screen position against the dragged
   *  outline, and unrelated to `pointInPolygon`'s world-coordinate polygons. */
  function pointInScreenPolygon(sx: number, sy: number, path: { x: number; y: number }[]): boolean {
    let inside = false;
    for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
      const a = path[i], b = path[j];
      const hit = a.y > sy !== b.y > sy && sx < ((b.x - a.x) * (sy - a.y)) / (b.y - a.y) + a.x;
      if (hit) inside = !inside;
    }
    return inside;
  }
  /** Best-fit scale suggestion for the A4 SG sheet (client req 2026-08-21,
   *  Part 14) — the largest of the two axes' required scale, rounded up to
   *  a common survey scale so the boundary comfortably fits the sheet's
   *  drawable area. usableW/H_mm mirror SgDiagram.tsx's `fig`/`pad`
   *  constants converted to printed mm (keep in sync if those change). A
   *  LARGER scale number means a SMALLER drawing — dividing by it, not
   *  multiplying, is what keeps that relationship correct here. */
  function suggestScale(poly: WPolygon): number {
    const es = poly.points.map((p) => p.east), ns = poly.points.map((p) => p.north);
    const spanE = Math.max(...es) - Math.min(...es);
    const spanN = Math.max(...ns) - Math.min(...ns);
    const usableW_mm = 96, usableH_mm = 83;
    const sByWidth = spanE > 0 ? (spanE * 1000) / usableW_mm : 0;
    const sByHeight = spanN > 0 ? (spanN * 1000) / usableH_mm : 0;
    const raw = Math.max(sByWidth, sByHeight, 1);
    const NICE = [100, 200, 250, 500, 750, 1000, 1250, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000, 15000, 20000, 25000, 50000];
    return NICE.find((n) => n >= raw) ?? Math.ceil(raw / 1000) * 1000;
  }
  /** Builds the same closed-traverse shape the Diagrams tab draws from, out
   *  of any closed ring of points — shared by the canvas "Diagram" pick tool
   *  and by savePlotNumber below (client req 2026-08-21) so a plot numbered
   *  anywhere in the work station can be loaded by that number later. */
  function buildFigureFromPoints(pts: { name: string | null; east: number; north: number }[]): CogoResult {
    const legsOut: CogoLeg[] = pts.map((p, i) => {
      const next = pts[(i + 1) % pts.length];
      const [brg, dist] = inverse({ east: p.east, north: p.north }, { east: next.east, north: next.north });
      return { index: i + 1, from: p.name, to: next.name, bearing: brg, bearing_dms: formatDms(brg), distance: dist, d_east_adj: next.east - p.east, d_north_adj: next.north - p.north };
    });
    const areaM2 = Math.abs(polygonArea(pts));
    const perim = legsOut.reduce((s, l) => s + l.distance, 0);
    return {
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
  }
  /** Saves/updates a numbered plot in the project-wide store (client req
   *  2026-08-21) — called wherever a polygon gets a Lot/Erf number, so the
   *  Diagrams tab can pull it up later just by typing that number instead
   *  of re-navigating here and clicking it on the canvas. Upserts by number. */
  function savePlotNumber(number: string, pts: { name: string | null; east: number; north: number }[]) {
    const n = number.trim();
    if (!n || pts.length < 3) return;
    const fig = buildFigureFromPoints(pts);
    setCogoPlots([...cogoPlots.filter((p) => p.number !== n), { number: n, fig }]);
  }
  /** Bulk-creates many numbered plots at once from a CSV (client req
   *  2026-08-28: no format anywhere populates `cogoPlots` in bulk — every
   *  plot otherwise needs its own manual draw-then-number pass through the
   *  UI, which doesn't scale to a real subdivision with dozens/hundreds of
   *  lots). CSV columns: lot, name, east, north — rows sharing a `lot`
   *  value become one plot's boundary ring, in the order they appear.
   *  Computes the WHOLE next cogoPlots array in one pass and calls
   *  setCogoPlots exactly once — looping savePlotNumber (which reads
   *  `cogoPlots` from this render's closure) would have each iteration
   *  overwrite the previous one's update with stale state instead of
   *  accumulating, since React batches these into one re-render. */
  function bulkImportPlots(csvText: string): { imported: number; skipped: number; error?: string } {
    const lines = csvText.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) return { imported: 0, skipped: 0, error: "Empty file" };
    const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const lotIdx = header.indexOf("lot");
    const nameIdx = header.indexOf("name");
    const eastIdx = header.indexOf("east");
    const northIdx = header.indexOf("north");
    if (lotIdx === -1 || eastIdx === -1 || northIdx === -1) {
      return { imported: 0, skipped: 0, error: 'CSV must have "lot", "east", "north" columns (and optionally "name")' };
    }
    const byLot = new Map<string, { name: string | null; east: number; north: number }[]>();
    let skipped = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map((c) => c.trim());
      const lot = cols[lotIdx];
      const east = Number(cols[eastIdx]);
      const north = Number(cols[northIdx]);
      if (!lot || !Number.isFinite(east) || !Number.isFinite(north)) { skipped++; continue; }
      if (!byLot.has(lot)) byLot.set(lot, []);
      byLot.get(lot)!.push({ name: (nameIdx !== -1 && cols[nameIdx]) || null, east, north });
    }
    const newPlots: CogoPlot[] = [];
    for (const [lot, pts] of byLot) {
      if (pts.length < 3) { skipped += pts.length; continue; }
      newPlots.push({ number: lot, fig: buildFigureFromPoints(pts) });
    }
    if (!newPlots.length) return { imported: 0, skipped, error: "No valid plots (need >=3 points per lot)" };
    const importedLotSet = new Set(newPlots.map((p) => p.number));
    setCogoPlots([...cogoPlots.filter((p) => !importedLotSet.has(p.number)), ...newPlots]);
    frameOn(newPlots.flatMap((p) => p.fig.points.map((pt) => ({ id: `bulk-${p.number}-${pt.name}`, name: pt.name ?? "", east: pt.east, north: pt.north }))));
    return { imported: newPlots.length, skipped };
  }
  /** Auto-builds numbered plots straight from whatever points are currently
   *  on the canvas (client req 2026-08-28) — real client data is often just a
   *  flat "name, east, north" beacon list with NO lot-grouping column at all
   *  (unlike Bulk Import's CSV format above), too many points to draw one
   *  Polygon-tool click at a time for a real subdivision. Only works for a
   *  rectilinear grid layout (every lot an axis-aligned rectangle) — see
   *  `detectRectangularLots` in lib/plots.ts for the reconstruction logic and
   *  its limits. Detected lots are numbered sequentially from `startNumber`
   *  in reading order (top row first, left to right within a row); anything
   *  left over (outer parent-boundary beacons, block corners, splayed corner
   *  lots) isn't touched here — draw those few by hand with Polygon Tools.
   *  An empty "Starting lot #" field falls back to a sensible default
   *  (continuing from the highest numbered plot already in the project, or
   *  1) rather than blocking with an error — client req 2026-08-30: typing
   *  a number first shouldn't be required just to try the tool, and this
   *  field was easily confused with the sidebar's unrelated "Starting
   *  beacon" field. Only genuinely unparseable typed input (not blank) is
   *  still rejected. */
  function suggestedNextLotStart(): number {
    const existing = cogoPlots.map((p) => parseInt(p.number, 10)).filter(Number.isFinite);
    return existing.length ? Math.max(...existing) + 1 : 1;
  }
  function autoDetectLots(startNumber: string) {
    const trimmed = startNumber.trim();
    const typedStart = trimmed ? parseInt(trimmed, 10) : null;
    if (trimmed && !Number.isFinite(typedStart)) {
      window.alert("That starting lot number isn't valid — enter a whole number, or leave it blank to use a default.");
      return;
    }
    // Running this a second time on the same canvas re-detects the SAME
    // rectangles and, with a fresh start number, saves them all again under
    // new numbers — silently doubling every lot (client req 2026-08-30: two
    // runs left 532 lots where the data only holds 266, so every sheet drew
    // each lot twice, stacked). Offer to replace instead of piling up.
    const replaceExisting =
      cogoPlots.length > 0 &&
      window.confirm(
        `This project already has ${cogoPlots.length} numbered lot(s).\n\n` +
        `OK = replace them with the newly detected lots (recommended — re-running on the same points otherwise saves a duplicate copy of every lot under new numbers).\n` +
        `Cancel = keep the existing ones and add these alongside.`
      );
    // A blank field continues past the highest existing lot number — but when
    // replacing those, there's nothing left to continue past, so start at 1.
    const start = typedStart ?? (replaceExisting ? 1 : suggestedNextLotStart());
    const source = visible.map((p) => ({ name: p.name || null, east: p.east, north: p.north }));
    const { lots, usedPointCount } = detectRectangularLots(source);
    if (!lots.length) {
      window.alert("No rectangular lots could be detected in the points currently on the canvas.");
      return;
    }
    const ordered = [...lots].sort((a, b) => {
      const aN = Math.max(...a.points.map((p) => p.north));
      const bN = Math.max(...b.points.map((p) => p.north));
      if (Math.abs(aN - bN) > 0.5) return bN - aN;
      const aE = Math.min(...a.points.map((p) => p.east));
      const bE = Math.min(...b.points.map((p) => p.east));
      return aE - bE;
    });
    const newPlots: CogoPlot[] = ordered.map((lot, i) => ({ number: String(start + i), fig: buildFigureFromPoints(lot.points) }));
    const importedSet = new Set(newPlots.map((p) => p.number));
    const kept = replaceExisting ? [] : cogoPlots.filter((p) => !importedSet.has(p.number));
    setCogoPlots([...kept, ...newPlots]);
    const leftover = source.length - usedPointCount;
    // Flag lots much bigger than the typical detected lot — the elementary-
    // rectangle check rejects most false positives, but a beacon that's
    // missing or mis-tagged can still make it silently swallow two real lots
    // into one oversized rectangle. Report these instead of trusting them
    // blindly, so the user knows exactly which plot numbers to re-check.
    const areasSorted = [...newPlots].sort((a, b) => a.fig.area_m2 - b.fig.area_m2);
    const medianArea = areasSorted[Math.floor(areasSorted.length / 2)].fig.area_m2;
    const suspicious = newPlots.filter((p) => p.fig.area_m2 > medianArea * 3);
    window.alert(
      `Detected ${newPlots.length} rectangular lots, numbered ${start}-${start + newPlots.length - 1}.\n` +
      `${leftover} point(s) were not part of any detected rectangle (outer boundary, block corners, or irregular/splayed corner lots) — add those manually with Polygon Tools.\n` +
      (suspicious.length
        ? `Double-check these — much bigger than the typical lot here, may have merged two real lots: ${suspicious.map((p) => p.number).join(", ")}.\n`
        : "") +
      `Rename any individual plot by re-drawing it with Polygon Tools and entering the correct number.`
    );
  }
  function diagramPickAt(sx: number, sy: number, screenX: number, screenY: number) {
    const [wx, wy] = toWorld(sx, sy);
    const hit = polygons.find((p) => pointInPolygon(wx, wy, p));
    setDiagramPicking(false);
    if (!hit) { window.alert("Click inside one of the drawn plots (polygons) to generate its diagram."); return; }
    setDiagramPrompt({ polygon: hit, screenX, screenY, value: String(suggestScale(hit)) });
  }
  function diagramConfirm() {
    if (!diagramPrompt) return;
    const scale = Number(diagramPrompt.value) || 2000;
    const poly = diagramPrompt.polygon;
    const areaM2 = Math.abs(polygonArea(poly.points));
    const fig = buildFigureFromPoints(poly.points);
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
      const [a, b] = pts;
      addToolResult({
        lines: [{ aE: a.east, aN: a.north, bE: b.east, bN: b.north }],
        texts: [{ text: segLabel(a, b), east: (a.east + b.east) / 2, north: (a.north + b.north) / 2, size: 11, kind: "seglabel", angle: segLabelAngle(a, b) }],
      });
    } else if (draftTool === "polyline" && pts.length >= 2) {
      const segs: NonNullable<ToolResult["lines"]> = [];
      const texts: NonNullable<ToolResult["texts"]> = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        segs.push({ aE: a.east, aN: a.north, bE: b.east, bN: b.north });
        texts.push({ text: segLabel(a, b), east: (a.east + b.east) / 2, north: (a.north + b.north) / 2, size: 11, kind: "seglabel", angle: segLabelAngle(a, b) });
      }
      addToolResult({ lines: segs, texts });
    } else if (draftTool === "polygon" && pts.length >= 3) {
      const segs: NonNullable<ToolResult["lines"]> = [];
      const texts: NonNullable<ToolResult["texts"]> = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        segs.push({ aE: a.east, aN: a.north, bE: b.east, bN: b.north });
        texts.push({ text: segLabel(a, b), east: (a.east + b.east) / 2, north: (a.north + b.north) / 2, size: 11, kind: "seglabel", angle: segLabelAngle(a, b) });
      }
      const { polygonIds } = addToolResult({ lines: segs, polygons: [{ points: pts.map((p) => ({ name: p.name, east: p.east, north: p.north })) }], texts });
      // Client req 2026-08-21: finishing a click-to-draw Polygon should ask
      // for the Lot/Erf number the same way the Traverse panel's Calculate
      // does (Part 16c) — reusing the existing Polygon Attributes dialog
      // (Part 9f) instead of a separate one, pre-filled with the
      // auto-incremented suggestion.
      if (polygonIds[0]) openPolygonAttrs(polygonIds[0], pts);
    } else if (draftTool === "curve" && pts.length >= 3) {
      // Click order: start, end, a point on the arc between them.
      try {
        const result = curveMath.arcBy3Points({
          pointA: { id: "a", name: "A", east: pts[0].east, north: pts[0].north },
          pointB: { id: "m", name: "M", east: pts[2].east, north: pts[2].north },
          pointC: { id: "b", name: "B", east: pts[1].east, north: pts[1].north },
        });
        const [a, b] = pts;
        result.texts = [
          ...(result.texts ?? []),
          { text: `${segLabel(a, b)} (chord)`, east: (a.east + b.east) / 2, north: (a.north + b.north) / 2, size: 11, kind: "seglabel", angle: segLabelAngle(a, b) },
        ];
        addToolResult(result);
      } catch (e: any) {
        window.alert(e.message ?? String(e));
      }
    }
    // Stay in the same draw tool after Finish (client req 2026-08-26, Part
    // 35: "many plots back-to-back" — with potentially 200 plots in one
    // layout, forcing a re-click on the toolbar icon after every single one
    // was impractical). Only the in-progress vertices reset; the tool
    // itself only deactivates via activateDrawTool (switching tools) or
    // cancelDraft with nothing drawn yet (a deliberate "stop drawing").
    setDraft([]);
  }
  function finishDraft() {
    finishDraftWith(draft);
  }

  // Persist everything drawn here into the project bundle (client req
  // 2026-08-23) — picked up automatically by the store's existing
  // autosave, and restored above via `savedDoc` on next mount/refresh, so
  // a polygon built in this work station is still there afterwards
  // instead of needing to be redrawn from scratch.
  //
  // Skips its very first LOGICAL invocation (mount): this component and
  // the store's own restore-on-mount effect (in StoreProvider, an
  // ancestor) both fire in the same commit — React runs child effects
  // before parent effects, so without this guard this effect would fire
  // first with this component's still-empty freshly-initialised state and
  // stomp the restore's ref write with an empty placeholder moments
  // before the parent even reads localStorage.
  //
  // React 18 Strict Mode (dev only) complicates "skip the first call": it
  // double-invokes a fresh effect (mount, run, simulate-cleanup, run
  // again) using the SAME captured closure both times. A plain boolean
  // flag either lets the 2nd call slip through (if nothing re-arms it,
  // stomping the restore anyway) or, if a naive cleanup re-arms it, ends
  // up re-arming on every *real* subsequent change too (cleanup runs
  // before every re-invocation, not just Strict Mode's simulated one),
  // which never lets a real change through again — either way broken.
  // Deduplicating by comparing this run's values against the last-seen
  // ones (Strict Mode's replay passes byte-for-byte identical references)
  // correctly collapses the replay into the same single skip without
  // needing a cleanup at all, while still writing every later *real* change.
  const lastPersistValuesRef = useRef<unknown[] | null>(null);
  const persistCallCountRef = useRef(0);
  useEffect(() => {
    const cur = [extra, hidden, lines, arcs, polygons, texts, pointMeta, lineMeta, polygonMeta, lastPlotNumber];
    const isStrictModeReplay = lastPersistValuesRef.current !== null && cur.every((v, i) => v === lastPersistValuesRef.current![i]);
    lastPersistValuesRef.current = cur;
    if (isStrictModeReplay) return;
    persistCallCountRef.current += 1;
    if (persistCallCountRef.current === 1) return; // first genuine invocation (mount) — may race the restore, skip it
    setCogoWorkspaceDoc({
      extra,
      hidden: Array.from(hidden),
      lines,
      arcs,
      polygons,
      texts,
      pointMeta,
      lineMeta,
      polygonMeta,
      lastPlotNumber,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extra, hidden, lines, arcs, polygons, texts, pointMeta, lineMeta, polygonMeta, lastPlotNumber]);

  // Auto-frame the imported points whenever the point set changes size (e.g. a
  // fresh import) so newly loaded beacons are visible without manual panning.
  useEffect(() => {
    if (!basePoints.length || basePoints.length === framedCount.current) return;
    framedCount.current = basePoints.length;
    frameOn(basePoints);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points]);

  // Draw a computed traverse/coordinates result on the canvas (Part 13a) —
  // lines + bearing/distance labels (same style as a manually click-drawn
  // shape, Part 11) plus a closed polygon. Runs once per distinct result
  // object (resultBoundary is memoized by the caller), so it doesn't
  // re-inject on every unrelated re-render. "cogores-" ids let this cleanly
  // remove only ITS OWN geometry — never anything the user drew by hand —
  // both when a new result replaces the old one and when it's cleared to null.
  useEffect(() => {
    setLines((ls) => ls.filter((l) => !l.id.startsWith("cogores-")));
    setPolygons((ps) => ps.filter((p) => !p.id.startsWith("cogores-")));
    setTexts((ts) => ts.filter((t) => !t.id.startsWith("cogores-")));
    if (!resultBoundary || !resultBoundary.points.length) return;
    const byName = new Map(resultBoundary.points.map((p) => [p.name, p]));
    const now = Date.now();
    const newLines: WLine[] = [];
    const newTexts: WText[] = [];
    // A bearing/distance label per leg is readable for a normal traverse, but
    // a computation run over a whole raw multi-lot import produces one per
    // leg for hundreds of legs — they overlap into an unreadable mass that
    // buries the geometry underneath (client req 2026-08-30: "diagram mess ki
    // tarah show ku ho rahi hain"). Past this many legs the labels carry no
    // usable information anyway (the Adjusted Traverse Table below lists
    // every one), so only the lines/polygon are drawn.
    const MAX_SEG_LABELS = 60;
    const labelLegs = resultBoundary.legs.length <= MAX_SEG_LABELS;
    resultBoundary.legs.forEach((lg, i) => {
      const a = lg.from ? byName.get(lg.from) : null;
      const b = lg.to ? byName.get(lg.to) : null;
      if (!a || !b) return;
      newLines.push({ id: `cogores-line-${now}-${i}`, aE: a.east, aN: a.north, bE: b.east, bN: b.north });
      if (!labelLegs) return;
      newTexts.push({
        id: `cogores-text-${now}-${i}`,
        text: `${lg.bearing_dms}  ${lg.distance.toFixed(2)}m`,
        east: (a.east + b.east) / 2,
        north: (a.north + b.north) / 2,
        size: 11,
        kind: "seglabel",
        angle: segLabelAngle(a, b),
      });
    });
    setLines((ls) => [...ls, ...newLines]);
    setTexts((ts) => [...ts, ...newTexts]);
    if (resultBoundary.closed && resultBoundary.points.length >= 3) {
      const polyId = `cogores-poly-${now}`;
      setPolygons((ps) => [
        ...ps,
        { id: polyId, points: resultBoundary.points.map((p) => ({ name: p.name ?? "", east: p.east, north: p.north })) },
      ]);
      // Land Surveyor defaults to the project's configured surveyor (client
      // req 2026-08-24) — same reasoning as the other polygon-creation paths.
      if (config.surveyor.trim()) {
        setPolygonMeta((m) => ({ ...m, [polyId]: { ...m[polyId], surveyor: config.surveyor } }));
      }
    }
    frameOn(resultBoundary.points.map((p, i) => ({ id: `cogores-frame-${i}`, name: p.name ?? "", east: p.east, north: p.north })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultBoundary]);

  // (Reverted 2026-08-28 — client comparison against InfoMate/Compuplot,
  // same project's own coordinate list, showed the flip below was WRONG: the
  // east/north values already plot correctly with the plain north-up screen
  // convention, no sign correction needed. The removed flip was added
  // 2026-08-27 on the theory that raw Lo-grid coordinates land in `north`
  // unmodified and need mirroring to match a north-up reference — that
  // theory doesn't hold for COGO-computed traverses: `forward()`/`inverse()`
  // in lib/server/geometry.ts already use the standard clockwise-from-north
  // convention (east += dist*sin(bearing), north += dist*cos(bearing)), so
  // `east`/`north` here are true easting/northing regardless of the
  // project's CRS label, and the extra flip just mirrored an already-correct
  // shape.)
  // View rotation (client req 2026-08-28) is applied AFTER the north-up
  // pan/zoom projection above, spinning the whole screen around its centre
  // — same order an image editor's rotate control would use. Kept as a
  // separate step (not folded into the pan/zoom maths) so the "north-up by
  // default" correctness above stays untouched; rotation is purely how it's
  // displayed.
  const rotRad = (rotation * Math.PI) / 180;
  const cosR = Math.cos(rotRad), sinR = Math.sin(rotRad);
  // Order: pan/zoom -> flip (mirror x around the screen centre) -> rotate.
  // Fixed points drawn from plain x,y numbers here, not an SVG-level
  // `scale(-1,1)` transform, so a flip never mirrors text glyphs backwards —
  // only where each point lands changes.
  const toScreen = (e: number, n: number): [number, number] => {
    const y = H / 2 - (n - view.cy) * view.zoom;
    let x = (e - view.cx) * view.zoom + W / 2;
    if (flip) x = W - x;
    if (!rotation) return [x, y];
    const dx = x - W / 2, dy = y - H / 2;
    return [W / 2 + dx * cosR - dy * sinR, H / 2 + dx * sinR + dy * cosR];
  };
  const toWorld = (sx: number, sy: number): [number, number] => {
    let x = sx, y = sy;
    if (rotation) {
      const dx = sx - W / 2, dy = sy - H / 2;
      // Inverse rotation (-angle): swap the sine's sign.
      x = W / 2 + dx * cosR + dy * sinR;
      y = H / 2 - dx * sinR + dy * cosR;
    }
    if (flip) x = W - x;
    return [view.cx + (x - W / 2) / view.zoom, view.cy - (y - H / 2) / view.zoom];
  };
  function eventToVb(ev: RPointerEvent | RWheelEvent): [number, number] {
    const r = svgRef.current!.getBoundingClientRect();
    return [((ev.clientX - r.left) / r.width) * W, ((ev.clientY - r.top) / r.height) * H];
  }
  /** Bearing + distance text for a segment, matching the traverse panel's
   *  on-line label convention (client req 2026-08-20, Part 11). */
  function segLabel(a: { east: number; north: number }, b: { east: number; north: number }): string {
    const [brg, dist] = inverse(a, b);
    return `${formatDms(brg)}  ${dist.toFixed(2)}m`;
  }
  /** On-screen rotation for a segment's label so it runs along the segment
   *  itself (client req 2026-08-26) instead of always sitting flat/
   *  horizontal. Screen Y is flipped relative to north, so the north delta's
   *  sign flips too; clamped to ±90° so the text reads upright regardless of
   *  which endpoint is "a" and which is "b". Depends only on the direction
   *  between the two points, not on pan/zoom, so it's safe to compute once
   *  at creation time. */
  function segLabelAngle(a: { east: number; north: number }, b: { east: number; north: number }): number {
    const dN = b.north - a.north;
    // + rotation (client req 2026-08-28): the shared display-rotation spins
    // the whole screen, so a label's on-screen angle must follow it too, or
    // text would stay tilted to the old, un-rotated orientation while the
    // line it labels visibly rotates underneath it.
    // flip mirrors the screen-x sense (client req 2026-08-28), which negates
    // the angle measured from horizontal — negate the east delta to match.
    const dE = b.east - a.east;
    let deg = (Math.atan2(-dN, flip ? -dE : dE) * 180) / Math.PI + rotation;
    deg = (((deg + 180) % 360) + 360) % 360 - 180; // normalize to (-180, 180]
    if (deg > 90) deg -= 180;
    if (deg < -90) deg += 180;
    return deg;
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
  // Point-to-point snap is even more generous than line/grid snap: since
  // Line/Polyline/Polygon now refuse to invent a new point on a miss
  // (Part 22a), an accidental near-miss must still reliably land on the
  // intended point rather than falling through and doing nothing.
  const POINT_SNAP_PX = 22;
  /** Nearest existing point within snap radius (screen space), if any. Point
   *  snapping is always on while drawing — needed to close traverses/
   *  polygons cleanly onto an existing vertex. */
  function snapPoint(sx: number, sy: number): WPoint | null {
    let best: WPoint | null = null;
    let bestD = POINT_SNAP_PX * POINT_SNAP_PX;
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

  /** Picks up a grip on `line` — stopPropagation keeps the root <svg>'s own
   *  onPointerDown from also firing (which would otherwise start a view-pan,
   *  since dragging the canvas pans by default outside a draw tool). Pointer
   *  capture is taken on the grip element itself so drag events keep
   *  reaching it (and, via bubbling, the onPointerMove/onPointerUp handlers
   *  below) even once the cursor moves off the small grip hit-target. */
  function startGripDrag(line: WLine, mode: "move" | "stretch-a" | "stretch-b" | "rotate-a" | "rotate-b", ev: RPointerEvent) {
    ev.stopPropagation();
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
    snapshot();
    const [vbx, vby] = eventToVb(ev);
    const [wx, wy] = toWorld(vbx, vby);
    const [brg, dist] = inverse({ east: line.aE, north: line.aN }, { east: line.bE, north: line.bN });
    setGripDrag({
      lineId: line.id,
      mode,
      orig: { ...line },
      startWorld: { e: wx, n: wy },
      lengthText: dist.toFixed(3),
      angleText: formatDms(brg),
    });
  }
  /** Commits the grip drag's typed Length/Angle readout (client req
   *  2026-08-24: "type an exact value instead of dragging by eye"),
   *  matching AutoCAD's dynamic-input Enter behavior — ends the drag at
   *  exactly the typed values rather than wherever the mouse happens to be. */
  function applyGripReadout() {
    if (!gripDrag || gripDrag.mode === "move") return;
    const dist = Number(gripDrag.lengthText);
    if (!Number.isFinite(dist) || dist <= 0) return;
    let brg: number;
    try {
      brg = parseBearing(gripDrag.angleText);
    } catch {
      return;
    }
    const { orig, mode, lineId } = gripDrag;
    const isA = mode === "stretch-a" || mode === "rotate-a";
    const pivot = isA ? { east: orig.bE, north: orig.bN } : { east: orig.aE, north: orig.aN };
    const np = forward(pivot, brg, dist);
    setLines((ls) => ls.map((l) => (l.id === lineId ? (isA ? { ...l, aE: np.east, aN: np.north } : { ...l, bE: np.east, bN: np.north }) : l)));
    setGripDrag(null);
  }
  function cancelGripDrag() {
    if (!gripDrag) return;
    setLines((ls) => ls.map((l) => (l.id === gripDrag.lineId ? gripDrag.orig : l)));
    setGripDrag(null);
  }

  function onPointerMove(ev: RPointerEvent<SVGSVGElement>) {
    const [vbx, vby] = eventToVb(ev);
    const [e, n] = toWorld(vbx, vby);
    setCursor({ e, n });
    if (middlePan.current) {
      const dx = (vbx - middlePan.current.vbx) / view.zoom;
      const dy = (vby - middlePan.current.vby) / view.zoom;
      setView((v) => ({ ...v, cx: middlePan.current!.cx - dx, cy: middlePan.current!.cy + dy }));
      return;
    }
    if (gripDrag) {
      const [wx, wy] = toWorld(vbx, vby);
      const { orig, mode, lineId } = gripDrag;
      if (mode === "move") {
        const dE = wx - gripDrag.startWorld.e, dN = wy - gripDrag.startWorld.n;
        setLines((ls) => ls.map((l) => (l.id === lineId ? { ...l, aE: orig.aE + dE, aN: orig.aN + dN, bE: orig.bE + dE, bN: orig.bN + dN } : l)));
      } else if (mode === "stretch-a" || mode === "stretch-b") {
        const isA = mode === "stretch-a";
        const pivot = isA ? { east: orig.bE, north: orig.bN } : { east: orig.aE, north: orig.aN };
        const [brg, dist] = inverse(pivot, { east: wx, north: wy });
        setLines((ls) => ls.map((l) => (l.id === lineId ? (isA ? { ...l, aE: wx, aN: wy } : { ...l, bE: wx, bN: wy }) : l)));
        setGripDrag((g) => (g ? { ...g, lengthText: dist.toFixed(3), angleText: formatDms(brg) } : g));
      } else {
        // rotate-a / rotate-b: length stays fixed at the pre-drag value —
        // only the angle around the OTHER (fixed) endpoint follows the mouse.
        const isA = mode === "rotate-a";
        const pivot = isA ? { east: orig.bE, north: orig.bN } : { east: orig.aE, north: orig.aN };
        const [, origDist] = inverse(pivot, isA ? { east: orig.aE, north: orig.aN } : { east: orig.bE, north: orig.bN });
        const [brgToMouse] = inverse(pivot, { east: wx, north: wy });
        const np = forward(pivot, brgToMouse, origDist);
        setLines((ls) => ls.map((l) => (l.id === lineId ? (isA ? { ...l, aE: np.east, aN: np.north } : { ...l, bE: np.east, bN: np.north }) : l)));
        setGripDrag((g) => (g ? { ...g, lengthText: origDist.toFixed(3), angleText: formatDms(brgToMouse) } : g));
      }
      return;
    }
    if (pan.current) {
      pan.current.moved += Math.abs(vbx - pan.current.vbx) + Math.abs(vby - pan.current.vby);
      if (draftTool === "select-box" || draftTool === "zoom-window") {
        setRectSelect((r) => (r ? { ...r, x2: vbx, y2: vby } : r));
      } else if (draftTool === "select-lasso") {
        setLassoPath((p) => (p ? [...p, { x: vbx, y: vby }] : p));
      } else {
        const dx = (vbx - pan.current.vbx) / view.zoom;
        const dy = (vby - pan.current.vby) / view.zoom;
        setView((v) => ({ ...v, cx: pan.current!.cx - dx, cy: pan.current!.cy + dy }));
      }
    }
  }
  function onPointerDown(ev: RPointerEvent<SVGSVGElement>) {
    svgRef.current?.setPointerCapture(ev.pointerId);
    const [vbx, vby] = eventToVb(ev);
    // Middle-button press-and-hold pan (client req 2026-08-26, Part 36) —
    // works no matter which tool is active, and returns immediately so it
    // never reaches any tool's own click/vertex-placement logic below
    // (a mid-draw polygon must not lose or misplace a vertex to a pan).
    if (ev.button === 1) {
      ev.preventDefault();
      middlePan.current = { vbx, vby, cx: view.cx, cy: view.cy };
      return;
    }
    pan.current = { vbx, vby, cx: view.cx, cy: view.cy, moved: 0 };
    if (draftTool === "select-box" || draftTool === "zoom-window") setRectSelect({ x1: vbx, y1: vby, x2: vbx, y2: vby });
    else if (draftTool === "select-lasso") setLassoPath([{ x: vbx, y: vby }]);
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
    if (middlePan.current) {
      middlePan.current = null;
      return;
    }
    if (gripDrag) {
      // The dragged line was already committed live on every pointermove
      // above — releasing just ends the drag session at wherever it landed
      // (client req 2026-08-24: "Confirm the edit on release").
      setGripDrag(null);
      return;
    }
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
          if (hit) {
            setMoving(hit.id);
            setSelected(hit.id);
            setMoveCoordInput({ east: hit.east.toFixed(3), north: hit.north.toFixed(3) });
            // Part 10e: picking up a point that's part of the current
            // multi-selection moves the whole group together by the same delta.
            if (canvasSelection.size > 1 && canvasSelection.has(hit.id)) {
              const origin: Record<string, { east: number; north: number }> = {};
              visible.forEach((p) => { if (canvasSelection.has(p.id)) origin[p.id] = { east: p.east, north: p.north }; });
              groupMoveOrigin.current = origin;
            } else {
              groupMoveOrigin.current = null;
            }
          }
        } else {
          const [wx, wy] = snapWorld(...toWorld(vbx, vby));
          snapshot();
          const anchorOrig = groupMoveOrigin.current?.[moving];
          if (anchorOrig && groupMoveOrigin.current) {
            const dE = wx - anchorOrig.east, dN = wy - anchorOrig.north;
            const origin = groupMoveOrigin.current;
            const impIds = Object.keys(origin).filter((id) => id.startsWith("imp-"));
            if (impIds.length) setHidden((h) => { const n = new Set(h); impIds.forEach((id) => n.add(id)); return n; });
            setExtra((e) => {
              const moved = e.map((p) => (origin[p.id] ? { ...p, east: origin[p.id].east + dE, north: origin[p.id].north + dN } : p));
              const newImp = impIds.map((id) => {
                const bp = basePoints.find((p) => p.id === id);
                return { id: `moved-${Date.now()}-${id}`, name: bp?.name ?? "Moved", east: origin[id].east + dE, north: origin[id].north + dN };
              });
              return [...moved, ...newImp];
            });
          } else if (moving.startsWith("imp-")) {
            const orig = basePoints.find((p) => p.id === moving);
            setHidden((h) => new Set(h).add(moving));
            setExtra((e) => [...e, { id: `moved-${Date.now()}`, name: orig?.name ?? "Moved", east: wx, north: wy }]);
          } else {
            setExtra((e) => e.map((p) => (p.id === moving ? { ...p, east: wx, north: wy } : p)));
          }
          setMoving(null);
          setSelected(null);
          setMoveCoordInput(null);
          groupMoveOrigin.current = null;
        }
      } else if (draftTool === "line") {
        // Line joins two *existing* points only — never invents one on a
        // miss (client req 2026-08-21, Part 22a). Curve is unaffected: it
        // still plots free points, per the original Part 1 spec.
        const v = resolveVertex(vbx, vby);
        if (!v.existingId) { flashSnapMiss(); }
        else {
          const nextDraft = [...draft, addVertexPoint(v)];
          if (nextDraft.length >= 2) finishDraftWith(nextDraft);
          else setDraft(nextDraft);
        }
      } else if (draftTool === "curve") {
        const vertex = addVertexPoint(resolveVertex(vbx, vby));
        const nextDraft = [...draft, vertex];
        if (nextDraft.length >= 3) finishDraftWith(nextDraft);
        else setDraft(nextDraft);
      } else if (draftTool === "polyline" || draftTool === "polygon") {
        // Same existing-point-only rule as Line (Part 22a) — a click that
        // isn't near a real point does nothing rather than creating a
        // stray vertex like the reported "T5" point.
        const v = resolveVertex(vbx, vby);
        if (!v.existingId) flashSnapMiss();
        else setDraft((d) => [...d, addVertexPoint(v)]);
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
      } else if (draftTool === "zoom-window") {
        // A plain click (not a drag) in Zoom Window mode does nothing —
        // the tool only acts on a dragged rectangle (see the drag-end
        // branch below), same as Box Select.
      } else if (draftTool === "query-point") {
        const hit = nearestVisible(vbx, vby);
        if (hit) { setPointQueryId(hit.id); setPointQueryName(hit.name); }
      } else if (draftTool === "query-line") {
        const hit = nearestLineHit(vbx, vby);
        if (hit) setLineQueryId(hit.id);
      } else if (draftTool === "query-parcel") {
        const [wx, wy] = toWorld(vbx, vby);
        const hit = polygons.find((p) => pointInPolygon(wx, wy, p));
        if (hit) setParcelQueryId(hit.id);
      } else if (draftTool === "delete-line") {
        const hit = nearestLineHit(vbx, vby);
        if (hit) { snapshot(); setLines((ls) => ls.filter((l) => l.id !== hit.id)); }
      } else if (draftTool === "delete-parcel") {
        const [wx, wy] = toWorld(vbx, vby);
        const hit = polygons.find((p) => pointInPolygon(wx, wy, p));
        if (hit) { snapshot(); setPolygons((ps) => ps.filter((p) => p.id !== hit.id)); }
      } else if (tablesOpen && tableTab === "lines") {
        // Two-way canvas<->table highlight sync (Part 9e) — Lines tab.
        const hit = nearestLineHit(vbx, vby);
        setTableAnchor(hit?.id ?? null);
        setTableSelected(hit ? new Set([hit.id]) : new Set());
      } else if (tablesOpen && tableTab === "polygons") {
        // Two-way canvas<->table highlight sync (Part 9e) — Polygons tab.
        const [wx, wy] = toWorld(vbx, vby);
        const hit = polygons.find((p) => pointInPolygon(wx, wy, p));
        setTableAnchor(hit?.id ?? null);
        setTableSelected(hit ? new Set([hit.id]) : new Set());
      } else {
        // Click-to-add multi-select (Part 10a/10c/10d): a point or line click
        // adds to the current selection; a polygon click toggles membership.
        const hit = nearestVisible(vbx, vby);
        setSelected(hit?.id ?? null);
        if (hit) {
          setCanvasSelection((s) => new Set(s).add(hit.id));
        } else {
          const lineHit = nearestLineHit(vbx, vby);
          if (lineHit) {
            setCanvasSelection((s) => new Set(s).add(lineHit.id));
          } else {
            const [wx, wy] = toWorld(vbx, vby);
            const polyHit = polygons.find((p) => pointInPolygon(wx, wy, p));
            if (polyHit) {
              setCanvasSelection((s) => {
                const n = new Set(s);
                if (n.has(polyHit.id)) n.delete(polyHit.id); else n.add(polyHit.id);
                return n;
              });
            }
          }
        }
        if (tablesOpen && tableTab === "points") {
          // Two-way canvas<->table highlight sync (Part 9e) — Points tab.
          setTableAnchor(hit?.id ?? null);
          setTableSelected(hit ? new Set([hit.id]) : new Set());
        }
      }
    } else if (draftTool === "select-box" && rectSelect) {
      // Box/rectangle multi-select (Part 10a/10c/10d) — a real drag ended.
      const x1 = Math.min(rectSelect.x1, rectSelect.x2), x2 = Math.max(rectSelect.x1, rectSelect.x2);
      const y1 = Math.min(rectSelect.y1, rectSelect.y2), y2 = Math.max(rectSelect.y1, rectSelect.y2);
      const hitIds = new Set<string>();
      visible.forEach((p) => {
        const [sx, sy] = toScreen(p.east, p.north);
        if (sx >= x1 && sx <= x2 && sy >= y1 && sy <= y2) hitIds.add(p.id);
      });
      lines.forEach((l) => {
        const [ax, ay] = toScreen(l.aE, l.aN);
        const [bx, by] = toScreen(l.bE, l.bN);
        if (ax >= x1 && ax <= x2 && ay >= y1 && ay <= y2 && bx >= x1 && bx <= x2 && by >= y1 && by <= y2) hitIds.add(l.id);
      });
      polygons.forEach((pg) => {
        if (!pg.points.length) return;
        const allIn = pg.points.every((v) => {
          const [sx, sy] = toScreen(v.east, v.north);
          return sx >= x1 && sx <= x2 && sy >= y1 && sy <= y2;
        });
        if (allIn) hitIds.add(pg.id);
      });
      if (hitIds.size) setCanvasSelection((s) => new Set([...s, ...hitIds]));
      setRectSelect(null);
    } else if (draftTool === "zoom-window" && rectSelect) {
      // Zoom Window (Part 12a) — fit the view to exactly the dragged
      // rectangle's area, not a generic zoom step.
      zoomToRect(rectSelect.x1, rectSelect.y1, rectSelect.x2, rectSelect.y2);
      setRectSelect(null);
    } else if (draftTool === "select-lasso" && lassoPath) {
      // Freehand lasso multi-select (Part 10a) — points only, per spec.
      if (lassoPath.length > 2) {
        const hitIds = new Set<string>();
        visible.forEach((p) => {
          const [sx, sy] = toScreen(p.east, p.north);
          if (pointInScreenPolygon(sx, sy, lassoPath)) hitIds.add(p.id);
        });
        if (hitIds.size) setCanvasSelection((s) => new Set([...s, ...hitIds]));
      }
      setLassoPath(null);
    }
    pan.current = null;
    // Safety: a plain click (not a drag) in box/lasso mode falls through to
    // the click-to-add branch above and never reaches its own finalizer —
    // clear any leftover zero-size rect/path so it doesn't linger.
    setRectSelect(null);
    setLassoPath(null);
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
    if (!DRAW_TOOLS.includes(draftTool) && !formTool && !travOpen && !diagramPicking && !diagramPrompt && !coordEntry && !moveCoordInput && !pointQueryId && !lineQueryId && !parcelQueryId && !gripDrag) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        if (gripDrag) cancelGripDrag();
        else if (diagramPrompt) setDiagramPrompt(null);
        else if (diagramPicking) setDiagramPicking(false);
        else if (travOpen) travClose();
        else if (formTool) setFormTool(null);
        else if (coordEntry) setCoordEntry(null);
        else if (moveCoordInput) { setMoving(null); setSelected(null); setMoveCoordInput(null); }
        else if (pointQueryId) setPointQueryId(null);
        else if (lineQueryId) setLineQueryId(null);
        else if (parcelQueryId) setParcelQueryId(null);
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
  }, [draftTool, draft, formTool, travOpen, diagramPicking, diagramPrompt, coordEntry, moveCoordInput, pointQueryId, lineQueryId, parcelQueryId, gripDrag]);

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
              label="Move point (click to pick up, click again to drop — moves the whole selection together if the picked-up point is part of one)"
              onClick={() => activateDrawTool("move")}
              icon={iconMove}
            />
            <div className="mx-1 h-5 w-px bg-slate-200" />
            <DraftButton
              active={draftTool === "select-box"}
              label="Box select — drag a rectangle to select every point/line/polygon inside it"
              onClick={() => activateDrawTool("select-box")}
              icon={iconBoxSelect}
            />
            <DraftButton
              active={draftTool === "select-lasso"}
              label="Lasso select — drag a freehand outline to select every point inside it"
              onClick={() => activateDrawTool("select-lasso")}
              icon={iconLassoSelect}
            />
            <DraftButton
              label={`Clear selection${canvasSelection.size ? ` (${canvasSelection.size})` : ""}`}
              onClick={clearSelection}
              disabled={!canvasSelection.size && !selected}
              icon={iconClearSelection}
            />
            <DraftButton
              label={`Delete selected${canvasSelection.size > 1 ? ` (${canvasSelection.size})` : ""}`}
              onClick={deleteSelected}
              disabled={!selected && !canvasSelection.size}
              icon={iconDelete}
            />
            <div className="mx-1 h-5 w-px bg-slate-200" />
            <DraftButton
              label={draft.length > 0 ? "Undo (removes last placed vertex)" : "Undo"}
              onClick={draft.length > 0 ? removeLastDraftVertex : undo}
              disabled={draft.length > 0 ? false : !past.current.length}
              icon={iconUndo}
            />
            <DraftButton label="Redo" onClick={redo} disabled={!future.current.length || draft.length > 0} icon={iconRedo} />
            <div className="mx-1 h-5 w-px bg-slate-200" />
            <DraftButton label="Zoom in" onClick={() => zoomBy(1.25)} icon={iconZoomIn} />
            <DraftButton label="Zoom out" onClick={() => zoomBy(1 / 1.25)} icon={iconZoomOut} />
            <DraftButton label="Zoom to extents (fit all)" onClick={zoomExtents} icon={iconZoomExtents} />
            <DraftButton
              active={draftTool === "zoom-window"}
              label="Zoom Window — drag a rectangle to zoom to exactly that area"
              onClick={() => activateDrawTool("zoom-window")}
              icon={iconZoomWindow}
            />
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

          <ToolGroup label="Query & Visibility">
            <DraftButton
              active={draftTool === "query-point"}
              label="Point Query — click a point for its details, with rename"
              onClick={() => activateDrawTool("query-point")}
              icon={iconQueryPoint}
            />
            <DraftButton
              active={draftTool === "query-line"}
              label="Line Query — click a line for its direction/distance"
              onClick={() => activateDrawTool("query-line")}
              icon={iconQueryLine}
            />
            <DraftButton
              active={draftTool === "query-parcel"}
              label="Parcel Query — click a parcel for its details"
              onClick={() => activateDrawTool("query-parcel")}
              icon={iconQueryParcel}
            />
            <DraftButton
              active={draftTool === "delete-line"}
              label="Delete Line — click a line to remove just that segment"
              onClick={() => activateDrawTool("delete-line")}
              icon={iconDeleteLine}
            />
            <DraftButton
              active={draftTool === "delete-parcel"}
              label="Delete Parcel — click a parcel to remove that boundary"
              onClick={() => activateDrawTool("delete-parcel")}
              icon={iconDeleteParcel}
            />
            <div className="mx-1 h-5 w-px bg-slate-200" />
            <DraftButton
              active={showPointNames}
              label="Show/hide point names"
              onClick={() => setShowPointNames((s) => !s)}
              icon={iconTogglePointNames}
            />
            <DraftButton
              active={showSegLabels}
              label="Show/hide distance-direction labels"
              onClick={() => setShowSegLabels((s) => !s)}
              icon={iconToggleSegLabels}
            />
            <DraftButton
              active={showParcelNumbers}
              label="Show/hide parcel/plot numbers"
              onClick={() => setShowParcelNumbers((s) => !s)}
              icon={iconToggleParcelNumbers}
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
                {snapMiss
                  ? "No point there — click nearer an existing point. To create a brand-new one, use Add Point instead."
                  : <>
                      {draft.length} vertex(es) placed — click an existing point to add the next vertex, then double-click, press Enter, or Finish to complete
                      {draftTool === "polygon" ? " (closes back to the first point)" : ""}, ready to start the next one right away. Undo removes
                      the last vertex; Escape cancels this shape (or stops drawing entirely if nothing's placed yet).
                    </>}
              </span>
              <button type="button" onClick={removeLastDraftVertex} disabled={!draft.length} title="Undo — removes only the last placed vertex (Ctrl+Z)" className="ml-auto rounded-md border border-amber-300 px-2 py-1 font-semibold text-amber-800 disabled:opacity-40">
                Undo
              </button>
              <button type="button" onClick={finishDraft} disabled={draft.length < (draftTool === "polygon" ? 3 : 2)} className="rounded-md bg-brand px-2 py-1 font-semibold text-white disabled:opacity-40">
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
              cursor:
                // Middle-button pan (Part 36) overrides every other tool's
                // own cursor — held-and-drag panning must give clear
                // grabbing feedback no matter what's currently active.
                middlePan.current
                  ? "grabbing"
                  : diagramPicking || travPickingStart || travChoosingTo || DRAW_TOOLS.includes(draftTool) ||
                    draftTool === "addpoint" || draftTool === "move" || draftTool === "select-box" || draftTool === "select-lasso" || draftTool === "zoom-window" ||
                    draftTool === "query-point" || draftTool === "query-line" || draftTool === "query-parcel" || draftTool === "delete-line" || draftTool === "delete-parcel"
                  ? "crosshair"
                  : pan.current
                  ? "grabbing"
                  : "default",
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={onDoubleClick}
            onPointerLeave={() => { pan.current = null; middlePan.current = null; }}
            onWheel={onWheel}
            // Suppresses the browser's own middle-click "autoscroll" UI,
            // which would otherwise fight with our own hold-and-drag pan.
            onAuxClick={(ev) => { if (ev.button === 1) ev.preventDefault(); }}
          >
            {polygons.map((p) => {
              const isTableSel = (tablesOpen && tableTab === "polygons" && tableSelected.has(p.id)) || canvasSelection.has(p.id);
              const label = polygonMeta[p.id]?.position || p.name;
              const cE = p.points.reduce((s, v) => s + v.east, 0) / (p.points.length || 1);
              const cN = p.points.reduce((s, v) => s + v.north, 0) / (p.points.length || 1);
              const [ctx, cty] = toScreen(cE, cN);
              return (
                <g key={p.id}>
                  <polygon
                    points={p.points.map((v) => toScreen(v.east, v.north).join(",")).join(" ")}
                    fill={isTableSel ? "#dc2626" : "#f59e0b"}
                    fillOpacity={isTableSel ? 0.28 : 0.15}
                    stroke={isTableSel ? "#dc2626" : "#d97706"}
                    strokeWidth={isTableSel ? 2.4 : 1.4}
                  />
                  {showParcelNumbers && label && (
                    <text x={ctx} y={cty} textAnchor="middle" fontSize={12} fontWeight="bold" className="fill-amber-800">
                      {label}
                    </text>
                  )}
                </g>
              );
            })}
            {lines.map((l) => {
              const [x1, y1] = toScreen(l.aE, l.aN);
              const [x2, y2] = toScreen(l.bE, l.bN);
              const isTableSel = (tablesOpen && tableTab === "lines" && tableSelected.has(l.id)) || canvasSelection.has(l.id);
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
              if (t.kind === "seglabel" && !showSegLabels) return null;
              const [x, y] = toScreen(t.east, t.north);
              // Seglabels run along their own segment (client req 2026-08-26:
              // "those bearings and distances should be in the same line")
              // instead of always sitting flat/horizontal — nudged off the
              // line itself (in the label's own local frame, before
              // rotating) so the text doesn't sit bisected by the stroke.
              if (t.angle) {
                return (
                  <g key={t.id} transform={`rotate(${t.angle} ${x} ${y})`}>
                    <text x={x} y={y - 4} textAnchor="middle" fontSize={t.size} className="fill-slate-800 font-medium">
                      {t.text}
                    </text>
                  </g>
                );
              }
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
              // Small hollow circle, matching standard survey-diagram
              // convention (client req 2026-08-31: reference sheets never
              // use a solid filled dot) — was a solid green fill large
              // enough that a real subdivision's worth of points (hundreds,
              // close together) visually merged into one solid mass,
              // burying the boundary lines and labels underneath. Radius
              // also shrinks as the canvas gets denser, on the same
              // reasoning as the label-declutter/plot-line-weight scaling
              // already applied in General Plan.
              visible.map((p) => {
                const [x, y] = toScreen(p.east, p.north);
                const isSel = p.id === selected || canvasSelection.has(p.id) || (tablesOpen && tableTab === "points" && tableSelected.has(p.id));
                const r = visible.length > 400 ? 1.4 : visible.length > 100 ? 2.2 : 3.2;
                return (
                  <g key={p.id}>
                    <circle
                      cx={x} cy={y} r={isSel ? 6 : r}
                      fill={isSel ? "#dc2626" : "white"}
                      stroke={isSel ? "none" : "#059669"}
                      strokeWidth={isSel ? 0 : Math.max(0.6, r * 0.4)}
                    />
                    {showPointNames && (
                      <text x={x + 7} y={y - 6} className="fill-slate-700 text-[11px] font-medium">
                        {p.name}
                      </text>
                    )}
                  </g>
                );
              })
            )}
            {/* Already-placed segments of a multi-vertex shape (Polyline/Polygon)
                being drawn — each gets its own live bearing/distance label,
                same as a finished shape (client req 2026-08-20, Part 11). */}
            {(draftTool === "polyline" || draftTool === "polygon") && draft.length > 1 && draft.slice(1).map((v, i) => {
              const a = draft[i], b = v;
              const [x1, y1] = toScreen(a.east, a.north);
              const [x2, y2] = toScreen(b.east, b.north);
              const [mx, my] = toScreen((a.east + b.east) / 2, (a.north + b.north) / 2);
              return (
                <g key={`draftseg-${i}`}>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#059669" strokeWidth={1.6} />
                  <text x={mx} y={my - 5} textAnchor="middle" fontSize={10} className="fill-emerald-700 font-medium">{segLabel(a, b)}</text>
                </g>
              );
            })}
            {/* Rubber-band preview: dashed guide from the last placed vertex to the cursor. */}
            {DRAW_TOOLS.includes(draftTool) && draftTool !== "offset" && draft.length > 0 && cursor && (() => {
              const last = draft[draft.length - 1];
              const [x1, y1] = toScreen(last.east, last.north);
              const [x2, y2] = toScreen(cursor.e, cursor.n);
              const [mx, my] = toScreen((last.east + cursor.e) / 2, (last.north + cursor.n) / 2);
              return (
                <>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#059669" strokeWidth={1.4} strokeDasharray="5 4" />
                  <text x={mx} y={my - 5} textAnchor="middle" fontSize={10} className="fill-emerald-700 font-medium">{segLabel(last, { east: cursor.e, north: cursor.n })}</text>
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
            {/* Box select rubber-band rectangle (Part 10a/10c/10d). */}
            {rectSelect && (
              <rect
                x={Math.min(rectSelect.x1, rectSelect.x2)}
                y={Math.min(rectSelect.y1, rectSelect.y2)}
                width={Math.abs(rectSelect.x2 - rectSelect.x1)}
                height={Math.abs(rectSelect.y2 - rectSelect.y1)}
                fill="#2563eb"
                fillOpacity={0.08}
                stroke="#2563eb"
                strokeWidth={1.2}
                strokeDasharray="4 3"
              />
            )}
            {/* Freehand lasso outline (Part 10a). */}
            {lassoPath && lassoPath.length > 1 && (
              <polyline
                points={lassoPath.map((p) => `${p.x},${p.y}`).join(" ")}
                fill="#2563eb"
                fillOpacity={0.08}
                stroke="#2563eb"
                strokeWidth={1.4}
                strokeDasharray="4 3"
              />
            )}
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
            {/* Grip-based edit (client req 2026-08-24, Part 28 — matches the
                client's AutoCAD demo): a single selected line gets draggable
                grips at each endpoint (stretch that end freely; hold Shift
                to rotate the whole line around the OTHER, fixed end instead)
                and its midpoint (move the whole line). Screen-space size
                (not world-space) so grips stay a constant, easy-to-grab
                size regardless of zoom, the same as every real CAD tool. */}
            {(() => {
              if (rectSelect || lassoPath) return null;
              const gripLine = gripDrag
                ? lines.find((l) => l.id === gripDrag.lineId)
                : draftTool === "select"
                ? lines.find((l) => l.id === selected) ?? (canvasSelection.size === 1 ? lines.find((l) => canvasSelection.has(l.id)) : undefined)
                : undefined;
              if (!gripLine) return null;
              const [mx, my] = toScreen((gripLine.aE + gripLine.bE) / 2, (gripLine.aN + gripLine.bN) / 2);
              const [ax, ay] = toScreen(gripLine.aE, gripLine.aN);
              const [bx, by] = toScreen(gripLine.bE, gripLine.bN);
              const GS = 5;
              const fillFor = (hot: boolean) => (hot ? "#dc2626" : "#2563eb");
              return (
                <g>
                  <rect
                    x={ax - GS} y={ay - GS} width={GS * 2} height={GS * 2}
                    fill={fillFor(gripDrag?.mode === "stretch-a" || gripDrag?.mode === "rotate-a")}
                    stroke="white" strokeWidth={1}
                    style={{ cursor: "move" }}
                    onPointerDown={(e) => startGripDrag(gripLine, e.shiftKey ? "rotate-a" : "stretch-a", e)}
                  />
                  <rect
                    x={bx - GS} y={by - GS} width={GS * 2} height={GS * 2}
                    fill={fillFor(gripDrag?.mode === "stretch-b" || gripDrag?.mode === "rotate-b")}
                    stroke="white" strokeWidth={1}
                    style={{ cursor: "move" }}
                    onPointerDown={(e) => startGripDrag(gripLine, e.shiftKey ? "rotate-b" : "stretch-b", e)}
                  />
                  <rect
                    x={mx - GS} y={my - GS} width={GS * 2} height={GS * 2}
                    fill={fillFor(gripDrag?.mode === "move")}
                    stroke="white" strokeWidth={1}
                    style={{ cursor: "grab" }}
                    onPointerDown={(e) => startGripDrag(gripLine, "move", e)}
                  />
                </g>
              );
            })()}
          </svg>

          {/* Live dynamic-input readout while stretching/rotating a grip
              (client req 2026-08-24, Part 28 — "matching the AutoCAD demo's
              dynamic input fields, so the user can type an exact value
              instead of dragging by eye"). Not shown for a plain Move drag
              — there's no single length/angle to read out for a translation. */}
          {gripDrag && gripDrag.mode !== "move" && (() => {
            const line = lines.find((l) => l.id === gripDrag.lineId);
            if (!line) return null;
            const isA = gripDrag.mode === "stretch-a" || gripDrag.mode === "rotate-a";
            const isRotate = gripDrag.mode.startsWith("rotate");
            const [px, py] = toScreen(isA ? line.aE : line.bE, isA ? line.aN : line.bN);
            return (
              <div
                className="absolute z-10 w-40 rounded border border-brand bg-white p-2 text-xs shadow-md"
                style={{ left: `${(px / W) * 100}%`, top: `${(py / H) * 100}%`, transform: "translate(12px, 12px)" }}
              >
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="font-semibold text-brand-dark">{isRotate ? "Rotate" : "Stretch"}</span>
                  <button type="button" onClick={cancelGripDrag} className="text-slate-400 hover:text-slate-700" aria-label="Cancel">✕</button>
                </div>
                <label className="mb-1 block">
                  <span className="mb-0.5 block text-slate-500">Length</span>
                  <input
                    type="number"
                    value={gripDrag.lengthText}
                    readOnly={isRotate}
                    onChange={(e) => setGripDrag((g) => (g ? { ...g, lengthText: e.target.value } : g))}
                    onKeyDown={(e) => { if (e.key === "Enter") applyGripReadout(); if (e.key === "Escape") cancelGripDrag(); }}
                    className={`w-full rounded border border-slate-200 px-1.5 py-1 ${isRotate ? "bg-slate-50 text-slate-500" : ""}`}
                  />
                </label>
                <label className="mb-1.5 block">
                  <span className="mb-0.5 block text-slate-500">Angle (bearing)</span>
                  <input
                    value={gripDrag.angleText}
                    onChange={(e) => setGripDrag((g) => (g ? { ...g, angleText: e.target.value } : g))}
                    onKeyDown={(e) => { if (e.key === "Enter") applyGripReadout(); if (e.key === "Escape") cancelGripDrag(); }}
                    className="w-full rounded border border-slate-200 px-1.5 py-1"
                  />
                </label>
                <button type="button" onClick={applyGripReadout} className="w-full rounded bg-brand px-1.5 py-1 font-semibold text-white">Apply</button>
              </div>
            );
          })()}

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
                onFocus={(e) => e.target.select()}
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

          {/* Point Query panel (Part 15b) — details + Prev/Next + inline rename. */}
          {pointQueryId && (() => {
            const p = visible.find((pp) => pp.id === pointQueryId);
            if (!p) return null;
            const m = pointMeta[p.id] ?? {};
            return (
              <div className="absolute right-2 top-2 z-10 w-56 rounded border border-brand bg-white p-2 text-xs shadow-md">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="font-semibold text-brand-dark">Point Query</span>
                  <button type="button" onClick={() => setPointQueryId(null)} className="text-slate-400 hover:text-slate-700" aria-label="Close">✕</button>
                </div>
                <div className="mb-1.5 grid grid-cols-2 gap-x-2 gap-y-1">
                  <span className="text-slate-500">Point ID</span><span className="truncate font-mono">{p.id}</span>
                  <span className="text-slate-500">Y</span><span className="font-mono">{p.east.toFixed(3)}</span>
                  <span className="text-slate-500">X</span><span className="font-mono">{p.north.toFixed(3)}</span>
                  <span className="text-slate-500">Height</span><span>{m.height || "—"}</span>
                  <span className="text-slate-500">SR Number</span><span>{m.sdNumber || "—"}</span>
                </div>
                <label className="mb-1.5 block">
                  <span className="mb-0.5 block text-slate-500">Name</span>
                  <input
                    value={pointQueryName}
                    onChange={(e) => setPointQueryName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") applyPointRename(); }}
                    className="w-full rounded border border-slate-200 px-1.5 py-1"
                  />
                </label>
                <div className="grid grid-cols-3 gap-1">
                  <button type="button" onClick={() => pointQueryStep(-1)} className="rounded border border-slate-200 px-1.5 py-1 hover:bg-slate-50">◀ Prev</button>
                  <button type="button" onClick={applyPointRename} className="rounded bg-brand px-1.5 py-1 font-semibold text-white">Rename</button>
                  <button type="button" onClick={() => pointQueryStep(1)} className="rounded border border-slate-200 px-1.5 py-1 hover:bg-slate-50">Next ▶</button>
                </div>
              </div>
            );
          })()}

          {/* Line Query panel (Part 15c) — read-only Direction/Distance. */}
          {lineQueryId && (() => {
            const l = lines.find((ll) => ll.id === lineQueryId);
            if (!l) return null;
            const [brg, dist] = inverse({ east: l.aE, north: l.aN }, { east: l.bE, north: l.bN });
            return (
              <div className="absolute right-2 top-2 z-10 w-52 rounded border border-brand bg-white p-2 text-xs shadow-md">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="font-semibold text-brand-dark">Line Query</span>
                  <button type="button" onClick={() => setLineQueryId(null)} className="text-slate-400 hover:text-slate-700" aria-label="Close">✕</button>
                </div>
                <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                  <span className="text-slate-500">Direction</span><span className="font-mono">{formatDms(brg)}</span>
                  <span className="text-slate-500">Distance</span><span className="font-mono">{dist.toFixed(3)}m</span>
                </div>
              </div>
            );
          })()}

          {/* Parcel Query panel (Part 15d) — matches the simplified Polygons
              table columns from Part 9d (client req 2026-08-24: Lot Number,
              Village, Land Surveyor, SR Number, DSM Number, Type, Area,
              Parent — no more Erf/Farm/Township/etc.). */}
          {parcelQueryId && (() => {
            const poly = polygons.find((pp) => pp.id === parcelQueryId);
            if (!poly) return null;
            const m = polygonMeta[poly.id] ?? {};
            const areaM2 = polygonArea(poly.points.map((v) => ({ east: v.east, north: v.north })));
            return (
              <div className="absolute right-2 top-2 z-10 w-56 rounded border border-brand bg-white p-2 text-xs shadow-md">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="font-semibold text-brand-dark">Parcel Query</span>
                  <button type="button" onClick={() => setParcelQueryId(null)} className="text-slate-400 hover:text-slate-700" aria-label="Close">✕</button>
                </div>
                <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                  <span className="text-slate-500">Lot Number</span><span>{m.position || poly.name || "—"}</span>
                  <span className="text-slate-500">Village</span><span>{m.village || "—"}</span>
                  <span className="text-slate-500">Land Surveyor</span><span>{m.surveyor || "—"}</span>
                  <span className="text-slate-500">SR Number</span><span>{m.srNumber || "—"}</span>
                  <span className="text-slate-500">DSM Number</span><span>{m.dsmNumber || "—"}</span>
                  <span className="text-slate-500">Type</span><span>{m.type || "—"}</span>
                  <span className="text-slate-500">Area</span><span className="font-mono">{formatArea(areaM2)}</span>
                  <span className="text-slate-500">Parent</span><span>{m.parent || "—"}</span>
                  <span className="text-slate-500">Vertices</span><span>{poly.points.length}</span>
                </div>
              </div>
            );
          })()}
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
            <span className={snapMiss && (draftTool === "line" || draftTool === "polyline" || draftTool === "polygon") ? "font-semibold text-red-600" : undefined}>
              {snapMiss && (draftTool === "line" || draftTool === "polyline" || draftTool === "polygon")
                ? "No point there — click nearer an existing point (use Add Point to create a new one)"
                : diagramPicking
                ? "Click inside a plot (polygon) to generate its diagram"
                : travPickingStart
                ? "Click a point on the canvas to start the traverse from"
                : travChoosingTo
                ? "Click an existing point — its direction & distance from the current point will be filled in"
                : draftTool === "select-box"
                ? "Drag a rectangle to select every point/line/polygon inside it"
                : draftTool === "select-lasso"
                ? "Drag a freehand outline to select every point inside it"
                : draftTool === "zoom-window"
                ? "Drag a rectangle — the view zooms to fit exactly that area"
                : draftTool === "query-point"
                ? "Click a point for its details"
                : draftTool === "query-line"
                ? "Click a line for its direction/distance"
                : draftTool === "query-parcel"
                ? "Click a parcel for its details"
                : draftTool === "delete-line"
                ? "Click a line to delete it"
                : draftTool === "delete-parcel"
                ? "Click a parcel to delete it"
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
            {/* Bulk-import many numbered plots at once from a CSV (client req
                2026-08-28) — "lot,name,east,north" rows, grouped by lot into
                one polygon each, instead of drawing/numbering each one by
                hand. */}
            <input
              ref={bulkImportInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                file.text().then((text) => {
                  const result = bulkImportPlots(text);
                  if (result.error) {
                    alert(`Bulk import failed: ${result.error}`);
                  } else {
                    alert(`Imported ${result.imported} plot(s)${result.skipped ? `, skipped ${result.skipped} invalid row(s)` : ""}.`);
                  }
                });
              }}
            />
            {/* Bulk Import button hidden (client req 2026-08-30) — Auto-Detect
                Rectangular Lots covers the real workflow (a raw beacon list
                with no lot column), and having both side by side was
                confusing. The importer itself is kept intact for the
                "lot,name,east,north" CSV path; only the button is hidden. */}
            {/* Auto-detect rectangular lots straight from whatever points are
                on the canvas (client req 2026-08-28) — for a raw flat beacon
                list (no lot-grouping column at all, unlike the CSV above)
                that's too large to draw one Polygon-tool click at a time. */}
            <input
              type="text"
              inputMode="numeric"
              value={autoDetectStart}
              onChange={(e) => setAutoDetectStart(e.target.value)}
              placeholder={`Starting lot # (default ${suggestedNextLotStart()})`}
              title='Numbers the AUTO-DETECTED LOTS below, starting here — unrelated to the "Starting beacon" field in the left sidebar (that one names the traverse). Leave blank to continue from the highest lot number already in this project.'
              className="w-52 rounded border border-slate-200 px-2 py-0.5 text-slate-600"
            />
            <button
              type="button"
              onClick={() => autoDetectLots(autoDetectStart)}
              className="rounded border border-slate-200 px-2 py-0.5 text-slate-600 hover:bg-slate-50"
              title="Builds one numbered plot per rectangle found among the points currently on the canvas (works for a rectilinear grid subdivision only)"
            >
              Auto-Detect Rectangular Lots
            </button>
            {/* The only way to undo a bad/duplicated Auto-Detect run — plots
                are saved project-wide (cogoPlots), so an unwanted set would
                otherwise keep showing on every General/Working Plan sheet
                with nothing in the UI to remove them (client req
                2026-08-30). */}
            {cogoPlots.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`Delete all ${cogoPlots.length} numbered lot(s) from this project?\n\nThe points on the canvas are NOT deleted — only the numbered lots built from them, so you can re-run Auto-Detect cleanly.`)) {
                    setCogoPlots([]);
                  }
                }}
                className="rounded border border-slate-200 px-2 py-0.5 text-slate-600 hover:bg-slate-50"
                title="Removes every numbered lot saved in this project (the canvas points themselves stay)"
              >
                Clear All Lots ({cogoPlots.length})
              </button>
            )}
            {draftTool === "addpoint" && !coordEntry && (
              <button type="button" onClick={coordEntryOpen} className="rounded border border-slate-200 px-2 py-0.5 text-slate-600 hover:bg-slate-50">
                By Coordinates
              </button>
            )}
            {/* Rotate slider + Flip button hidden (client req 2026-08-30) —
                they were added to correct an orientation mismatch that turned
                out to be a data problem, and the controls only added clutter
                once the data was right. The shared config.displayRotation /
                displayFlip values are still read by every view (COGO canvas,
                Diagrams, Working Plan, General Plan, and all three DXF
                exports), so anything a project already had set keeps applying
                — only the controls are hidden. Restore this block to bring
                them back. */}
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

          {/* Polygon quick-edit dialog (Part 9f) — Lot Number, Area, Cancel/OK.
              No "ID / Erf" field (client req 2026-08-24: "I think we don't
              need that part. Lets just use Lot Number"). */}
          {polygonAttrDialog && (
            <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/30" onClick={() => setPolygonAttrDialog(null)}>
              <div className="w-72 rounded-lg bg-white p-4 text-xs shadow-xl" onClick={(e) => e.stopPropagation()}>
                <h3 className="mb-3 text-sm font-semibold text-slate-700">Polygon Attributes</h3>
                <label className="mb-2 block">
                  <span className="mb-0.5 block text-slate-500">Lot Number</span>
                  <input
                    value={polygonAttrDialog.position}
                    onChange={(e) => setPolygonAttrDialog({ ...polygonAttrDialog, position: e.target.value })}
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

          {/* Traverse/polygon completion dialog (client req 2026-08-21, Part
              16c) — shown when Calculate finishes a boundary: computed Area
              (read-only) + an editable Erf/Plot Number pre-filled with the
              next number after whichever was last confirmed in this sheet. */}
          {travCompleteDialog && (
            <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/30" onClick={() => setTravCompleteDialog(null)}>
              <div className="w-72 rounded-lg bg-white p-4 text-xs shadow-xl" onClick={(e) => e.stopPropagation()}>
                <h3 className="mb-3 text-sm font-semibold text-slate-700">Traverse Complete</h3>
                <label className="mb-2 block">
                  <span className="mb-0.5 block text-slate-500">Area</span>
                  <input value={`${travCompleteDialog.areaHa} ha`} readOnly className="w-full rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-slate-500" />
                </label>
                <label className="mb-3 block">
                  <span className="mb-0.5 block text-slate-500">Erf / Plot Number</span>
                  <input
                    autoFocus
                    value={travCompleteDialog.plotNumber}
                    onChange={(e) => setTravCompleteDialog({ ...travCompleteDialog, plotNumber: e.target.value })}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={(e) => { if (e.key === "Enter") travCompleteConfirm(); }}
                    className="w-full rounded border border-slate-200 px-2 py-1.5"
                  />
                </label>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setTravCompleteDialog(null)} className="rounded border border-slate-200 px-3 py-1.5 hover:bg-slate-50">Cancel</button>
                  <button type="button" onClick={travCompleteConfirm} className="rounded bg-brand px-3 py-1.5 font-semibold text-white hover:bg-brand-dark">OK</button>
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
function iconZoomWindow(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <rect x="3.5" y="3.5" width="12" height="12" rx="1" strokeDasharray="2.5 2" />
      <circle cx="16" cy="16" r="5" />
      <path d="M20 20l3 3" strokeLinecap="round" />
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
function iconBoxSelect(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <rect x="3.5" y="3.5" width="17" height="17" rx="1" strokeDasharray="3 2.5" />
      <circle cx="9" cy="9" r="1.3" fill={c} stroke="none" />
      <circle cx="16" cy="14" r="1.3" fill={c} stroke="none" />
    </svg>
  );
}
function iconLassoSelect(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M12 3c4.4 0 8 2.5 8 6s-3 5-6 5c-2 0-2.5 1-2.5 2.2 0 1 .8 1.8 1.8 1.8" strokeDasharray="2.5 2" strokeLinecap="round" />
      <circle cx="13.3" cy="18" r="1.6" fill={c} stroke="none" />
      <circle cx="8" cy="10" r="1.3" fill={c} stroke="none" />
      <circle cx="15" cy="7" r="1.3" fill={c} stroke="none" />
    </svg>
  );
}
function iconClearSelection(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <rect x="3.5" y="3.5" width="17" height="17" rx="1" strokeDasharray="3 2.5" opacity="0.5" />
      <path d="M8 8l8 8M16 8l-8 8" strokeWidth="2" />
    </svg>
  );
}
function iconQueryPoint(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <circle cx="12" cy="12" r="2.4" fill={c} stroke="none" />
      <circle cx="12" cy="12" r="8" strokeDasharray="2.5 2" />
      <text x="18" y="8" fontSize="8" fill={c} stroke="none">?</text>
    </svg>
  );
}
function iconQueryLine(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M4 20L20 4" />
      <text x="14" y="9" fontSize="8" fill={c} stroke="none">?</text>
    </svg>
  );
}
function iconQueryParcel(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M4 6l8-2 8 3-3 11-11 1z" fill={c} fillOpacity="0.12" />
      <text x="12" y="15" fontSize="8" fill={c} stroke="none" textAnchor="middle">?</text>
    </svg>
  );
}
function iconDeleteLine(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M4 20L20 4" />
      <path d="M15 3l6 6" strokeWidth="2" stroke="#dc2626" />
    </svg>
  );
}
function iconDeleteParcel(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M4 6l8-2 8 3-3 11-11 1z" fill={c} fillOpacity="0.12" />
      <path d="M8 8l8 8M16 8l-8 8" strokeWidth="1.8" stroke="#dc2626" />
    </svg>
  );
}
function iconTogglePointNames(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <circle cx="6" cy="18" r="1.8" fill={c} stroke="none" />
      <rect x="10" y="5" width="11" height="7" rx="1.3" />
      <path d="M12 8h7" strokeWidth="1.2" />
    </svg>
  );
}
function iconToggleSegLabels(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M3 19L21 5" />
      <rect x="7" y="9" width="11" height="5" rx="1" fill="#fff" />
      <path d="M9 11.5h7" strokeWidth="1.2" />
    </svg>
  );
}
function iconToggleParcelNumbers(c: string) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={c} strokeWidth="1.8">
      <path d="M4 6l8-2 8 3-3 11-11 1z" fill={c} fillOpacity="0.12" />
      <text x="12" y="15" fontSize="9" fontWeight="bold" fill={c} stroke="none" textAnchor="middle">1</text>
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
