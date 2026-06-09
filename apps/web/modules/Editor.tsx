"use client";

import { useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { useStore } from "@/lib/store";
import { Button, Card, Field, Input, Select } from "@/components/ui";
import { parseDxf, writeDxf, type ImportedDrawing } from "@/lib/dxf";
import { parseShp } from "@/lib/shp";

// ---------------------------------------------------------------------------
// Drawing model
// ---------------------------------------------------------------------------
interface Pt { id: string; x: number; y: number; label?: string }
interface Ln { id: string; pts: string[]; closed?: boolean }
interface Txt { id: string; x: number; y: number; text: string; size: number }
interface Sym { id: string; x: number; y: number; kind: SymbolKind }
interface Doc { points: Pt[]; lines: Ln[]; texts: Txt[]; symbols: Sym[] }

type Tool = "select" | "point" | "line" | "text" | "symbol";
type Sel = { type: "point" | "line" | "text" | "symbol"; id: string } | null;

type SymbolKind = "beacon" | "peg" | "trig" | "borehole" | "tree" | "manhole" | "pole" | "level";
const SYMBOLS: { kind: SymbolKind; label: string }[] = [
  { kind: "beacon", label: "Beacon" },
  { kind: "peg", label: "Iron peg" },
  { kind: "trig", label: "Trig" },
  { kind: "borehole", label: "Borehole" },
  { kind: "tree", label: "Tree" },
  { kind: "manhole", label: "Manhole" },
  { kind: "pole", label: "Pole" },
  { kind: "level", label: "Spot level" },
];

const W = 920;
const H = 640;
const SNAP_PX = 12;

export function Editor() {
  const { topoResult, cogoResult } = useStore();
  const svgRef = useRef<SVGSVGElement>(null);
  const contentRef = useRef<SVGGElement>(null);
  const idRef = useRef(0);
  const nextId = () => String(++idRef.current);

  const [doc, setDoc] = useState<Doc>({ points: [], lines: [], texts: [], symbols: [] });
  const [view, setView] = useState({ cx: 0, cy: 0, zoom: 1 });
  const [tool, setTool] = useState<Tool>("select");
  const [symbolKind, setSymbolKind] = useState<SymbolKind>("beacon");
  const [sel, setSel] = useState<Sel>(null);
  const [draft, setDraft] = useState<string[]>([]); // point ids being joined into a line

  // mutable drag/pan state (read inside pointer handlers)
  const drag = useRef<
    | { mode: "elem"; type: "point" | "text" | "symbol"; id: string }
    | { mode: "pan"; startVbX: number; startVbY: number; startCx: number; startCy: number }
    | null
  >(null);

  // ---- undo / redo history ----
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

  // ---- coordinate transforms (world E/N <-> screen viewBox; north up) ----
  const toScreen = (x: number, y: number): [number, number] => [
    (x - view.cx) * view.zoom + W / 2,
    H / 2 - (y - view.cy) * view.zoom,
  ];
  const toWorld = (sx: number, sy: number): [number, number] => [
    view.cx + (sx - W / 2) / view.zoom,
    view.cy - (sy - H / 2) / view.zoom,
  ];
  function eventToVb(e: RPointerEvent | React.WheelEvent): [number, number] {
    const svg = svgRef.current!;
    const r = svg.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  }

  const pointById = (id: string) => doc.points.find((p) => p.id === id);
  function nearestPoint(wx: number, wy: number): Pt | null {
    let best: Pt | null = null;
    let bestD = (SNAP_PX / view.zoom) ** 2;
    for (const p of doc.points) {
      const d = (p.x - wx) ** 2 + (p.y - wy) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  // ---- hit testing for the select tool (screen space) ----
  function hitTest(sx: number, sy: number): Sel {
    const near = (ax: number, ay: number, r: number) => (ax - sx) ** 2 + (ay - sy) ** 2 <= r * r;
    for (const s of doc.symbols) {
      const [x, y] = toScreen(s.x, s.y);
      if (near(x, y, 12)) return { type: "symbol", id: s.id };
    }
    for (const t of doc.texts) {
      const [x, y] = toScreen(t.x, t.y);
      if (sx >= x - 4 && sx <= x + t.text.length * t.size * 0.6 + 4 && sy >= y - t.size && sy <= y + 4)
        return { type: "text", id: t.id };
    }
    for (const p of doc.points) {
      const [x, y] = toScreen(p.x, p.y);
      if (near(x, y, 9)) return { type: "point", id: p.id };
    }
    for (const l of doc.lines) {
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
      const p: Pt = { id: nextId(), x: wx, y: wy };
      setDoc((d) => ({ ...d, points: [...d.points, p] }));
      setSel({ type: "point", id: p.id });
      return;
    }
    if (tool === "text") {
      snapshot();
      const t: Txt = { id: nextId(), x: wx, y: wy, text: "Text", size: 14 };
      setDoc((d) => ({ ...d, texts: [...d.texts, t] }));
      setSel({ type: "text", id: t.id });
      return;
    }
    if (tool === "symbol") {
      snapshot();
      const s: Sym = { id: nextId(), x: wx, y: wy, kind: symbolKind };
      setDoc((d) => ({ ...d, symbols: [...d.symbols, s] }));
      setSel({ type: "symbol", id: s.id });
      return;
    }
    if (tool === "line") {
      // snap to an existing point, else create one
      const snap = nearestPoint(wx, wy);
      let id: string;
      if (snap) {
        id = snap.id;
      } else {
        snapshot();
        const p: Pt = { id: nextId(), x: wx, y: wy };
        setDoc((d) => ({ ...d, points: [...d.points, p] }));
        id = p.id;
      }
      setDraft((dr) => [...dr, id]);
      return;
    }
    // select tool: hit test -> drag element, else pan
    const hit = hitTest(vbx, vby);
    setSel(hit);
    if (hit && hit.type !== "line") {
      dragSnapped.current = false;
      drag.current = { mode: "elem", type: hit.type, id: hit.id };
    } else {
      drag.current = { mode: "pan", startVbX: vbx, startVbY: vby, startCx: view.cx, startCy: view.cy };
    }
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
    const [wx, wy] = toWorld(vbx, vby);
    if (!dragSnapped.current) {
      snapshot();
      dragSnapped.current = true;
    }
    const { type, id } = dc;
    setDoc((d) => {
      if (type === "point") return { ...d, points: d.points.map((p) => (p.id === id ? { ...p, x: wx, y: wy } : p)) };
      if (type === "text") return { ...d, texts: d.texts.map((t) => (t.id === id ? { ...t, x: wx, y: wy } : t)) };
      return { ...d, symbols: d.symbols.map((s) => (s.id === id ? { ...s, x: wx, y: wy } : s)) };
    });
  }

  function onPointerUp() {
    drag.current = null;
  }

  function onWheel(e: React.WheelEvent<SVGSVGElement>) {
    const [vbx, vby] = eventToVb(e);
    const [wx, wy] = toWorld(vbx, vby);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const zoom = Math.min(1e6, Math.max(1e-4, view.zoom * factor));
    // keep the world point under the cursor fixed
    setView({ zoom, cx: wx - (vbx - W / 2) / zoom, cy: wy + (vby - H / 2) / zoom });
  }

  // ---- line drafting ----
  function finishLine(closed: boolean) {
    if (draft.length >= 2) {
      snapshot();
      const l: Ln = { id: nextId(), pts: [...draft], closed };
      setDoc((d) => ({ ...d, lines: [...d.lines, l] }));
      setSel({ type: "line", id: l.id });
    }
    setDraft([]);
  }

  function deleteSelected() {
    if (!sel) return;
    snapshot();
    setDoc((d) => {
      if (sel.type === "point") {
        const lines = d.lines
          .map((l) => ({ ...l, pts: l.pts.filter((id) => id !== sel.id) }))
          .filter((l) => l.pts.length >= 2);
        return { ...d, points: d.points.filter((p) => p.id !== sel.id), lines };
      }
      if (sel.type === "line") return { ...d, lines: d.lines.filter((l) => l.id !== sel.id) };
      if (sel.type === "text") return { ...d, texts: d.texts.filter((t) => t.id !== sel.id) };
      return { ...d, symbols: d.symbols.filter((s) => s.id !== sel.id) };
    });
    setSel(null);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
      return;
    }
    if (ctrl && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
      e.preventDefault();
      redo();
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (sel) {
        e.preventDefault();
        deleteSelected();
      }
    } else if (e.key === "Escape") {
      setDraft([]);
      setSel(null);
    } else if (e.key === "Enter" && tool === "line") {
      finishLine(false);
    }
  }

  // ---- view helpers ----
  function worldBBox(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const p of doc.points) { xs.push(p.x); ys.push(p.y); }
    for (const t of doc.texts) { xs.push(t.x); ys.push(t.y); }
    for (const s of doc.symbols) { xs.push(s.x); ys.push(s.y); }
    if (!xs.length) return null;
    return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  }
  function fit() {
    const b = worldBBox();
    if (!b) { setView({ cx: 0, cy: 0, zoom: 1 }); return; }
    const spanX = Math.max(b.maxX - b.minX, 1);
    const spanY = Math.max(b.maxY - b.minY, 1);
    const zoom = Math.min((W * 0.82) / spanX, (H * 0.82) / spanY);
    setView({ cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, zoom: isFinite(zoom) && zoom > 0 ? zoom : 1 });
  }
  const zoomBy = (f: number) => setView((v) => ({ ...v, zoom: Math.min(1e6, Math.max(1e-4, v.zoom * f)) }));

  // ---- import / export ----
  function importTopo() {
    if (!topoResult) return;
    snapshot();
    const points: Pt[] = topoResult.points.map((p) => ({ id: nextId(), x: p.x, y: p.y, label: p.name ?? undefined }));
    setDoc((d) => ({ ...d, points: [...d.points, ...points] }));
    setTimeout(fit, 0);
  }
  function importCogo() {
    if (!cogoResult) return;
    snapshot();
    const points: Pt[] = cogoResult.points.map((p) => ({ id: nextId(), x: p.east, y: p.north, label: p.name ?? undefined }));
    const line: Ln = { id: nextId(), pts: points.map((p) => p.id), closed: cogoResult.type === "closed" };
    setDoc((d) => ({ ...d, points: [...d.points, ...points], lines: [...d.lines, line] }));
    setTimeout(fit, 0);
  }
  // Merge an imported drawing (DXF / Shapefile) into the current document.
  function mergeDrawing(g: ImportedDrawing) {
    snapshot();
    const points = [...doc.points];
    const lines = [...doc.lines];
    const texts = [...doc.texts];
    for (const p of g.points) points.push({ id: nextId(), x: p.x, y: p.y, label: p.label });
    for (const pl of g.polylines) {
      const ids = pl.pts.map((v) => {
        const id = nextId();
        points.push({ id, x: v.x, y: v.y });
        return id;
      });
      if (ids.length >= 2) lines.push({ id: nextId(), pts: ids, closed: pl.closed });
    }
    for (const t of g.texts) texts.push({ id: nextId(), x: t.x, y: t.y, text: t.text, size: Math.max(8, t.height) });
    setDoc({ points, lines, texts, symbols: doc.symbols });
    setTimeout(fit, 0);
  }
  function importDxf(file: File) {
    const r = new FileReader();
    r.onload = () => { try { mergeDrawing(parseDxf(String(r.result))); } catch { /* malformed dxf */ } };
    r.readAsText(file);
  }
  function importShp(file: File) {
    const r = new FileReader();
    r.onload = () => { try { mergeDrawing(parseShp(r.result as ArrayBuffer)); } catch { /* malformed shp */ } };
    r.readAsArrayBuffer(file);
  }
  function exportDxf() {
    const g: ImportedDrawing = {
      points: [
        ...doc.points.map((p) => ({ x: p.x, y: p.y, label: p.label })),
        ...doc.symbols.map((s) => ({ x: s.x, y: s.y, label: s.kind })),
      ],
      polylines: doc.lines
        .map((l) => ({
          pts: (l.pts.map((id) => pointById(id)).filter(Boolean) as Pt[]).map((p) => ({ x: p.x, y: p.y })),
          closed: !!l.closed,
        }))
        .filter((l) => l.pts.length >= 2),
      texts: doc.texts.map((t) => ({ x: t.x, y: t.y, text: t.text, height: t.size })),
    };
    download(new Blob([writeDxf(g)], { type: "application/dxf" }), "drawing.dxf");
  }
  function loadSample() {
    snapshot();
    const mk = (x: number, y: number, label?: string): Pt => ({ id: nextId(), x, y, label });
    const a = mk(0, 0, "A"), b = mk(40, 0, "B"), c = mk(40, 30, "C"), d = mk(0, 30, "D");
    setDoc({
      points: [a, b, c, d],
      lines: [{ id: nextId(), pts: [a.id, b.id, c.id, d.id], closed: true }],
      texts: [{ id: nextId(), x: 20, y: 15, text: "PLOT 4266", size: 14 }],
      symbols: [{ id: nextId(), x: 0, y: 0, kind: "beacon" }, { id: nextId(), x: 40, y: 0, kind: "beacon" }],
    });
    setSel(null);
    setTimeout(fit, 0);
  }
  function clearAll() {
    snapshot();
    setDoc({ points: [], lines: [], texts: [], symbols: [] });
    setDraft([]);
    setSel(null);
  }

  function exportSvg() {
    const svg = svgRef.current;
    const content = contentRef.current;
    if (!svg || !content) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.querySelectorAll("[data-ui]").forEach((n) => n.remove());
    try {
      const bb = content.getBBox();
      const pad = 24;
      clone.setAttribute("viewBox", `${bb.x - pad} ${bb.y - pad} ${bb.width + 2 * pad} ${bb.height + 2 * pad}`);
    } catch {
      /* empty drawing — keep default viewBox */
    }
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const bg = `<rect x="-100000" y="-100000" width="200000" height="200000" fill="white"/>`;
    const body = clone.innerHTML;
    const out = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="${clone.getAttribute(
      "viewBox"
    )}">${bg}${body}</svg>`;
    download(new Blob([out], { type: "image/svg+xml" }), "drawing.svg");
  }
  function exportJson() {
    download(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }), "drawing.json");
  }
  function importJsonFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (parsed && parsed.points) {
          setDoc({ points: parsed.points ?? [], lines: parsed.lines ?? [], texts: parsed.texts ?? [], symbols: parsed.symbols ?? [] });
          // keep id counter ahead of any imported ids
          const maxId = Math.max(0, ...[...(parsed.points ?? []), ...(parsed.lines ?? []), ...(parsed.texts ?? []), ...(parsed.symbols ?? [])].map((e: any) => Number(e.id) || 0));
          idRef.current = maxId;
          setSel(null);
          setTimeout(fit, 0);
        }
      } catch {
        /* ignore malformed json */
      }
    };
    reader.readAsText(file);
  }

  const jsonRef = useRef<HTMLInputElement>(null);
  const dxfRef = useRef<HTMLInputElement>(null);
  const shpRef = useRef<HTMLInputElement>(null);
  const selected = sel
    ? sel.type === "point"
      ? doc.points.find((p) => p.id === sel.id)
      : sel.type === "text"
      ? doc.texts.find((t) => t.id === sel.id)
      : sel.type === "symbol"
      ? doc.symbols.find((s) => s.id === sel.id)
      : doc.lines.find((l) => l.id === sel.id)
    : null;

  const cursorMode = tool === "select" ? "grab" : "crosshair";

  return (
    <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
      {/* Controls */}
      <div className="space-y-4">
        <Card title="Tools" icon={<span>✎</span>}>
          <div className="grid grid-cols-2 gap-2 text-sm">
            {(
              [
                ["select", "▭ Select / move"],
                ["point", "• Add point"],
                ["line", "／ Join line"],
                ["text", "T Add text"],
                ["symbol", "✦ Symbol"],
              ] as [Tool, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => { setTool(id); setDraft([]); }}
                className={`rounded-md px-2 py-2 font-medium transition ${
                  tool === id ? "bg-brand text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {label}
              </button>
            ))}
            <button onClick={deleteSelected} disabled={!sel} className="rounded-md border border-red-200 px-2 py-2 font-medium text-red-600 hover:bg-red-50 disabled:opacity-40">
              🗑 Delete
            </button>
          </div>

          {tool === "line" && (
            <div className="mt-3 rounded-md bg-brand-light/40 p-2 text-xs text-brand-dark">
              Click points to join (snaps to existing). {draft.length} picked.
              <div className="mt-2 flex gap-2">
                <Button onClick={() => finishLine(false)}>Finish line</Button>
                <Button variant="ghost" onClick={() => finishLine(true)}>Close polygon</Button>
              </div>
            </div>
          )}

          {tool === "symbol" && (
            <div className="mt-3 grid grid-cols-4 gap-1">
              {SYMBOLS.map((s) => (
                <button
                  key={s.kind}
                  title={s.label}
                  onClick={() => setSymbolKind(s.kind)}
                  className={`grid place-items-center rounded-md border p-1 ${symbolKind === s.kind ? "border-brand bg-brand-light/50" : "border-slate-200 hover:bg-slate-50"}`}
                >
                  <svg viewBox="-12 -12 24 24" className="h-6 w-6">{symbolGlyph(s.kind, 0, 0, false)}</svg>
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card title="Drawing">
          <div className="mb-2 grid grid-cols-2 gap-2">
            <Button variant="ghost" onClick={undo} disabled={!past.current.length}>↶ Undo</Button>
            <Button variant="ghost" onClick={redo} disabled={!future.current.length}>↷ Redo</Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="ghost" onClick={() => zoomBy(1.25)}>＋ Zoom</Button>
            <Button variant="ghost" onClick={() => zoomBy(1 / 1.25)}>－ Zoom</Button>
            <Button variant="ghost" onClick={fit}>⤢ Fit</Button>
            <Button variant="ghost" onClick={clearAll}>✕ Clear</Button>
          </div>
          <div className="mt-2 flex flex-col gap-2">
            <Button variant="ghost" onClick={importTopo} disabled={!topoResult}>⬇ Import topo points</Button>
            <Button variant="ghost" onClick={importCogo} disabled={!cogoResult}>⬇ Import COGO figure</Button>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => dxfRef.current?.click()}>Import DXF</Button>
              <Button variant="ghost" onClick={() => shpRef.current?.click()}>Import SHP</Button>
            </div>
            <Button variant="ghost" onClick={loadSample}>Load sample</Button>
          </div>
          <div className="mt-2 flex flex-col gap-2">
            <Button onClick={exportSvg}>⬇ Export SVG</Button>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={exportDxf}>Export DXF</Button>
              <Button variant="ghost" onClick={exportJson}>Save JSON</Button>
            </div>
            <Button variant="ghost" onClick={() => jsonRef.current?.click()}>Open JSON</Button>
            <input ref={jsonRef} type="file" accept=".json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importJsonFile(f); e.target.value = ""; }} />
            <input ref={dxfRef} type="file" accept=".dxf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importDxf(f); e.target.value = ""; }} />
            <input ref={shpRef} type="file" accept=".shp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importShp(f); e.target.value = ""; }} />
          </div>
        </Card>

        {selected && (
          <Card title="Selected">
            {sel?.type === "point" && (
              <Field label="Label">
                <Input value={(selected as Pt).label ?? ""} onChange={(v) => setDoc((d) => ({ ...d, points: d.points.map((p) => (p.id === sel.id ? { ...p, label: v } : p)) }))} />
              </Field>
            )}
            {sel?.type === "text" && (
              <div className="space-y-2">
                <Field label="Text"><Input value={(selected as Txt).text} onChange={(v) => setDoc((d) => ({ ...d, texts: d.texts.map((t) => (t.id === sel.id ? { ...t, text: v } : t)) }))} /></Field>
                <Field label="Size"><Input type="number" value={(selected as Txt).size} onChange={(v) => setDoc((d) => ({ ...d, texts: d.texts.map((t) => (t.id === sel.id ? { ...t, size: Number(v) || 12 } : t)) }))} /></Field>
              </div>
            )}
            {sel?.type === "symbol" && (
              <Field label="Symbol">
                <Select value={(selected as Sym).kind} onChange={(v) => setDoc((d) => ({ ...d, symbols: d.symbols.map((s) => (s.id === sel.id ? { ...s, kind: v as SymbolKind } : s)) }))} options={SYMBOLS.map((s) => ({ value: s.kind, label: s.label }))} />
              </Field>
            )}
            {sel?.type === "line" && (
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={!!(selected as Ln).closed} onChange={(e) => setDoc((d) => ({ ...d, lines: d.lines.map((l) => (l.id === sel.id ? { ...l, closed: e.target.checked } : l)) }))} />
                Closed polygon
              </label>
            )}
            <div className="mt-3"><Button variant="ghost" onClick={deleteSelected}>🗑 Delete selected</Button></div>
          </Card>
        )}
      </div>

      {/* Canvas */}
      <Card title="Drafting Canvas" className="overflow-hidden">
        <p className="mb-2 text-xs text-slate-500">
          Wheel = zoom · drag empty space = pan · pick a tool on the left. Coordinates are in survey metres (E, N).
        </p>
        <div
          tabIndex={0}
          onKeyDown={onKeyDown}
          className="rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-brand"
        >
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            xmlns="http://www.w3.org/2000/svg"
            style={{ width: "100%", height: "auto", background: "#f8fafc", touchAction: "none", cursor: cursorMode }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            onWheel={onWheel}
          >
            {/* UI: grid */}
            <g data-ui>{grid(view, toScreen)}</g>

            {/* content (exported) */}
            <g ref={contentRef} data-content>
              {/* lines */}
              {doc.lines.map((l) => {
                const pts = l.pts.map((id) => pointById(id)).filter(Boolean) as Pt[];
                if (pts.length < 2) return null;
                const d = pts.map((p) => toScreen(p.x, p.y).join(",")).join(" ");
                const isSel = sel?.type === "line" && sel.id === l.id;
                return l.closed ? (
                  <polygon key={l.id} points={d} fill="rgba(16,185,129,0.06)" stroke={isSel ? "#059669" : "#0f172a"} strokeWidth={isSel ? 2.4 : 1.5} />
                ) : (
                  <polyline key={l.id} points={d} fill="none" stroke={isSel ? "#059669" : "#0f172a"} strokeWidth={isSel ? 2.4 : 1.5} />
                );
              })}
              {/* symbols */}
              {doc.symbols.map((s) => {
                const [x, y] = toScreen(s.x, s.y);
                return <g key={s.id}>{symbolGlyph(s.kind, x, y, sel?.type === "symbol" && sel.id === s.id)}</g>;
              })}
              {/* points */}
              {doc.points.map((p) => {
                const [x, y] = toScreen(p.x, p.y);
                const isSel = sel?.type === "point" && sel.id === p.id;
                return (
                  <g key={p.id}>
                    <circle cx={x} cy={y} r={isSel ? 4.5 : 3} fill="white" stroke={isSel ? "#059669" : "#0f172a"} strokeWidth={isSel ? 2 : 1.3} />
                    {p.label && <text x={x + 6} y={y - 5} fontSize={11} fontWeight="bold" fill="#0f172a">{p.label}</text>}
                  </g>
                );
              })}
              {/* texts */}
              {doc.texts.map((t) => {
                const [x, y] = toScreen(t.x, t.y);
                const isSel = sel?.type === "text" && sel.id === t.id;
                return <text key={t.id} x={x} y={y} fontSize={t.size} fill={isSel ? "#059669" : "#0f172a"} fontWeight={isSel ? "bold" : "normal"}>{t.text}</text>;
              })}
            </g>

            {/* UI: line draft */}
            {draft.length > 0 && (
              <g data-ui>
                <polyline
                  points={(draft.map((id) => pointById(id)).filter(Boolean) as Pt[]).map((p) => toScreen(p.x, p.y).join(",")).join(" ")}
                  fill="none"
                  stroke="#059669"
                  strokeWidth={1.6}
                  strokeDasharray="5 4"
                />
              </g>
            )}
          </svg>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Symbol glyphs (pre-loaded survey symbols)
// ---------------------------------------------------------------------------
function symbolGlyph(kind: SymbolKind, x: number, y: number, sel: boolean) {
  const c = sel ? "#059669" : "#0f172a";
  const sw = sel ? 2 : 1.3;
  switch (kind) {
    case "beacon":
      return <><circle cx={x} cy={y} r={5} fill="white" stroke={c} strokeWidth={sw} /><circle cx={x} cy={y} r={1.4} fill={c} /></>;
    case "peg":
      return <rect x={x - 4} y={y - 4} width={8} height={8} fill="white" stroke={c} strokeWidth={sw} />;
    case "trig":
      return <><polygon points={`${x},${y - 7} ${x - 6},${y + 5} ${x + 6},${y + 5}`} fill="white" stroke={c} strokeWidth={sw} /><circle cx={x} cy={y + 1} r={1.3} fill={c} /></>;
    case "borehole":
      return <><circle cx={x} cy={y} r={6} fill="white" stroke={c} strokeWidth={sw} /><line x1={x - 6} y1={y} x2={x + 6} y2={y} stroke={c} strokeWidth={sw} /><line x1={x} y1={y - 6} x2={x} y2={y + 6} stroke={c} strokeWidth={sw} /></>;
    case "tree":
      return <><line x1={x} y1={y} x2={x} y2={y + 7} stroke={c} strokeWidth={sw} /><circle cx={x} cy={y - 3} r={5} fill="white" stroke={c} strokeWidth={sw} /></>;
    case "manhole":
      return <><circle cx={x} cy={y} r={6} fill="white" stroke={c} strokeWidth={sw} /><text x={x} y={y + 3} textAnchor="middle" fontSize={7} fontWeight="bold" fill={c}>MH</text></>;
    case "pole":
      return <><circle cx={x} cy={y} r={4} fill={c} /><circle cx={x} cy={y} r={7} fill="none" stroke={c} strokeWidth={sw} /></>;
    case "level":
      return <><line x1={x - 5} y1={y - 5} x2={x + 5} y2={y + 5} stroke={c} strokeWidth={sw} /><line x1={x - 5} y1={y + 5} x2={x + 5} y2={y - 5} stroke={c} strokeWidth={sw} /></>;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function grid(view: { cx: number; cy: number; zoom: number }, toScreen: (x: number, y: number) => [number, number]) {
  // adaptive grid spacing (nice 1/2/5 × 10ⁿ) ~60 px apart
  const target = 60 / view.zoom;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const n = target / pow;
  const step = (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * pow;
  const [wx0, wy1] = [view.cx - W / 2 / view.zoom, view.cy + H / 2 / view.zoom];
  const [wx1, wy0] = [view.cx + W / 2 / view.zoom, view.cy - H / 2 / view.zoom];
  const lines: JSX.Element[] = [];
  for (let x = Math.ceil(wx0 / step) * step; x <= wx1; x += step) {
    const [sx] = toScreen(x, 0);
    lines.push(<line key={`gx${x}`} x1={sx} y1={0} x2={sx} y2={H} stroke="#e2e8f0" strokeWidth={1} />);
  }
  for (let y = Math.ceil(wy0 / step) * step; y <= wy1; y += step) {
    const [, sy] = toScreen(0, y);
    lines.push(<line key={`gy${y}`} x1={0} y1={sy} x2={W} y2={sy} stroke="#e2e8f0" strokeWidth={1} />);
  }
  return lines;
}
