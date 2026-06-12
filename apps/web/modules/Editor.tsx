"use client";

import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { useStore } from "@/lib/store";
import { Button, Card, Field, Input, Select } from "@/components/ui";
import { parseDxf, writeDxf, type ImportedDrawing } from "@/lib/dxf";
import { parseShp } from "@/lib/shp";

// ---------------------------------------------------------------------------
// Drawing model (CAD-style: layers + linetype/lineweight, ByLayer)
// ---------------------------------------------------------------------------
type Linetype = "continuous" | "dashed" | "dotted" | "dashdot";

interface Layer {
  id: string;
  name: string;
  color: string;
  linetype: Linetype;
  lineweight: number; // px
  visible: boolean;
  locked: boolean;
}

interface Pt { id: string; x: number; y: number; label?: string; layer: string }
interface Ln { id: string; pts: string[]; closed?: boolean; layer: string; linetype?: Linetype; lineweight?: number; color?: string }
interface Txt { id: string; x: number; y: number; text: string; size: number; layer: string; color?: string }
interface Sym { id: string; x: number; y: number; kind: SymbolKind; layer: string }
interface Circ { id: string; cx: number; cy: number; r: number; layer: string; linetype?: Linetype; lineweight?: number; color?: string }

interface Doc {
  layers: Layer[];
  current: string; // current layer id (for new entities)
  grid: { show: boolean; interval: number };
  points: Pt[];
  lines: Ln[];
  texts: Txt[];
  symbols: Sym[];
  circles: Circ[];
}

type Tool = "select" | "point" | "line" | "rect" | "circle" | "text" | "symbol" | "measure";
type SelType = "point" | "line" | "text" | "symbol" | "circle";
type Sel = { type: SelType; id: string } | null;

type SymbolKind =
  | "beacon" | "peg" | "trig" | "borehole" | "tree" | "manhole" | "pole" | "level"
  | "benchmark" | "gate" | "hydrant" | "culvert";
const SYMBOLS: { kind: SymbolKind; label: string }[] = [
  { kind: "beacon", label: "Beacon" },
  { kind: "peg", label: "Iron peg" },
  { kind: "trig", label: "Trig" },
  { kind: "benchmark", label: "Bench mark" },
  { kind: "borehole", label: "Borehole" },
  { kind: "manhole", label: "Manhole" },
  { kind: "hydrant", label: "Hydrant" },
  { kind: "culvert", label: "Culvert" },
  { kind: "pole", label: "Pole" },
  { kind: "gate", label: "Gate" },
  { kind: "tree", label: "Tree" },
  { kind: "level", label: "Spot level" },
];

const LTYPES: { value: Linetype; label: string }[] = [
  { value: "continuous", label: "Continuous" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
  { value: "dashdot", label: "Dash-dot" },
];
const LWEIGHTS = [0.35, 0.5, 0.7, 1, 1.4, 2, 2.8];
const PALETTE = ["#0f172a", "#dc2626", "#a16207", "#64748b", "#16a34a", "#2563eb", "#15803d", "#0891b2", "#9333ea", "#db2777"];

// Seed per-feature layers (matches typical Botswana topo layering).
function seedLayers(): Layer[] {
  const L = (name: string, color: string, linetype: Linetype = "continuous", lineweight = 1): Layer => ({
    id: name, name, color, linetype, lineweight, visible: true, locked: false,
  });
  return [
    L("0", "#0f172a"),
    L("Boundary", "#dc2626", "continuous", 1.4),
    L("Contours", "#a16207", "continuous", 0.7),
    L("Roads", "#64748b"),
    L("Fence", "#16a34a", "dashed"),
    L("Buildings", "#2563eb"),
    L("Vegetation", "#15803d"),
    L("Water", "#0891b2", "dashed"),
    L("Grid", "#cbd5e1", "dotted", 0.5),
    L("Annotation", "#0f172a"),
  ];
}

function emptyDoc(): Doc {
  return { layers: seedLayers(), current: "0", grid: { show: false, interval: 100 }, points: [], lines: [], texts: [], symbols: [], circles: [] };
}

const W = 920;
const H = 640;
const SNAP_PX = 12;
const STORAGE_KEY = "bcs-editor-v2";

export function Editor() {
  const { topoResult, cogoResult, editorDoc: storeEditorDoc, setEditorDoc } = useStore();
  const svgRef = useRef<SVGSVGElement>(null);
  const contentRef = useRef<SVGGElement>(null);
  const idRef = useRef(1000);
  const nextId = () => String(++idRef.current);

  // Initialise from the project's editor drawing (set when a cloud project is opened), else blank.
  const [doc, setDoc] = useState<Doc>(() => (storeEditorDoc ? migrate(storeEditorDoc) : emptyDoc()));
  const [view, setView] = useState({ cx: 0, cy: 0, zoom: 1 });
  const [tool, setTool] = useState<Tool>("select");
  const [symbolKind, setSymbolKind] = useState<SymbolKind>("beacon");
  const [sel, setSel] = useState<Sel>(null);
  const [draft, setDraft] = useState<{ x: number; y: number; snap?: string }[]>([]);
  const [measure, setMeasure] = useState<{ a: [number, number]; b: [number, number] | null } | null>(null);
  const [preview, setPreview] = useState<[number, number] | null>(null);
  const [recoverable, setRecoverable] = useState<Doc | null>(null);
  const [rot, setRot] = useState("90");
  const [scl, setScl] = useState("2");

  const drag = useRef<
    | { mode: "elem"; type: SelType; id: string }
    | { mode: "pan"; startVbX: number; startVbY: number; startCx: number; startCy: number }
    | { mode: "rect" | "circle"; x0: number; y0: number }
    | null
  >(null);

  // ---- undo / redo ----
  const past = useRef<Doc[]>([]);
  const future = useRef<Doc[]>([]);
  const dragSnapped = useRef(false);
  const [, setHistVer] = useState(0);
  function snapshot() {
    past.current.push(doc);
    if (past.current.length > 150) past.current.shift();
    future.current = [];
    setHistVer((v) => v + 1);
  }
  function undo() {
    if (!past.current.length) return;
    future.current.push(doc);
    setDoc(past.current.pop()!);
    setSel(null);
    setHistVer((v) => v + 1);
  }
  function redo() {
    if (!future.current.length) return;
    past.current.push(doc);
    setDoc(future.current.pop()!);
    setSel(null);
    setHistVer((v) => v + 1);
  }

  // ---- autosave / recovery ----
  const mounted = useRef(false);
  useEffect(() => {
    if (storeEditorDoc) return; // a cloud project drawing was loaded — don't offer a stale local recovery
    try {
      const s = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
      if (s) {
        const m = migrate(JSON.parse(s));
        if (m.points.length || m.lines.length || m.texts.length || m.symbols.length || m.circles.length) setRecoverable(m);
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; } // don't overwrite a recoverable session on mount
    const t = setTimeout(() => {
      try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(doc)); } catch { /* quota / SSR */ }
    }, 800);
    return () => clearTimeout(t);
  }, [doc]);
  // Keep the project bundle's drawing current — synchronous ref write (cheap, no re-render),
  // so a Save always captures the latest drawing even if clicked mid-edit or from another tab.
  useEffect(() => { setEditorDoc(doc); }, [doc, setEditorDoc]);
  // When opened from a cloud project, advance the id counter past the loaded entity ids.
  useEffect(() => {
    if (storeEditorDoc) bumpIds(doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- transforms ----
  const toScreen = (x: number, y: number): [number, number] => [
    (x - view.cx) * view.zoom + W / 2,
    H / 2 - (y - view.cy) * view.zoom,
  ];
  const toWorld = (sx: number, sy: number): [number, number] => [
    view.cx + (sx - W / 2) / view.zoom,
    view.cy - (sy - H / 2) / view.zoom,
  ];
  function eventToVb(e: RPointerEvent | React.WheelEvent): [number, number] {
    const r = svgRef.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  }

  // ---- layer helpers ----
  const layerById = (id: string) => doc.layers.find((l) => l.id === id) ?? doc.layers[0];
  const visible = (layerId: string) => layerById(layerId).visible;
  const locked = (layerId: string) => layerById(layerId).locked;
  function styleOf(e: { layer: string; color?: string; linetype?: Linetype; lineweight?: number }) {
    const L = layerById(e.layer);
    return { color: e.color ?? L.color, width: e.lineweight ?? L.lineweight, dash: dashArray(e.linetype ?? L.linetype, e.lineweight ?? L.lineweight) };
  }

  const pointById = (id: string) => doc.points.find((p) => p.id === id);
  function nearestPoint(wx: number, wy: number): Pt | null {
    let best: Pt | null = null;
    let bestD = (SNAP_PX / view.zoom) ** 2;
    for (const p of doc.points) {
      if (!visible(p.layer) || locked(p.layer)) continue;
      const d = (p.x - wx) ** 2 + (p.y - wy) ** 2;
      if (d <= bestD) { bestD = d; best = p; }
    }
    return best;
  }

  // ---- hit testing (screen space; skips locked/invisible layers) ----
  function hitTest(sx: number, sy: number): Sel {
    const near = (ax: number, ay: number, r: number) => (ax - sx) ** 2 + (ay - sy) ** 2 <= r * r;
    for (const s of doc.symbols) {
      if (!visible(s.layer) || locked(s.layer)) continue;
      const [x, y] = toScreen(s.x, s.y);
      if (near(x, y, 12)) return { type: "symbol", id: s.id };
    }
    for (const cc of doc.circles) {
      if (!visible(cc.layer) || locked(cc.layer)) continue;
      const [x, y] = toScreen(cc.cx, cc.cy);
      const dC = Math.hypot(sx - x, sy - y);
      if (Math.abs(dC - cc.r * view.zoom) <= 6 || dC <= 6) return { type: "circle", id: cc.id };
    }
    for (const t of doc.texts) {
      if (!visible(t.layer) || locked(t.layer)) continue;
      const [x, y] = toScreen(t.x, t.y);
      if (sx >= x - 4 && sx <= x + t.text.length * t.size * 0.6 + 4 && sy >= y - t.size && sy <= y + 4) return { type: "text", id: t.id };
    }
    for (const p of doc.points) {
      if (!visible(p.layer) || locked(p.layer)) continue;
      const [x, y] = toScreen(p.x, p.y);
      if (near(x, y, 9)) return { type: "point", id: p.id };
    }
    for (const l of doc.lines) {
      if (!visible(l.layer) || locked(l.layer)) continue;
      const pts = l.pts.map((id) => pointById(id)).filter(Boolean) as Pt[];
      for (let i = 0; i < pts.length - (l.closed ? 0 : 1); i++) {
        const a = toScreen(pts[i].x, pts[i].y);
        const b = toScreen(pts[(i + 1) % pts.length].x, pts[(i + 1) % pts.length].y);
        if (distToSeg(sx, sy, a[0], a[1], b[0], b[1]) <= 6) return { type: "line", id: l.id };
      }
    }
    return null;
  }

  // ---- pointer handlers ----
  function onPointerDown(e: RPointerEvent<SVGSVGElement>) {
    svgRef.current?.setPointerCapture(e.pointerId);
    const [vbx, vby] = eventToVb(e);
    const [wx, wy] = toWorld(vbx, vby);

    if (tool === "point") {
      snapshot();
      const p: Pt = { id: nextId(), x: wx, y: wy, layer: doc.current };
      setDoc((d) => ({ ...d, points: [...d.points, p] }));
      setSel({ type: "point", id: p.id });
      return;
    }
    if (tool === "text") {
      snapshot();
      const t: Txt = { id: nextId(), x: wx, y: wy, text: "Text", size: 14, layer: doc.current };
      setDoc((d) => ({ ...d, texts: [...d.texts, t] }));
      setSel({ type: "text", id: t.id });
      return;
    }
    if (tool === "symbol") {
      snapshot();
      const s: Sym = { id: nextId(), x: wx, y: wy, kind: symbolKind, layer: doc.current };
      setDoc((d) => ({ ...d, symbols: [...d.symbols, s] }));
      setSel({ type: "symbol", id: s.id });
      return;
    }
    if (tool === "line") {
      const snap = nearestPoint(wx, wy); // buffer coords; commit atomically in finishLine
      setDraft((dr) => [...dr, snap ? { x: snap.x, y: snap.y, snap: snap.id } : { x: wx, y: wy }]);
      return;
    }
    if (tool === "rect" || tool === "circle") {
      drag.current = { mode: tool, x0: wx, y0: wy };
      setPreview([wx, wy]);
      return;
    }
    if (tool === "measure") {
      setMeasure((m) => (!m || m.b ? { a: [wx, wy], b: null } : { a: m.a, b: [wx, wy] }));
      return;
    }
    // select
    const hit = hitTest(vbx, vby);
    setSel(hit);
    if (hit) { dragSnapped.current = false; drag.current = { mode: "elem", type: hit.type, id: hit.id }; }
    else drag.current = { mode: "pan", startVbX: vbx, startVbY: vby, startCx: view.cx, startCy: view.cy };
  }

  function onPointerMove(e: RPointerEvent<SVGSVGElement>) {
    const dc = drag.current;
    if (!dc) return;
    const [vbx, vby] = eventToVb(e);
    if (dc.mode === "pan") {
      const dx = (vbx - dc.startVbX) / view.zoom;
      const dy = (vby - dc.startVbY) / view.zoom;
      setView((v) => ({ ...v, cx: dc.startCx - dx, cy: dc.startCy + dy }));
      return;
    }
    if (dc.mode === "rect" || dc.mode === "circle") {
      setPreview(toWorld(vbx, vby));
      return;
    }
    if (dc.mode !== "elem") return; // narrow to element drag
    const [wx, wy] = toWorld(vbx, vby);
    if (!dragSnapped.current) { snapshot(); dragSnapped.current = true; }
    const { type, id } = dc;
    setDoc((d) => {
      if (type === "point") return { ...d, points: d.points.map((p) => (p.id === id ? { ...p, x: wx, y: wy } : p)) };
      if (type === "text") return { ...d, texts: d.texts.map((t) => (t.id === id ? { ...t, x: wx, y: wy } : t)) };
      if (type === "symbol") return { ...d, symbols: d.symbols.map((s) => (s.id === id ? { ...s, x: wx, y: wy } : s)) };
      if (type === "circle") return { ...d, circles: d.circles.map((c) => (c.id === id ? { ...c, cx: wx, cy: wy } : c)) };
      return d;
    });
  }

  function onPointerUp(e: RPointerEvent<SVGSVGElement>) {
    const dc = drag.current;
    if (dc && (dc.mode === "rect" || dc.mode === "circle")) {
      const [vbx, vby] = eventToVb(e);
      const [wx, wy] = toWorld(vbx, vby);
      if (dc.mode === "rect" && (Math.abs(wx - dc.x0) > 1e-9 || Math.abs(wy - dc.y0) > 1e-9)) createRect(dc.x0, dc.y0, wx, wy);
      if (dc.mode === "circle") {
        const r = Math.hypot(wx - dc.x0, wy - dc.y0);
        if (r > 1e-9) createCircle(dc.x0, dc.y0, r);
      }
      setPreview(null);
    }
    drag.current = null;
  }

  function onWheel(e: React.WheelEvent<SVGSVGElement>) {
    const [vbx, vby] = eventToVb(e);
    const [wx, wy] = toWorld(vbx, vby);
    const zoom = Math.min(1e6, Math.max(1e-4, view.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    setView({ zoom, cx: wx - (vbx - W / 2) / zoom, cy: wy + (vby - H / 2) / zoom });
  }

  // ---- create geometry ----
  function createRect(x0: number, y0: number, x1: number, y1: number) {
    snapshot();
    const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as [number, number][];
    const pts: Pt[] = corners.map(([x, y]) => ({ id: nextId(), x, y, layer: doc.current }));
    const line: Ln = { id: nextId(), pts: pts.map((p) => p.id), closed: true, layer: doc.current };
    setDoc((d) => ({ ...d, points: [...d.points, ...pts], lines: [...d.lines, line] }));
    setSel({ type: "line", id: line.id });
  }
  function createCircle(cx: number, cy: number, r: number) {
    snapshot();
    const c: Circ = { id: nextId(), cx, cy, r, layer: doc.current };
    setDoc((d) => ({ ...d, circles: [...d.circles, c] }));
    setSel({ type: "circle", id: c.id });
  }

  function finishLine(closed: boolean) {
    if (draft.length >= 2) {
      snapshot();
      const newPts: Pt[] = [];
      const ids = draft.map((dp) => {
        if (dp.snap) return dp.snap;
        const p: Pt = { id: nextId(), x: dp.x, y: dp.y, layer: doc.current };
        newPts.push(p);
        return p.id;
      });
      const l: Ln = { id: nextId(), pts: ids, closed, layer: doc.current };
      setDoc((d) => ({ ...d, points: [...d.points, ...newPts], lines: [...d.lines, l] }));
      setSel({ type: "line", id: l.id });
    }
    setDraft([]);
  }

  function deleteSelected() {
    if (!sel) return;
    snapshot();
    setDoc((d) => {
      if (sel.type === "point") {
        const lines = d.lines.map((l) => ({ ...l, pts: l.pts.filter((id) => id !== sel.id) })).filter((l) => l.pts.length >= 2);
        return { ...d, points: d.points.filter((p) => p.id !== sel.id), lines };
      }
      if (sel.type === "line") return { ...d, lines: d.lines.filter((l) => l.id !== sel.id) };
      if (sel.type === "text") return { ...d, texts: d.texts.filter((t) => t.id !== sel.id) };
      if (sel.type === "circle") return { ...d, circles: d.circles.filter((c) => c.id !== sel.id) };
      return { ...d, symbols: d.symbols.filter((s) => s.id !== sel.id) };
    });
    setSel(null);
  }

  // ---- modify (copy / rotate / mirror / scale) about selection centroid ----
  function selCoords(): { x: number; y: number }[] {
    if (!sel) return [];
    if (sel.type === "point") { const p = doc.points.find((p) => p.id === sel.id); return p ? [{ x: p.x, y: p.y }] : []; }
    if (sel.type === "text") { const t = doc.texts.find((t) => t.id === sel.id); return t ? [{ x: t.x, y: t.y }] : []; }
    if (sel.type === "symbol") { const s = doc.symbols.find((s) => s.id === sel.id); return s ? [{ x: s.x, y: s.y }] : []; }
    if (sel.type === "circle") { const c = doc.circles.find((c) => c.id === sel.id); return c ? [{ x: c.cx, y: c.cy }] : []; }
    const l = doc.lines.find((l) => l.id === sel.id);
    if (!l) return [];
    const uniq = Array.from(new Set(l.pts)); // dedupe so a revisited vertex doesn't bias the centroid
    return (uniq.map((id) => pointById(id)).filter(Boolean) as Pt[]).map((p) => ({ x: p.x, y: p.y }));
  }
  function modify(kind: "copy" | "rotate" | "mirrorV" | "mirrorH" | "scale", param?: number) {
    if (!sel) return;
    const coords = selCoords();
    if (!coords.length) return;
    const cx = coords.reduce((s, p) => s + p.x, 0) / coords.length;
    const cy = coords.reduce((s, p) => s + p.y, 0) / coords.length;
    let map: (x: number, y: number) => [number, number];
    let rFactor = 1;
    if (kind === "copy") { const dx = 24 / view.zoom, dy = -24 / view.zoom; map = (x, y) => [x + dx, y + dy]; }
    else if (kind === "rotate") { if (!Number.isFinite(param)) return; const a = ((param ?? 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); map = (x, y) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]; }
    else if (kind === "mirrorV") map = (x, y) => [2 * cx - x, y];
    else if (kind === "mirrorH") map = (x, y) => [x, 2 * cy - y];
    else { const f = param; if (!Number.isFinite(f) || f === 0) return; rFactor = f as number; map = (x, y) => [cx + (x - cx) * (f as number), cy + (y - cy) * (f as number)]; }
    snapshot();
    applyModify(map, rFactor, kind === "copy");
  }
  function applyModify(map: (x: number, y: number) => [number, number], rFactor: number, copy: boolean) {
    if (!sel) return;
    const d = doc;
    if (sel.type === "point") {
      const p = d.points.find((p) => p.id === sel.id); if (!p) return;
      const [x, y] = map(p.x, p.y);
      if (copy) { const np = { ...p, id: nextId(), x, y }; setDoc({ ...d, points: [...d.points, np] }); setSel({ type: "point", id: np.id }); }
      else setDoc({ ...d, points: d.points.map((q) => (q.id === p.id ? { ...q, x, y } : q)) });
    } else if (sel.type === "text") {
      const t = d.texts.find((t) => t.id === sel.id); if (!t) return;
      const [x, y] = map(t.x, t.y);
      if (copy) { const nt = { ...t, id: nextId(), x, y }; setDoc({ ...d, texts: [...d.texts, nt] }); setSel({ type: "text", id: nt.id }); }
      else setDoc({ ...d, texts: d.texts.map((q) => (q.id === t.id ? { ...q, x, y } : q)) });
    } else if (sel.type === "symbol") {
      const s = d.symbols.find((s) => s.id === sel.id); if (!s) return;
      const [x, y] = map(s.x, s.y);
      if (copy) { const ns = { ...s, id: nextId(), x, y }; setDoc({ ...d, symbols: [...d.symbols, ns] }); setSel({ type: "symbol", id: ns.id }); }
      else setDoc({ ...d, symbols: d.symbols.map((q) => (q.id === s.id ? { ...q, x, y } : q)) });
    } else if (sel.type === "circle") {
      const c = d.circles.find((c) => c.id === sel.id); if (!c) return;
      const [x, y] = map(c.cx, c.cy); const r = c.r * Math.abs(rFactor);
      if (copy) { const nc = { ...c, id: nextId(), cx: x, cy: y, r }; setDoc({ ...d, circles: [...d.circles, nc] }); setSel({ type: "circle", id: nc.id }); }
      else setDoc({ ...d, circles: d.circles.map((q) => (q.id === c.id ? { ...q, cx: x, cy: y, r } : q)) });
    } else {
      const l = d.lines.find((l) => l.id === sel.id); if (!l) return;
      if (copy) {
        const newPts: Pt[] = [];
        const ids = l.pts.map((id) => { const p = d.points.find((p) => p.id === id); const [x, y] = p ? map(p.x, p.y) : [0, 0]; const np: Pt = { id: nextId(), x, y, layer: p?.layer ?? l.layer }; newPts.push(np); return np.id; });
        const nl: Ln = { ...l, id: nextId(), pts: ids };
        setDoc({ ...d, points: [...d.points, ...newPts], lines: [...d.lines, nl] });
        setSel({ type: "line", id: nl.id });
      } else {
        // Fork vertices shared with OTHER lines so an in-place transform doesn't drag connected geometry.
        const otherUsed = new Set<string>();
        for (const ol of d.lines) if (ol.id !== l.id) for (const id of ol.pts) otherUsed.add(id);
        const remap = new Map<string, string>();
        const forked: Pt[] = [];
        for (const id of l.pts) {
          if (otherUsed.has(id) && !remap.has(id)) {
            const p = d.points.find((p) => p.id === id);
            if (p) { const np: Pt = { ...p, id: nextId() }; forked.push(np); remap.set(id, np.id); }
          }
        }
        const newPts = l.pts.map((id) => remap.get(id) ?? id);
        const movedIds = new Set(newPts);
        const points = [...d.points, ...forked].map((p) => (movedIds.has(p.id) ? { ...p, ...mapObj(map, p) } : p));
        const lines = d.lines.map((ll) => (ll.id === l.id ? { ...ll, pts: newPts } : ll));
        setDoc({ ...d, points, lines });
      }
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (ctrl && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); return; }
    if (e.key === "Delete" || e.key === "Backspace") { if (sel) { e.preventDefault(); deleteSelected(); } }
    else if (e.key === "Escape") { setDraft([]); setSel(null); setMeasure(null); }
    else if (e.key === "Enter" && tool === "line") finishLine(false);
  }

  // ---- view ----
  function worldBBox(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const xs: number[] = [], ys: number[] = [];
    for (const p of doc.points) { xs.push(p.x); ys.push(p.y); }
    for (const t of doc.texts) { xs.push(t.x); ys.push(t.y); }
    for (const s of doc.symbols) { xs.push(s.x); ys.push(s.y); }
    for (const c of doc.circles) { xs.push(c.cx - c.r, c.cx + c.r); ys.push(c.cy - c.r, c.cy + c.r); }
    if (!xs.length) return null;
    return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  }
  function fit() {
    const b = worldBBox();
    if (!b) { setView({ cx: 0, cy: 0, zoom: 1 }); return; }
    const zoom = Math.min((W * 0.82) / Math.max(b.maxX - b.minX, 1), (H * 0.82) / Math.max(b.maxY - b.minY, 1));
    setView({ cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, zoom: isFinite(zoom) && zoom > 0 ? zoom : 1 });
  }
  const zoomBy = (f: number) => setView((v) => ({ ...v, zoom: Math.min(1e6, Math.max(1e-4, v.zoom * f)) }));

  // ---- layer ops ----
  function setCurrent(id: string) { setDoc((d) => ({ ...d, current: id })); }
  function addLayer() {
    snapshot();
    let n = 1, name = "Layer 1";
    while (doc.layers.some((l) => l.name === name)) name = `Layer ${++n}`;
    const l: Layer = { id: nextId(), name, color: PALETTE[doc.layers.length % PALETTE.length], linetype: "continuous", lineweight: 1, visible: true, locked: false };
    setDoc((d) => ({ ...d, layers: [...d.layers, l], current: l.id }));
  }
  function updateLayer(id: string, patch: Partial<Layer>) {
    setDoc((d) => ({ ...d, layers: d.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));
  }
  function deleteLayer(id: string) {
    if (doc.layers.length <= 1) return;
    snapshot();
    setDoc((d) => {
      const fallback = d.layers.find((l) => l.id !== id)!.id;
      const reassign = <T extends { layer: string }>(arr: T[]) => arr.map((e) => (e.layer === id ? { ...e, layer: fallback } : e));
      return {
        ...d,
        layers: d.layers.filter((l) => l.id !== id),
        current: d.current === id ? fallback : d.current,
        points: reassign(d.points), lines: reassign(d.lines), texts: reassign(d.texts), symbols: reassign(d.symbols), circles: reassign(d.circles),
      };
    });
  }

  // ---- import / export ----
  function importTopo() {
    if (!topoResult) return;
    snapshot();
    const pts: Pt[] = topoResult.points.map((p) => ({ id: nextId(), x: p.x, y: p.y, label: p.name ?? undefined, layer: doc.current }));
    setDoc((d) => ({ ...d, points: [...d.points, ...pts] }));
    setTimeout(fit, 0);
  }
  function importCogo() {
    if (!cogoResult) return;
    snapshot();
    const pts: Pt[] = cogoResult.points.map((p) => ({ id: nextId(), x: p.east, y: p.north, label: p.name ?? undefined, layer: doc.current }));
    const boundaryId = doc.layers.find((l) => l.name.toLowerCase() === "boundary")?.id ?? doc.current;
    const line: Ln = { id: nextId(), pts: pts.map((p) => p.id), closed: cogoResult.type === "closed", layer: boundaryId };
    setDoc((d) => ({ ...d, points: [...d.points, ...pts], lines: [...d.lines, line] }));
    setTimeout(fit, 0);
  }
  function mergeDrawing(g: ImportedDrawing) {
    snapshot();
    const layers = [...doc.layers];
    const byName = new Map(layers.map((l) => [l.name.toLowerCase(), l] as const));
    const ensure = (name?: string): string => {
      if (!name) return doc.current;
      const ex = byName.get(name.toLowerCase());
      if (ex) return ex.id;
      const nl: Layer = { id: nextId(), name, color: PALETTE[layers.length % PALETTE.length], linetype: "continuous", lineweight: 1, visible: true, locked: false };
      layers.push(nl); byName.set(name.toLowerCase(), nl);
      return nl.id;
    };
    const points = [...doc.points], lines = [...doc.lines], texts = [...doc.texts];
    for (const p of g.points) points.push({ id: nextId(), x: p.x, y: p.y, label: p.label, layer: ensure(p.layer) });
    for (const pl of g.polylines) {
      const lid = ensure(pl.layer);
      const ids = pl.pts.map((v) => { const id = nextId(); points.push({ id, x: v.x, y: v.y, layer: lid }); return id; });
      if (ids.length >= 2) lines.push({ id: nextId(), pts: ids, closed: pl.closed, layer: lid });
    }
    for (const t of g.texts) texts.push({ id: nextId(), x: t.x, y: t.y, text: t.text, size: Math.max(8, t.height), layer: ensure(t.layer) });
    setDoc({ ...doc, layers, points, lines, texts });
    setTimeout(fit, 0);
  }
  function importDxf(file: File) { const r = new FileReader(); r.onload = () => { try { mergeDrawing(parseDxf(String(r.result))); } catch { /* */ } }; r.readAsText(file); }
  function importShp(file: File) { const r = new FileReader(); r.onload = () => { try { mergeDrawing(parseShp(r.result as ArrayBuffer)); } catch { /* */ } }; r.readAsArrayBuffer(file); }
  function exportDxf() {
    const lname = (id: string) => layerById(id).name;
    const g: ImportedDrawing = {
      points: [
        ...doc.points.map((p) => ({ x: p.x, y: p.y, label: p.label, layer: lname(p.layer) })),
        ...doc.symbols.map((s) => ({ x: s.x, y: s.y, label: s.kind, layer: lname(s.layer) })),
      ],
      polylines: doc.lines
        .map((l) => ({ pts: (l.pts.map((id) => pointById(id)).filter(Boolean) as Pt[]).map((p) => ({ x: p.x, y: p.y })), closed: !!l.closed, layer: lname(l.layer) }))
        .filter((l) => l.pts.length >= 2),
      texts: doc.texts.map((t) => ({ x: t.x, y: t.y, text: t.text, height: t.size, layer: lname(t.layer) })),
    };
    download(new Blob([writeDxf(g)], { type: "application/dxf" }), "drawing.dxf");
  }
  function loadSample() {
    snapshot();
    const mk = (x: number, y: number, layer: string, label?: string): Pt => ({ id: nextId(), x, y, label, layer });
    const a = mk(0, 0, "Boundary", "A"), b = mk(40, 0, "Boundary", "B"), c = mk(40, 30, "Boundary", "C"), d = mk(0, 30, "Boundary", "D");
    setDoc({
      ...emptyDoc(),
      points: [a, b, c, d],
      lines: [{ id: nextId(), pts: [a.id, b.id, c.id, d.id], closed: true, layer: "Boundary" }],
      texts: [{ id: nextId(), x: 20, y: 15, text: "PLOT 4266", size: 14, layer: "Annotation" }],
      symbols: [{ id: nextId(), x: 0, y: 0, kind: "beacon", layer: "0" }, { id: nextId(), x: 40, y: 0, kind: "beacon", layer: "0" }],
      grid: { show: true, interval: 10 },
    });
    setSel(null);
    setTimeout(fit, 0);
  }
  function clearAll() { snapshot(); setDoc(emptyDoc()); setDraft([]); setSel(null); }

  function exportSvg() {
    const svg = svgRef.current, content = contentRef.current;
    if (!svg || !content) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.querySelectorAll("[data-ui]").forEach((n) => n.remove());
    try { const bb = content.getBBox(); const pad = 24; clone.setAttribute("viewBox", `${bb.x - pad} ${bb.y - pad} ${bb.width + 2 * pad} ${bb.height + 2 * pad}`); } catch { /* empty */ }
    const bg = `<rect x="-100000" y="-100000" width="200000" height="200000" fill="white"/>`;
    const out = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="${clone.getAttribute("viewBox")}">${bg}${clone.innerHTML}</svg>`;
    download(new Blob([out], { type: "image/svg+xml" }), "drawing.svg");
  }
  function exportJson() { download(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }), "drawing.json"); }
  function exportCsv() {
    const lname = (id: string) => layerById(id).name;
    const rows = ["Name,Easting,Northing,Layer"];
    for (const p of doc.points) rows.push(`${p.label ?? ""},${p.x},${p.y},${lname(p.layer)}`);
    for (const s of doc.symbols) rows.push(`${s.kind},${s.x},${s.y},${lname(s.layer)}`);
    download(new Blob([rows.join("\r\n")], { type: "text/csv" }), "coordinates.csv");
  }
  function importJsonFile(file: File) {
    const r = new FileReader();
    r.onload = () => { try { const parsed = migrate(JSON.parse(String(r.result))); snapshot(); setDoc(parsed); bumpIds(parsed); setSel(null); setTimeout(fit, 0); } catch { /* */ } };
    r.readAsText(file);
  }
  function bumpIds(d: Doc) {
    const all = [...d.points, ...d.lines, ...d.texts, ...d.symbols, ...d.circles, ...d.layers];
    idRef.current = Math.max(idRef.current, ...all.map((e: { id: string }) => Number(e.id) || 0));
  }
  function recover() { if (!recoverable) return; snapshot(); setDoc(recoverable); bumpIds(recoverable); setSel(null); setRecoverable(null); setTimeout(fit, 0); }

  const jsonRef = useRef<HTMLInputElement>(null);
  const dxfRef = useRef<HTMLInputElement>(null);
  const shpRef = useRef<HTMLInputElement>(null);

  const selStyleEntity =
    sel?.type === "line" ? doc.lines.find((l) => l.id === sel.id) :
    sel?.type === "circle" ? doc.circles.find((c) => c.id === sel.id) : null;
  const measureReadout = measure?.b ? `${Math.hypot(measure.b[0] - measure.a[0], measure.b[1] - measure.a[1]).toFixed(2)} m · ${bearingOf(measure.a, measure.b)}` : null;
  const cursorMode = tool === "select" ? "grab" : "crosshair";

  return (
    <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
      <div className="space-y-4">
        {/* Tools */}
        <Card title="Tools">
          <div className="grid grid-cols-2 gap-1.5 text-xs">
            {([
              ["select", "Select"], ["point", "Point"], ["line", "Line"], ["rect", "Rect"],
              ["circle", "Circle"], ["text", "Text"], ["symbol", "Symbol"], ["measure", "Measure"],
            ] as [Tool, string][]).map(([id, label]) => (
              <button key={id} onClick={() => { setTool(id); setDraft([]); setMeasure(null); }}
                className={`rounded-md px-2 py-1.5 font-medium transition ${tool === id ? "bg-brand text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
                {label}
              </button>
            ))}
          </div>
          {tool === "line" && (
            <div className="mt-2 rounded-md bg-brand-light/40 p-2 text-xs text-brand-dark">
              Click points to join ({draft.length} picked).
              <div className="mt-2 flex gap-2"><Button onClick={() => finishLine(false)}>Finish</Button><Button variant="ghost" onClick={() => finishLine(true)}>Close</Button></div>
            </div>
          )}
          {(tool === "rect" || tool === "circle") && <p className="mt-2 text-xs text-slate-500">Drag to draw on the current layer.</p>}
          {tool === "measure" && <p className="mt-2 text-xs text-slate-500">Click two points. {measureReadout && <span className="font-semibold text-brand-dark">{measureReadout}</span>}</p>}
          {tool === "symbol" && (
            <div className="mt-2 grid grid-cols-4 gap-1">
              {SYMBOLS.map((s) => (
                <button key={s.kind} title={s.label} onClick={() => setSymbolKind(s.kind)}
                  className={`grid place-items-center rounded-md border p-1 ${symbolKind === s.kind ? "border-brand bg-brand-light/50" : "border-slate-200 hover:bg-slate-50"}`}>
                  <svg viewBox="-12 -12 24 24" className="h-6 w-6">{symbolGlyph(s.kind, 0, 0, "#0f172a", 1.3)}</svg>
                </button>
              ))}
            </div>
          )}
        </Card>

        {/* Layers */}
        <Card title="Layers">
          <div className="space-y-1.5">
            {doc.layers.map((l) => (
              <div key={l.id} className={`flex items-center gap-1.5 rounded-md border px-1.5 py-1 ${doc.current === l.id ? "border-brand bg-brand-light/30" : "border-slate-200"}`}>
                <button title={l.visible ? "Hide" : "Show"} onClick={() => updateLayer(l.id, { visible: !l.visible })} className="text-sm">{l.visible ? "Hide" : "Show"}</button>
                <input type="color" value={l.color} onChange={(e) => updateLayer(l.id, { color: e.target.value })} className="h-5 w-5 cursor-pointer rounded border-0 bg-transparent p-0" title="Colour" />
                <button onClick={() => setCurrent(l.id)} className="flex-1 truncate text-left text-xs font-medium text-slate-700" title="Set current layer">{l.name}{doc.current === l.id ? " (current)" : ""}</button>
                <button title={l.locked ? "Unlock" : "Lock"} onClick={() => updateLayer(l.id, { locked: !l.locked })} className="text-xs">{l.locked ? "Unlock" : "Lock"}</button>
                {doc.layers.length > 1 && <button title="Delete layer" onClick={() => deleteLayer(l.id)} className="text-xs text-red-500 hover:text-red-700">Del</button>}
              </div>
            ))}
          </div>
          {/* current layer linetype / lineweight */}
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Field label="Linetype"><Select value={layerById(doc.current).linetype} onChange={(v) => updateLayer(doc.current, { linetype: v as Linetype })} options={LTYPES} /></Field>
            <Field label="Lineweight"><Select value={String(layerById(doc.current).lineweight)} onChange={(v) => updateLayer(doc.current, { lineweight: Number(v) })} options={LWEIGHTS.map((w) => ({ value: String(w), label: `${w} px` }))} /></Field>
          </div>
          <div className="mt-2"><Button variant="ghost" onClick={addLayer}>Add layer</Button></div>
        </Card>

        {/* Coordinate grid */}
        <Card title="Coordinate Grid">
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={doc.grid.show} onChange={(e) => setDoc((d) => ({ ...d, grid: { ...d.grid, show: e.target.checked } }))} /> Show labelled grid
          </label>
          <div className="mt-2"><Field label="Grid interval (m)"><Input type="number" value={doc.grid.interval} onChange={(v) => setDoc((d) => ({ ...d, grid: { ...d.grid, interval: Number(v) || 0 } }))} /></Field></div>
        </Card>

        {/* Modify (when something selected) */}
        {sel && (
          <Card title="Modify">
            <div className="grid grid-cols-2 gap-2">
              <Button variant="ghost" onClick={() => modify("copy")}>Copy</Button>
              <Button variant="ghost" onClick={() => modify("mirrorV")}>Mirror ↔</Button>
              <Button variant="ghost" onClick={() => modify("mirrorH")}>Mirror ↕</Button>
              <Button variant="ghost" onClick={deleteSelected}>Delete</Button>
            </div>
            <div className="mt-2 flex items-end gap-2">
              <Field label="Rotate °"><Input type="number" value={rot} onChange={setRot} /></Field>
              <Button variant="ghost" onClick={() => modify("rotate", Number(rot))}>↻ Rotate</Button>
            </div>
            <div className="mt-2 flex items-end gap-2">
              <Field label="Scale ×"><Input type="number" value={scl} onChange={setScl} /></Field>
              <Button variant="ghost" onClick={() => modify("scale", Number(scl))}>Scale</Button>
            </div>
          </Card>
        )}

        {/* Selected props */}
        {sel && (
          <Card title="Selected">
            <Field label="Layer">
              <Select value={(getSelLayer() ?? doc.current)} onChange={(v) => setSelLayer(v)} options={doc.layers.map((l) => ({ value: l.id, label: l.name }))} />
            </Field>
            {sel.type === "point" && (
              <div className="mt-2"><Field label="Label"><Input value={doc.points.find((p) => p.id === sel.id)?.label ?? ""} onChange={(v) => setDoc((d) => ({ ...d, points: d.points.map((p) => (p.id === sel.id ? { ...p, label: v } : p)) }))} /></Field></div>
            )}
            {sel.type === "text" && (
              <div className="mt-2 space-y-2">
                <Field label="Text"><Input value={doc.texts.find((t) => t.id === sel.id)?.text ?? ""} onChange={(v) => setDoc((d) => ({ ...d, texts: d.texts.map((t) => (t.id === sel.id ? { ...t, text: v } : t)) }))} /></Field>
                <Field label="Size"><Input type="number" value={doc.texts.find((t) => t.id === sel.id)?.size ?? 14} onChange={(v) => setDoc((d) => ({ ...d, texts: d.texts.map((t) => (t.id === sel.id ? { ...t, size: Number(v) || 12 } : t)) }))} /></Field>
              </div>
            )}
            {sel.type === "symbol" && (
              <div className="mt-2"><Field label="Symbol"><Select value={doc.symbols.find((s) => s.id === sel.id)?.kind ?? "beacon"} onChange={(v) => setDoc((d) => ({ ...d, symbols: d.symbols.map((s) => (s.id === sel.id ? { ...s, kind: v as SymbolKind } : s)) }))} options={SYMBOLS.map((s) => ({ value: s.kind, label: s.label }))} /></Field></div>
            )}
            {sel.type === "line" && (
              <label className="mt-2 flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={!!doc.lines.find((l) => l.id === sel.id)?.closed} onChange={(e) => setDoc((d) => ({ ...d, lines: d.lines.map((l) => (l.id === sel.id ? { ...l, closed: e.target.checked } : l)) }))} /> Closed polygon
              </label>
            )}
            {selStyleEntity && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Field label="Linetype (override)"><Select value={(selStyleEntity.linetype ?? "")} onChange={(v) => setSelStyle({ linetype: (v || undefined) as Linetype | undefined })} options={[{ value: "", label: "ByLayer" }, ...LTYPES]} /></Field>
                <Field label="Lineweight"><Select value={selStyleEntity.lineweight != null ? String(selStyleEntity.lineweight) : ""} onChange={(v) => setSelStyle({ lineweight: v ? Number(v) : undefined })} options={[{ value: "", label: "ByLayer" }, ...LWEIGHTS.map((w) => ({ value: String(w), label: `${w} px` }))]} /></Field>
              </div>
            )}
          </Card>
        )}

        {/* History + IO */}
        <Card title="Drawing">
          {recoverable && (
            <div className="mb-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800">
              Autosaved drawing found.
              <div className="mt-1"><Button variant="ghost" onClick={recover}>↺ Recover last session</Button></div>
            </div>
          )}
          <div className="mb-2 grid grid-cols-2 gap-2">
            <Button variant="ghost" onClick={undo} disabled={!past.current.length}>↶ Undo</Button>
            <Button variant="ghost" onClick={redo} disabled={!future.current.length}>↷ Redo</Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="ghost" onClick={() => zoomBy(1.25)}>Zoom in</Button>
            <Button variant="ghost" onClick={() => zoomBy(1 / 1.25)}>Zoom out</Button>
            <Button variant="ghost" onClick={fit}>Fit</Button>
            <Button variant="ghost" onClick={clearAll}>Clear</Button>
          </div>
          <div className="mt-2 flex flex-col gap-2">
            <Button variant="ghost" onClick={importTopo} disabled={!topoResult}>⬇ Import topo points</Button>
            <Button variant="ghost" onClick={importCogo} disabled={!cogoResult}>⬇ Import COGO figure</Button>
            <div className="flex gap-2"><Button variant="ghost" onClick={() => dxfRef.current?.click()}>Import DXF</Button><Button variant="ghost" onClick={() => shpRef.current?.click()}>Import SHP</Button></div>
            <Button variant="ghost" onClick={loadSample}>Load sample</Button>
          </div>
          <div className="mt-2 flex flex-col gap-2">
            <Button onClick={exportSvg}>⬇ Export SVG</Button>
            <div className="flex gap-2"><Button variant="ghost" onClick={exportDxf}>Export DXF</Button><Button variant="ghost" onClick={exportCsv}>Export CSV</Button><Button variant="ghost" onClick={exportJson}>Save JSON</Button></div>
            <Button variant="ghost" onClick={() => jsonRef.current?.click()}>Open JSON</Button>
            <input ref={jsonRef} type="file" accept=".json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importJsonFile(f); e.target.value = ""; }} />
            <input ref={dxfRef} type="file" accept=".dxf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importDxf(f); e.target.value = ""; }} />
            <input ref={shpRef} type="file" accept=".shp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importShp(f); e.target.value = ""; }} />
          </div>
        </Card>
      </div>

      {/* Canvas */}
      <Card title="Drafting Canvas" className="overflow-hidden">
        <p className="mb-2 text-xs text-slate-500">Wheel = zoom · drag empty space = pan · coordinates in survey metres (E, N).</p>
        <div tabIndex={0} onKeyDown={onKeyDown} className="rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-brand">
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} xmlns="http://www.w3.org/2000/svg"
            style={{ width: "100%", height: "auto", background: "#f8fafc", touchAction: "none", cursor: cursorMode }}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp} onWheel={onWheel}>
            <g data-ui>{faintGrid(view, toScreen)}</g>

            <g ref={contentRef} data-content>
              {doc.grid.show && labelledGrid(view, toScreen, doc.grid.interval, layerById("Grid")?.color ?? "#cbd5e1")}
              {/* circles */}
              {doc.circles.map((cc) => {
                if (!visible(cc.layer)) return null;
                const [x, y] = toScreen(cc.cx, cc.cy); const st = styleOf(cc);
                return <circle key={cc.id} cx={x} cy={y} r={cc.r * view.zoom} fill="none" stroke={st.color} strokeWidth={st.width} strokeDasharray={st.dash} />;
              })}
              {/* lines */}
              {doc.lines.map((l) => {
                if (!visible(l.layer)) return null;
                const pts = l.pts.map((id) => pointById(id)).filter(Boolean) as Pt[];
                if (pts.length < 2) return null;
                const d = pts.map((p) => toScreen(p.x, p.y).join(",")).join(" ");
                const st = styleOf(l);
                return l.closed
                  ? <polygon key={l.id} points={d} fill="none" stroke={st.color} strokeWidth={st.width} strokeDasharray={st.dash} />
                  : <polyline key={l.id} points={d} fill="none" stroke={st.color} strokeWidth={st.width} strokeDasharray={st.dash} />;
              })}
              {/* symbols */}
              {doc.symbols.map((s) => { if (!visible(s.layer)) return null; const [x, y] = toScreen(s.x, s.y); return <g key={s.id}>{symbolGlyph(s.kind, x, y, layerById(s.layer).color, layerById(s.layer).lineweight)}</g>; })}
              {/* points */}
              {doc.points.map((p) => {
                if (!visible(p.layer)) return null;
                const [x, y] = toScreen(p.x, p.y); const col = layerById(p.layer).color;
                return <g key={p.id}><circle cx={x} cy={y} r={2.5} fill="white" stroke={col} strokeWidth={1.2} />{p.label && <text x={x + 6} y={y - 5} fontSize={11} fontWeight="bold" fill={col}>{p.label}</text>}</g>;
              })}
              {/* texts */}
              {doc.texts.map((t) => { if (!visible(t.layer)) return null; const [x, y] = toScreen(t.x, t.y); return <text key={t.id} x={x} y={y} fontSize={t.size} fill={t.color ?? layerById(t.layer).color}>{t.text}</text>; })}
            </g>

            {/* UI overlays */}
            <g data-ui>
              {draft.length > 0 && <polyline points={draft.map((p) => toScreen(p.x, p.y).join(",")).join(" ")} fill="none" stroke="#059669" strokeWidth={1.6} strokeDasharray="5 4" />}
              {preview && drag.current?.mode === "rect" && rectPreview(drag.current.x0, drag.current.y0, preview[0], preview[1], toScreen)}
              {preview && drag.current?.mode === "circle" && circlePreview(drag.current.x0, drag.current.y0, preview[0], preview[1], toScreen, view.zoom)}
              {measure && measureOverlay(measure, toScreen, measureReadout)}
              {selectionHandles(sel, doc, toScreen, view.zoom)}
            </g>
          </svg>
        </div>
      </Card>
    </div>
  );

  // ---- selected-layer / style setters (closures over doc/sel) ----
  function getSelLayer(): string | null {
    if (!sel) return null;
    const arr = sel.type === "point" ? doc.points : sel.type === "line" ? doc.lines : sel.type === "text" ? doc.texts : sel.type === "symbol" ? doc.symbols : doc.circles;
    return (arr as { id: string; layer: string }[]).find((e) => e.id === sel.id)?.layer ?? null;
  }
  function setSelLayer(layer: string) {
    if (!sel) return;
    snapshot();
    const key = (sel.type + "s") as "points" | "lines" | "texts" | "symbols" | "circles";
    setDoc((d) => ({ ...d, [key]: (d[key] as { id: string }[]).map((e) => (e.id === sel.id ? { ...e, layer } : e)) }) as Doc);
  }
  function setSelStyle(patch: { linetype?: Linetype; lineweight?: number }) {
    if (!sel || (sel.type !== "line" && sel.type !== "circle")) return;
    snapshot();
    const key = sel.type === "line" ? "lines" : "circles";
    setDoc((d) => ({ ...d, [key]: (d[key] as (Ln | Circ)[]).map((e) => (e.id === sel.id ? { ...e, ...patch } : e)) }) as Doc);
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------
function symbolGlyph(kind: SymbolKind, x: number, y: number, c: string, lw: number) {
  const sw = Math.max(1, lw);
  switch (kind) {
    case "beacon": return <><circle cx={x} cy={y} r={5} fill="white" stroke={c} strokeWidth={sw} /><circle cx={x} cy={y} r={1.4} fill={c} /></>;
    case "peg": return <rect x={x - 4} y={y - 4} width={8} height={8} fill="white" stroke={c} strokeWidth={sw} />;
    case "trig": return <><polygon points={`${x},${y - 7} ${x - 6},${y + 5} ${x + 6},${y + 5}`} fill="white" stroke={c} strokeWidth={sw} /><circle cx={x} cy={y + 1} r={1.3} fill={c} /></>;
    case "benchmark": return <><polygon points={`${x},${y - 6} ${x - 6},${y + 4} ${x + 6},${y + 4}`} fill="white" stroke={c} strokeWidth={sw} /><text x={x} y={y + 2} textAnchor="middle" fontSize={6} fontWeight="bold" fill={c}>BM</text></>;
    case "borehole": return <><circle cx={x} cy={y} r={6} fill="white" stroke={c} strokeWidth={sw} /><line x1={x - 6} y1={y} x2={x + 6} y2={y} stroke={c} strokeWidth={sw} /><line x1={x} y1={y - 6} x2={x} y2={y + 6} stroke={c} strokeWidth={sw} /></>;
    case "tree": return <><line x1={x} y1={y} x2={x} y2={y + 7} stroke={c} strokeWidth={sw} /><circle cx={x} cy={y - 3} r={5} fill="white" stroke={c} strokeWidth={sw} /></>;
    case "manhole": return <><circle cx={x} cy={y} r={6} fill="white" stroke={c} strokeWidth={sw} /><text x={x} y={y + 3} textAnchor="middle" fontSize={7} fontWeight="bold" fill={c}>MH</text></>;
    case "hydrant": return <><circle cx={x} cy={y} r={5} fill="white" stroke={c} strokeWidth={sw} /><text x={x} y={y + 3} textAnchor="middle" fontSize={7} fontWeight="bold" fill={c}>H</text></>;
    case "culvert": return <><rect x={x - 7} y={y - 3} width={14} height={6} fill="white" stroke={c} strokeWidth={sw} /></>;
    case "pole": return <><circle cx={x} cy={y} r={4} fill={c} /><circle cx={x} cy={y} r={7} fill="none" stroke={c} strokeWidth={sw} /></>;
    case "gate": return <><line x1={x - 7} y1={y - 5} x2={x - 7} y2={y + 5} stroke={c} strokeWidth={sw} /><line x1={x + 7} y1={y - 5} x2={x + 7} y2={y + 5} stroke={c} strokeWidth={sw} /><line x1={x - 7} y1={y + 5} x2={x + 7} y2={y - 5} stroke={c} strokeWidth={sw} /></>;
    case "level": return <><line x1={x - 5} y1={y - 5} x2={x + 5} y2={y + 5} stroke={c} strokeWidth={sw} /><line x1={x - 5} y1={y + 5} x2={x + 5} y2={y - 5} stroke={c} strokeWidth={sw} /></>;
  }
}

function selectionHandles(sel: Sel, doc: Doc, toScreen: (x: number, y: number) => [number, number], zoom: number) {
  if (!sel) return null;
  const sq = (x: number, y: number, key: string) => <rect key={key} x={x - 3} y={y - 3} width={6} height={6} fill="#059669" stroke="white" strokeWidth={1} />;
  if (sel.type === "point") { const p = doc.points.find((p) => p.id === sel.id); if (!p) return null; const [x, y] = toScreen(p.x, p.y); return sq(x, y, "h"); }
  if (sel.type === "text") { const t = doc.texts.find((t) => t.id === sel.id); if (!t) return null; const [x, y] = toScreen(t.x, t.y); return sq(x, y, "h"); }
  if (sel.type === "symbol") { const s = doc.symbols.find((s) => s.id === sel.id); if (!s) return null; const [x, y] = toScreen(s.x, s.y); return sq(x, y, "h"); }
  if (sel.type === "circle") { const c = doc.circles.find((c) => c.id === sel.id); if (!c) return null; const [x, y] = toScreen(c.cx, c.cy); return <>{sq(x, y, "c")}{sq(x + c.r * zoom, y, "r")}</>; }
  const l = doc.lines.find((l) => l.id === sel.id); if (!l) return null;
  const pts = l.pts.map((id) => doc.points.find((p) => p.id === id)).filter(Boolean) as Pt[];
  return <>{pts.map((p, i) => { const [x, y] = toScreen(p.x, p.y); return sq(x, y, `v${i}`); })}</>;
}

function rectPreview(x0: number, y0: number, x1: number, y1: number, toScreen: (x: number, y: number) => [number, number]) {
  const a = toScreen(x0, y0), b = toScreen(x1, y1);
  return <rect x={Math.min(a[0], b[0])} y={Math.min(a[1], b[1])} width={Math.abs(b[0] - a[0])} height={Math.abs(b[1] - a[1])} fill="rgba(5,150,105,0.06)" stroke="#059669" strokeWidth={1.4} strokeDasharray="5 4" />;
}
function circlePreview(cx: number, cy: number, ex: number, ey: number, toScreen: (x: number, y: number) => [number, number], zoom: number) {
  const c = toScreen(cx, cy); const r = Math.hypot(ex - cx, ey - cy) * zoom;
  return <circle cx={c[0]} cy={c[1]} r={r} fill="none" stroke="#059669" strokeWidth={1.4} strokeDasharray="5 4" />;
}
function measureOverlay(m: { a: [number, number]; b: [number, number] | null }, toScreen: (x: number, y: number) => [number, number], readout: string | null) {
  const a = toScreen(m.a[0], m.a[1]);
  const b = m.b ? toScreen(m.b[0], m.b[1]) : null;
  return (
    <g>
      <circle cx={a[0]} cy={a[1]} r={3} fill="#2563eb" />
      {b && <>
        <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#2563eb" strokeWidth={1.4} strokeDasharray="6 3" />
        <circle cx={b[0]} cy={b[1]} r={3} fill="#2563eb" />
        {readout && <text x={(a[0] + b[0]) / 2} y={(a[1] + b[1]) / 2 - 6} textAnchor="middle" fontSize={11} fontWeight="bold" fill="#2563eb">{readout}</text>}
      </>}
    </g>
  );
}

function faintGrid(view: { cx: number; cy: number; zoom: number }, toScreen: (x: number, y: number) => [number, number]) {
  const target = 60 / view.zoom;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const n = target / pow;
  const step = (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * pow;
  const wx0 = view.cx - W / 2 / view.zoom, wx1 = view.cx + W / 2 / view.zoom;
  const wy0 = view.cy - H / 2 / view.zoom, wy1 = view.cy + H / 2 / view.zoom;
  const out: JSX.Element[] = [];
  if (!isFinite(step) || step <= 0) return out;
  for (let x = Math.ceil(wx0 / step) * step; x <= wx1; x += step) { const [sx] = toScreen(x, 0); out.push(<line key={`gx${x}`} x1={sx} y1={0} x2={sx} y2={H} stroke="#eef2f7" strokeWidth={1} />); }
  for (let y = Math.ceil(wy0 / step) * step; y <= wy1; y += step) { const [, sy] = toScreen(0, y); out.push(<line key={`gy${y}`} x1={0} y1={sy} x2={W} y2={sy} stroke="#eef2f7" strokeWidth={1} />); }
  return out;
}

function labelledGrid(view: { cx: number; cy: number; zoom: number }, toScreen: (x: number, y: number) => [number, number], interval: number, color: string) {
  if (!(interval > 0)) return null;
  const wx0 = view.cx - W / 2 / view.zoom, wx1 = view.cx + W / 2 / view.zoom;
  const wy0 = view.cy - H / 2 / view.zoom, wy1 = view.cy + H / 2 / view.zoom;
  if ((wx1 - wx0) / interval > 400 || (wy1 - wy0) / interval > 400) return null; // too dense
  const out: JSX.Element[] = [];
  for (let x = Math.ceil(wx0 / interval) * interval; x <= wx1; x += interval) {
    const [sx] = toScreen(x, 0);
    out.push(<line key={`lx${x}`} x1={sx} y1={0} x2={sx} y2={H} stroke={color} strokeWidth={0.7} strokeDasharray="2 4" />);
    out.push(<text key={`lxt${x}`} x={sx + 2} y={H - 4} fontSize={9} fill="#475569">E {Math.round(x)}</text>);
  }
  for (let y = Math.ceil(wy0 / interval) * interval; y <= wy1; y += interval) {
    const [, sy] = toScreen(0, y);
    out.push(<line key={`ly${y}`} x1={0} y1={sy} x2={W} y2={sy} stroke={color} strokeWidth={0.7} strokeDasharray="2 4" />);
    out.push(<text key={`lyt${y}`} x={3} y={sy - 3} fontSize={9} fill="#475569">N {Math.round(y)}</text>);
  }
  return <g>{out}</g>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
function mapObj(map: (x: number, y: number) => [number, number], p: { x: number; y: number }) {
  const [x, y] = map(p.x, p.y);
  return { x, y };
}
function dashArray(lt: Linetype, lw: number): string | undefined {
  const u = Math.max(1, lw);
  if (lt === "dashed") return `${u * 6} ${u * 4}`;
  if (lt === "dotted") return `${u} ${u * 3}`;
  if (lt === "dashdot") return `${u * 6} ${u * 3} ${u} ${u * 3}`;
  return undefined;
}
function bearingOf(a: [number, number], b: [number, number]): string {
  let deg = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
  deg = ((deg % 360) + 360) % 360;
  const d = Math.floor(deg), m = Math.floor((deg - d) * 60), s = Math.round(((deg - d) * 60 - m) * 60);
  return `${d}°${String(m).padStart(2, "0")}'${String(s).padStart(2, "0")}"`;
}
function migrate(parsed: any): Doc {
  const base = emptyDoc();
  const layers: Layer[] = (Array.isArray(parsed?.layers) && parsed.layers.length ? parsed.layers : base.layers).map((l: any, i: number) => ({
    id: String(l?.id ?? l?.name ?? `L${i}`),
    name: String(l?.name ?? l?.id ?? `Layer ${i}`),
    color: typeof l?.color === "string" ? l.color : "#0f172a",
    linetype: (["continuous", "dashed", "dotted", "dashdot"].includes(l?.linetype) ? l.linetype : "continuous") as Linetype,
    lineweight: Number(l?.lineweight) > 0 ? Number(l.lineweight) : 1,
    visible: l?.visible !== false,
    locked: !!l?.locked,
  }));
  const d: Doc = {
    layers,
    current: parsed?.current ?? layers[0].id,
    grid: { show: !!parsed?.grid?.show, interval: Number(parsed?.grid?.interval) > 0 ? Number(parsed.grid.interval) : base.grid.interval },
    points: Array.isArray(parsed?.points) ? parsed.points : [],
    lines: Array.isArray(parsed?.lines) ? parsed.lines : [],
    texts: Array.isArray(parsed?.texts) ? parsed.texts : [],
    symbols: Array.isArray(parsed?.symbols) ? parsed.symbols : [],
    circles: Array.isArray(parsed?.circles) ? parsed.circles : [],
  };
  const valid = new Set(d.layers.map((l) => l.id));
  const fix = <T extends { layer?: string }>(arr: T[]) => arr.map((e) => ({ ...e, layer: e.layer && valid.has(e.layer) ? e.layer : d.layers[0].id }));
  d.points = fix(d.points); d.lines = fix(d.lines); d.texts = fix(d.texts); d.symbols = fix(d.symbols); d.circles = fix(d.circles);
  if (!valid.has(d.current)) d.current = d.layers[0].id;
  return d;
}
function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
