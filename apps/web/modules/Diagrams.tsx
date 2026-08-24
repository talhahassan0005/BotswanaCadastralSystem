"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useStore, cogoTabLabel } from "@/lib/store";
import { Button, Card, Field, Input, Select } from "@/components/ui";
import { beaconMap, parcelMetrics, ringPoints } from "@/lib/server/parcel";
import type { CogoResult, ParcelDoc } from "@/lib/types";
import { SgDiagram, type DiagramKind, type DiagramMeta, type DiagramTransform, type ManualAnnotation, type ManualText } from "@/components/SgDiagram";
import { BoreholeDiagram } from "@/components/BoreholeDiagram";
import { TribalLeaseSketch, type LeaseMeta } from "@/components/TribalLeaseSketch";
import { writeDxf, type ImportedDrawing } from "@/lib/dxf";
import { formatDms, normalizeDeg, parseBearing } from "@/lib/server/angles";

const KINDS: { id: DiagramKind; label: string; blurb: string }[] = [
  { id: "surveyed", label: "Surveyed", blurb: "Parcel surveyed on the ground — beacons measured and computed." },
  { id: "framed", label: "Framed", blurb: "Framed from an approved General Plan." },
  { id: "compiled", label: "Compiled", blurb: "Compiled from existing approved records — submitted to DSM for approval (carries the DSM approval block)." },
  { id: "borehole", label: "Borehole", blurb: "Borehole site tied by bearing & distance to reference marks." },
  { id: "lease", label: "Tribal Lease", blurb: "Land Board tribal-lease sketch — NOT submitted to DSM (witness blocks, no approval). Locality + boundary sketch from base-map data." },
];

// Remembered location -> "Parent / portion" (cadastre) map, so entering a known
// location auto-fills its cadastre. It learns as the surveyor uses it (no external
// dataset needed) and persists across projects in the browser.
const CAD_KEY = "bcs-location-cadastre";
function loadCadMap(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(window.localStorage.getItem(CAD_KEY) || "{}"); } catch { return {}; }
}
function rememberCad(location: string, parent: string) {
  const loc = location.trim().toUpperCase();
  if (!loc || !parent.trim() || typeof window === "undefined") return;
  try {
    const m = loadCadMap();
    m[loc] = parent;
    window.localStorage.setItem(CAD_KEY, JSON.stringify(m));
  } catch { /* ignore */ }
}

/** Best-fit scale for the SG sheet's drawable area (client req 2026-08-21) —
 *  mirrors CogoWorkspace's suggestScale (Part 14). The Diagrams tab's own
 *  default scale was a flat hardcoded 5000 regardless of the boundary's
 *  actual size — for anything much larger than a small suburban lot at
 *  that scale, the figure overflows its box and collides with the table/
 *  signature line above it (confirmed by rendering the exact reported
 *  scenario locally: an 850m-tall boundary at 1:5000 pushes ~350 VB units
 *  past the top of its allotted area). usableW/H_mm mirror SgDiagram.tsx's
 *  fig/pad constants converted to printed mm — keep in sync if those change.
 */
function suggestDiagramScale(pts: { east: number; north: number }[]): number {
  if (pts.length < 2) return 5000;
  const es = pts.map((p) => p.east), ns = pts.map((p) => p.north);
  const spanE = Math.max(...es) - Math.min(...es);
  const spanN = Math.max(...ns) - Math.min(...ns);
  const usableW_mm = 96, usableH_mm = 83;
  const sByWidth = spanE > 0 ? (spanE * 1000) / usableW_mm : 0;
  const sByHeight = spanN > 0 ? (spanN * 1000) / usableH_mm : 0;
  const raw = Math.max(sByWidth, sByHeight, 1);
  const NICE = [100, 200, 250, 500, 750, 1000, 1250, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000, 15000, 20000, 25000, 50000];
  return NICE.find((n) => n >= raw) ?? Math.ceil(raw / 1000) * 1000;
}

/** Default "Beacon Description" text — lists the actual boundary point
 *  names (client req 2026-08-22: "ALL" isn't what the reference shows,
 *  it lists the real letters, e.g. "A,B,C,D : 12mm iron peg"), falling
 *  back to "ALL" only when no points are loaded yet to describe. Capped at
 *  15 names (client req 2026-08-26) — a beacon-heavy plot's full name list
 *  otherwise wraps across several lines and reads as clutter; the field
 *  stays freely editable afterward if the surveyor wants the exact full list. */
const BEACON_DESCRIPTION_NAME_LIMIT = 15;
function defaultBeaconDescription(pts: { name: string | null }[]): string {
  const names = pts.map((p) => p.name).filter(Boolean);
  if (!names.length) return "ALL : 12mm Iron peg";
  const shown = names.length > BEACON_DESCRIPTION_NAME_LIMIT ? [...names.slice(0, BEACON_DESCRIPTION_NAME_LIMIT), "…"] : names;
  return `${shown.join(",")} : 12mm Iron peg`;
}

export function Diagrams() {
  const { cogoResult, diagramFigure, setDiagramFigure, config, setActiveTab, diagramInput, setDiagramInput, parcelDoc, cogoPlots } = useStore();
  const svgRef = useRef<SVGSVGElement>(null);

  // The surveyor picks which lot (parcel) to draw the diagram for, right here.
  const pdoc = parcelDoc as ParcelDoc | null;
  const parcels = useMemo(() => pdoc?.parcels ?? [], [pdoc]);
  const [selParcelId, setSelParcelId] = useState<string | null>(null);
  // Load a lot by the number typed in COGO (client req 2026-08-21) — an
  // alternative to picking a Parcels-tab lot or clicking a plot on the
  // Cadastral canvas: every polygon that's been given a Lot/Erf number
  // there (Part 16c's completion dialog, the Polygon Attributes dialog, or
  // the Traverse panel's Calculate) is saved to the project by that number.
  const [plotNumberInput, setPlotNumberInput] = useState("");
  const [plotNumberError, setPlotNumberError] = useState<string | null>(null);
  // Once a lot's diagram is loaded there was no way back to the "choose a
  // lot" screen to pick a different one (client req 2026-08-24) — the "Lot /
  // parcel" dropdown further down only lets you switch between existing
  // Parcels-tab lots, and doesn't even render if there aren't any yet, so a
  // lot loaded by typing its number (Part 16c) had literally no way back.
  // This flag forces that screen back regardless of what figure is loaded.
  const [forcePicker, setForcePicker] = useState(false);
  const parcelFigure = useMemo<CogoResult | null>(() => {
    if (!pdoc || !selParcelId) return null;
    const p = pdoc.parcels.find((x) => x.id === selParcelId);
    if (!p) return null;
    const by = beaconMap(pdoc.beacons);
    const m = parcelMetrics(p.beaconIds, by);
    if (!m.closed) return null;
    const pts = ringPoints(p.beaconIds, by);
    return {
      type: "closed",
      adjustment: "none",
      closure: { misclose_east: 0, misclose_north: 0, linear_misclosure: 0, total_distance: m.perimeter, relative_precision: null, relative_precision_text: "exact (constructed parcel)" },
      area_m2: m.area_m2,
      area_ha: m.area_ha,
      sigma0: 0,
      points: pts.map((pp) => ({ name: pp.name ?? null, east: pp.east, north: pp.north })),
      legs: m.sides.map((s, i) => ({ index: i + 1, from: s.from, to: s.to, bearing: s.bearing, bearing_dms: s.bearing_dms, distance: s.distance, d_east_adj: 0, d_north_adj: 0 })),
      residuals: [],
    };
  }, [pdoc, selParcelId]);

  // Prefer the picked lot, then a parcel sent from Parcels, then the COGO traverse.
  const fig = parcelFigure ?? diagramFigure ?? cogoResult;

  // Beacons that exist but are NOT on the selected lot's boundary — shown on the
  // diagram as marks (dot + label) but kept OUT of the traverse (client request).
  const extraPoints = useMemo(() => {
    if (!pdoc || !selParcelId) return [];
    const parcel = pdoc.parcels.find((p) => p.id === selParcelId);
    if (!parcel) return [];
    const ring = new Set(parcel.beaconIds);
    return pdoc.beacons
      .filter((b) => !ring.has(b.id))
      .map((b) => ({ name: b.id, east: b.east, north: b.north }));
  }, [pdoc, selParcelId]);
  // Restore saved diagram form state from the project, else derive defaults from config.
  const di = (diagramInput ?? {}) as {
    kind?: DiagramKind;
    meta?: Omit<DiagramMeta, "closed" | "kind">;
    leaseMeta?: Omit<LeaseMeta, "areaM2" | "coordinateSystem">;
    annotations?: ManualAnnotation[];
    texts?: ManualText[];
  };
  const [kind, setKind] = useState<DiagramKind>(di.kind ?? "surveyed");

  // `closed`/`kind` are applied at render time, not stored in the form state.
  const [meta, setMeta] = useState<Omit<DiagramMeta, "closed" | "kind">>(di.meta ?? {
    lotName: config.name && config.name !== "Untitled Survey" ? config.name.toUpperCase() : "LOT 14182 CHARLESHILL",
    parent: "A PORTION OF CADASTRE 243",
    location: "CHARLESHILL",
    tribalArea: "GHANZI TRIBAL AREA",
    surveyor: config.surveyor ? config.surveyor.toUpperCase() : "G. G. SESINYI",
    surveyedDate: "FEBRUARY 2026",
    coordinateSystem: config.coordinateSystem.replace(" Botswana", ""),
    scale: suggestDiagramScale(fig?.points ?? []),
    dsmNo: "",
    srNo: "",
    gpNo: "",
    degreeSquare: "",
    parentDiagram: "",
    beaconDescription: defaultBeaconDescription(fig?.points ?? []),
    areaHa: fig?.area_ha ?? 0,
    sourceRef: "",
    boreholeNo: "",
    boreholeE: 0,
    boreholeN: 0,
  });

  const points = useMemo(
    () => (fig?.points ?? []).map((p) => ({ name: p.name, east: p.east, north: p.north })),
    [fig]
  );
  const sides = useMemo(
    () =>
      (fig?.legs ?? []).map((l) => ({
        from: l.from,
        to: l.to,
        bearing_dms: l.bearing_dms,
        distance: l.distance,
      })),
    [fig]
  );
  // Manually-drawn adjoining-parcel extension lines (client req 2026-08-22,
  // Part 24) — the client clarified these are added by hand by the
  // surveyor (no survey data to compute them from), superseding the
  // earlier per-side auto-computed approach. Click two points directly on
  // the rendered diagram, type a label, done; click an existing line to
  // select it, then Delete to remove it.
  const [annotations, setAnnotations] = useState<ManualAnnotation[]>(di.annotations ?? []);
  const [drawingAnnotation, setDrawingAnnotation] = useState(false);
  const [pendingPoint, setPendingPoint] = useState<{ x: number; y: number } | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  // In-progress grip drag of a selected extension line (client req
  // 2026-08-23 "select, move, rotate/tilt", extended 2026-08-24, Part 28 to
  // match the client's AutoCAD grip-edit demo exactly): dragging the "move"
  // handle translates the whole line; dragging an end handle STRETCHes just
  // that end (free length + angle, other end fixed); holding Shift while
  // dragging an end handle ROTATEs the whole line around the other, fixed
  // end instead (length held constant, only angle changes) — same
  // Stretch-vs-Rotate distinction as the COGO work station's own line
  // grips. `orig` is the pre-drag geometry so Escape can revert exactly.
  const [draggingAnnotation, setDraggingAnnotation] = useState<{
    id: string;
    handle: "start" | "end" | "move";
    rotate: boolean;
    startSvg: { x: number; y: number };
    orig: { x1: number; y1: number; x2: number; y2: number };
    origWorld: { e1: number; n1: number; e2: number; n2: number };
    lengthText: string;
    angleText: string;
  } | null>(null);
  // Free-text notes placed directly on the diagram (client req 2026-08-24:
  // "I want to Add text there... How do I add Text") — same click-to-place
  // approach as the extension lines above, but one point instead of two,
  // followed by a small prompt for the text content instead of committing
  // immediately.
  const [texts, setTexts] = useState<ManualText[]>(di.texts ?? []);
  const [addingText, setAddingText] = useState(false);
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [textPrompt, setTextPrompt] = useState<{ id: string | null; x: number; y: number; value: string } | null>(null);
  const [draggingText, setDraggingText] = useState<{
    id: string;
    startSvg: { x: number; y: number };
    orig: { x: number; y: number };
    origWorld: { east: number; north: number };
  } | null>(null);
  // Live pixel<->survey-coordinate conversion for the diagram currently on
  // screen (client req 2026-08-25) — a ref, not state: SgDiagram hands this
  // over during its own render, so writing it via setState here would be a
  // React anti-pattern (render-phase side effect triggering a re-render).
  // Annotations/text are drawn and dragged in pixel terms (that's what a
  // mouse/pointer event gives you) but PERSISTED in real east/north, same
  // as the boundary itself, so they stay attached to the plot regardless of
  // how the figure's scale or position later recompute — storing raw pixel
  // positions was the bug: they'd stay exactly where drawn on the page even
  // after the boundary moved/rescaled under them ("when I zoom, those edits
  // are left behind... should be fixed to the drawing").
  const transformRef = useRef<DiagramTransform | null>(null);
  // Diagram-sheet mm/unit ratio (matches SgDiagram.tsx's own MM=10 constant)
  // — the live length/angle readout while dragging works in pixel/mm terms
  // (what's on the printed sheet), not real ground metres, since these are
  // freehand annotations, not measured survey data.
  const ANN_MM = 10;
  function annLengthAngle(x1: number, y1: number, x2: number, y2: number): { lengthMm: number; angleDeg: number } {
    const dx = x2 - x1, dy = y2 - y1;
    const lengthMm = Math.hypot(dx, dy) / ANN_MM;
    const angleDeg = normalizeDeg((Math.atan2(dx, -dy) * 180) / Math.PI);
    return { lengthMm, angleDeg };
  }
  // Set once a handle-drag actually moves the pointer, so the native click
  // event that follows mouseup (browsers fire it whenever mousedown/mouseup
  // share a target, regardless of movement in between) doesn't get treated
  // as a fresh click and toggle the selection back off right after a drag.
  const dragMovedRef = useRef(false);

  function toSvgPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }
  function handleCanvasClick(e: ReactMouseEvent<SVGSVGElement>) {
    if (addingText) {
      const p = toSvgPoint(e);
      setTextPrompt({ id: null, x: p.x, y: p.y, value: "" });
      setAddingText(false);
      return;
    }
    if (!drawingAnnotation) {
      // Clicking empty canvas outside draw mode clears whatever's selected.
      setSelectedAnnotationId(null);
      setSelectedTextId(null);
      return;
    }
    const p = toSvgPoint(e);
    if (!pendingPoint) {
      setPendingPoint(p);
      return;
    }
    // No label — these lines only mark that a side borders a neighbouring
    // plot (client req 2026-08-23), they don't need to name which one.
    // Stored as real survey coordinates, not the raw pixel click (client
    // req 2026-08-25) — see transformRef's comment above.
    const t = transformRef.current;
    const start = t ? t.toWorld(pendingPoint.x, pendingPoint.y) : { east: 0, north: 0 };
    const end = t ? t.toWorld(p.x, p.y) : { east: 0, north: 0 };
    setAnnotations((arr) => [...arr, { id: `ann-${Date.now()}`, e1: start.east, n1: start.north, e2: end.east, n2: end.north }]);
    setPendingPoint(null);
    setDrawingAnnotation(false);
  }
  function handleAnnotationClick(id: string) {
    if (drawingAnnotation) return;
    if (dragMovedRef.current) {
      dragMovedRef.current = false; // swallow the click that trails a drag
      return;
    }
    setSelectedAnnotationId((cur) => (cur === id ? null : id));
  }
  function handleTextClick(id: string) {
    if (dragMovedRef.current) {
      dragMovedRef.current = false; // swallow the click that trails a drag
      return;
    }
    setSelectedTextId((cur) => (cur === id ? null : id));
  }
  function handleTextDoubleClick(id: string) {
    const tt = texts.find((x) => x.id === id);
    if (!tt) return;
    const p = transformRef.current?.toScreen(tt.east, tt.north) ?? { x: 0, y: 0 };
    setTextPrompt({ id, x: p.x, y: p.y, value: tt.text });
  }
  function commitTextPrompt() {
    if (!textPrompt) return;
    const value = textPrompt.value.trim();
    if (value) {
      const w = transformRef.current?.toWorld(textPrompt.x, textPrompt.y) ?? { east: 0, north: 0 };
      if (textPrompt.id) {
        setTexts((arr) => arr.map((tt) => (tt.id === textPrompt.id ? { ...tt, text: value } : tt)));
      } else {
        setTexts((arr) => [...arr, { id: `txt-${Date.now()}`, east: w.east, north: w.north, text: value }]);
      }
    }
    setTextPrompt(null);
  }
  function deleteSelectedText() {
    if (!selectedTextId) return;
    setTexts((arr) => arr.filter((tt) => tt.id !== selectedTextId));
    setSelectedTextId(null);
  }
  function handleTextHandleDown(id: string, e: ReactPointerEvent<SVGElement>) {
    const tt = texts.find((x) => x.id === id);
    const t = transformRef.current;
    if (!tt || !t) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragMovedRef.current = false;
    const p = t.toScreen(tt.east, tt.north);
    setDraggingText({ id, startSvg: toSvgPoint(e), orig: p, origWorld: { east: tt.east, north: tt.north } });
  }
  function deleteSelectedAnnotation() {
    if (!selectedAnnotationId) return;
    setAnnotations((arr) => arr.filter((a) => a.id !== selectedAnnotationId));
    setSelectedAnnotationId(null);
  }
  function handleAnnotationHandleDown(id: string, handle: "start" | "end" | "move", e: ReactPointerEvent<SVGElement>) {
    const a = annotations.find((x) => x.id === id);
    const t = transformRef.current;
    if (!a || !t) return;
    // Pointer capture (client req 2026-08-24, Part 28) — without it a fast
    // drag that slips the cursor off the small grip hit-target, or off the
    // diagram entirely, stops delivering move events partway through.
    e.currentTarget.setPointerCapture(e.pointerId);
    dragMovedRef.current = false;
    const p1 = t.toScreen(a.e1, a.n1);
    const p2 = t.toScreen(a.e2, a.n2);
    const { lengthMm, angleDeg } = annLengthAngle(p1.x, p1.y, p2.x, p2.y);
    setDraggingAnnotation({
      id,
      handle,
      rotate: handle !== "move" && e.shiftKey,
      startSvg: toSvgPoint(e),
      orig: { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y },
      origWorld: { e1: a.e1, n1: a.n1, e2: a.e2, n2: a.n2 },
      lengthText: lengthMm.toFixed(1),
      angleText: formatDms(angleDeg),
    });
  }
  function handleCanvasMouseMove(e: ReactPointerEvent<SVGSVGElement>) {
    const t = transformRef.current;
    if (draggingText && t) {
      const p = toSvgPoint(e);
      const dx = p.x - draggingText.startSvg.x, dy = p.y - draggingText.startSvg.y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) dragMovedRef.current = true;
      const { orig, id } = draggingText;
      const w = t.toWorld(orig.x + dx, orig.y + dy);
      setTexts((arr) => arr.map((tt) => (tt.id === id ? { ...tt, east: w.east, north: w.north } : tt)));
      return;
    }
    if (!draggingAnnotation || !t) return;
    const p = toSvgPoint(e);
    const dx = p.x - draggingAnnotation.startSvg.x;
    const dy = p.y - draggingAnnotation.startSvg.y;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) dragMovedRef.current = true;
    const { orig, handle, id, rotate } = draggingAnnotation;
    if (handle === "move") {
      const w1 = t.toWorld(orig.x1 + dx, orig.y1 + dy);
      const w2 = t.toWorld(orig.x2 + dx, orig.y2 + dy);
      setAnnotations((arr) => arr.map((a) => (a.id === id ? { ...a, e1: w1.east, n1: w1.north, e2: w2.east, n2: w2.north } : a)));
      return;
    }
    const isStart = handle === "start";
    const pivot = isStart ? { x: orig.x2, y: orig.y2 } : { x: orig.x1, y: orig.y1 };
    let nx: number, ny: number, lengthMm: number, angleDeg: number;
    if (rotate) {
      // ROTATE: length fixed at its pre-drag value, only the angle around
      // the OTHER (fixed) end follows the mouse — same Stretch-vs-Rotate
      // split as the COGO work station's line grips (client req 2026-08-24).
      const origPt = isStart ? { x: orig.x1, y: orig.y1 } : { x: orig.x2, y: orig.y2 };
      const { lengthMm: fixedLen } = annLengthAngle(pivot.x, pivot.y, origPt.x, origPt.y);
      const angRad = Math.atan2(p.x - pivot.x, -(p.y - pivot.y));
      nx = pivot.x + fixedLen * ANN_MM * Math.sin(angRad);
      ny = pivot.y - fixedLen * ANN_MM * Math.cos(angRad);
      lengthMm = fixedLen;
      angleDeg = normalizeDeg((angRad * 180) / Math.PI);
    } else {
      // STRETCH: the dragged end moves freely to the cursor.
      nx = orig[isStart ? "x1" : "x2"] + dx;
      ny = orig[isStart ? "y1" : "y2"] + dy;
      ({ lengthMm, angleDeg } = annLengthAngle(pivot.x, pivot.y, nx, ny));
    }
    const w = t.toWorld(nx, ny);
    setAnnotations((arr) => arr.map((a) => (a.id === id ? (isStart ? { ...a, e1: w.east, n1: w.north } : { ...a, e2: w.east, n2: w.north }) : a)));
    setDraggingAnnotation((g) => (g ? { ...g, lengthText: lengthMm.toFixed(1), angleText: formatDms(angleDeg) } : g));
  }
  function handleCanvasMouseUp() {
    // Already committed live on every mousemove above — release just ends
    // the drag session (client req 2026-08-24: "confirm on release").
    if (draggingText) { setDraggingText(null); return; }
    setDraggingAnnotation(null);
  }
  /** Commits the typed Length(mm)/Angle readout, matching AutoCAD's dynamic
   *  input Enter behavior — ends the drag at exactly the typed values
   *  rather than wherever the mouse happens to be (client req 2026-08-24). */
  function applyAnnotationReadout() {
    const t = transformRef.current;
    if (!draggingAnnotation || draggingAnnotation.handle === "move" || !t) return;
    const lengthMm = Number(draggingAnnotation.lengthText);
    if (!Number.isFinite(lengthMm) || lengthMm <= 0) return;
    let angleDeg: number;
    try {
      angleDeg = parseBearing(draggingAnnotation.angleText);
    } catch {
      return;
    }
    const { orig, handle, id } = draggingAnnotation;
    const isStart = handle === "start";
    const pivot = isStart ? { x: orig.x2, y: orig.y2 } : { x: orig.x1, y: orig.y1 };
    const rad = (angleDeg * Math.PI) / 180;
    const nx = pivot.x + lengthMm * ANN_MM * Math.sin(rad);
    const ny = pivot.y - lengthMm * ANN_MM * Math.cos(rad);
    const w = t.toWorld(nx, ny);
    setAnnotations((arr) => arr.map((a) => (a.id === id ? (isStart ? { ...a, e1: w.east, n1: w.north } : { ...a, e2: w.east, n2: w.north }) : a)));
    setDraggingAnnotation(null);
  }
  function cancelAnnotationDrag() {
    if (!draggingAnnotation) return;
    const { origWorld, id } = draggingAnnotation;
    setAnnotations((arr) => arr.map((a) => (a.id === id ? { ...a, ...origWorld } : a)));
    setDraggingAnnotation(null);
  }
  function cancelTextDrag() {
    if (!draggingText) return;
    const { origWorld, id } = draggingText;
    setTexts((arr) => arr.map((tt) => (tt.id === id ? { ...tt, ...origWorld } : tt)));
    setDraggingText(null);
  }
  // Escape reverts an in-progress grip drag to its pre-drag geometry, closes
  // an open text prompt, or cancels the Add Text tool (client req
  // 2026-08-24: "Escape cancels and reverts to the pre-drag state").
  useEffect(() => {
    if (!draggingAnnotation && !draggingText && !textPrompt && !addingText) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (draggingAnnotation) cancelAnnotationDrag();
      else if (draggingText) cancelTextDrag();
      else if (textPrompt) setTextPrompt(null);
      else if (addingText) setAddingText(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingAnnotation, draggingText, textPrompt, addingText]);

  const fullMeta: DiagramMeta = {
    ...meta,
    kind,
    areaHa: fig?.area_ha ?? meta.areaHa,
    closed: fig?.type === "closed",
  };

  // Tribal-lease sketch carries its own (Land Board) field set.
  const [leaseMeta, setLeaseMeta] = useState<Omit<LeaseMeta, "areaM2" | "coordinateSystem">>(di.leaseMeta ?? {
    fileNo: "B",
    date: "16/09/2025",
    compiledBy: "O. Ithuteng",
    applicantName: "Aobakwe Thuo Chijoro",
    useType: "Residential",
    tribalLot: "4266",
    village: "Mmopane, Block 1",
    postal: "P O Box 80934 Gaborone",
    localityScale: 1530,
    boundaryScale: 1250,
  });
  const setLease = (k: keyof typeof leaseMeta) => (v: string) =>
    setLeaseMeta((m) => ({ ...m, [k]: k === "localityScale" || k === "boundaryScale" ? Number(v) || 0 : v }));

  // When a lot is picked, pre-fill the diagram's lot name and a best-fit
  // scale for its actual size from the parcel number/extent (client req
  // 2026-08-21) — a flat default scale can badly overflow a larger lot's
  // figure into the table/signature area above it.
  useEffect(() => {
    const p = parcels.find((x) => x.id === selParcelId);
    const suggested = suggestDiagramScale(fig?.points ?? []);
    setMeta((m) => ({
      ...m,
      ...(p?.number ? { lotName: p.number.toUpperCase() } : {}),
      scale: suggested,
      beaconDescription: defaultBeaconDescription(fig?.points ?? []),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selParcelId]);

  // Persist diagram form state into the project bundle.
  useEffect(() => {
    setDiagramInput({ kind, meta, leaseMeta, annotations, texts });
  }, [kind, meta, leaseMeta, annotations, texts, setDiagramInput]);
  const fullLeaseMeta: LeaseMeta = {
    ...leaseMeta,
    coordinateSystem: meta.coordinateSystem,
    areaM2: fig?.area_m2 ?? 0,
  };

  function serializeSvg(): string | null {
    if (!svgRef.current) return null;
    const clone = svgRef.current.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return new XMLSerializer().serializeToString(clone);
  }

  /** Print-specific serialization (client req 2026-08-21, Parts 17/18/21) —
   *  the real root cause of "3 sheets of paper": SgDiagram's root <svg> has
   *  an inline style (width:100%;height:auto — correct for the responsive
   *  on-screen preview) that, once serialized, has HIGHER CSS specificity
   *  than the print document's `svg{width:160mm;height:270mm}` rule, so the
   *  print rule was silently never taking effect — the SVG was rendering at
   *  the print window's full content width with an auto (often >297mm)
   *  height instead. Strips just the inline width/height here so the print
   *  CSS can actually apply; downloadSvg()'s plain serializeSvg() is
   *  untouched since a downloaded standalone file should stay responsive. */
  function serializeSvgForPrint(): string | null {
    if (!svgRef.current) return null;
    const clone = svgRef.current.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.style.removeProperty("width");
    clone.style.removeProperty("height");
    return new XMLSerializer().serializeToString(clone);
  }

  function downloadSvg() {
    const svg = serializeSvg();
    if (!svg) return;
    const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svg}`], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${kind}-diagram-${(meta.lotName || "diagram").replace(/\s+/g, "_")}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Export the surveyed geometry (not the print layout) as DXF, reusing the
   *  app's existing DXF writer (client req 2026-08-22) — each boundary point
   *  as a labelled POINT, the boundary itself as a closed LWPOLYLINE, and
   *  any off-boundary reference beacons as their own layer. */
  function downloadDxf() {
    const drawing: ImportedDrawing = {
      points: [
        ...points.map((p) => ({ x: p.east, y: p.north, label: p.name ?? undefined, layer: "BEACONS" })),
        ...extraPoints.map((p) => ({ x: p.east, y: p.north, label: p.name ?? undefined, layer: "REFERENCE" })),
      ],
      polylines:
        points.length >= 2
          ? [{ pts: points.map((p) => ({ x: p.east, y: p.north })), closed: fig?.type === "closed", layer: "BOUNDARY" }]
          : [],
      texts: [],
    };
    const dxf = writeDxf(drawing);
    const blob = new Blob([dxf], { type: "application/dxf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${kind}-diagram-${(meta.lotName || "diagram").replace(/\s+/g, "_")}.dxf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function printDiagram() {
    const svg = serializeSvgForPrint();
    if (!svg) return;
    const w = window.open("", "_blank", "width=1200,height=850");
    if (!w) {
      alert("Pop-up blocked. Please allow pop-ups for this site in your browser, then click Print again.");
      return;
    }
    // Root-caused (client req 2026-08-22, Part 23): the sheet's own margins
    // (24.8mm sides, 12.2/11.9mm top/bottom) are now baked directly into
    // SgDiagram's geometry — its viewBox IS a full A4 page (2100x2970 = a
    // 210:297 ratio) with the frame positioned inside it, not a 160x270mm
    // sheet relying on separate CSS margins to land correctly on A4. So the
    // print rule just needs the SVG at exactly A4 size with zero margin —
    // no more mm-rounding tightrope between a sub-page-sized sheet and
    // hand-tuned CSS margins.
    w.document.write(
      `<html><head><title>${kind} diagram — ${meta.lotName}</title>` +
        `<style>` +
        `@page{size:A4 portrait;margin:0}` +
        `body{margin:0}` +
        `svg{width:210mm;height:297mm;display:block}` +
        `.print-note{position:fixed;top:0;left:0;right:0;background:#fef3c7;color:#78350f;font:14px/1.4 system-ui,sans-serif;padding:10px 16px;z-index:10}` +
        `.print-note button{margin-left:12px;padding:4px 12px;font-weight:600;background:#0f766e;color:#fff;border:none;border-radius:4px;cursor:pointer}` +
        `@media print{.print-note{display:none}}` +
        `</style></head>` +
        `<body>` +
        `<div class="print-note">Tip: if a print/PDF still shows more than one page, set <strong>Margins</strong> to <strong>None</strong> in the print dialog.` +
        `<button onclick="window.print()">Print</button></div>` +
        svg +
        `</body></html>`
    );
    w.document.close();
  }

  const set = (k: keyof typeof meta) => (v: string) =>
    setMeta((m) => ({ ...m, [k]: k === "scale" || k === "boreholeE" || k === "boreholeN" ? Number(v) || 0 : v }));

  // Entering a known location auto-picks its cadastre (Parent / portion); typing a
  // parent for a location remembers it for next time.
  const onLocation = (v: string) =>
    setMeta((m) => {
      const remembered = loadCadMap()[v.trim().toUpperCase()];
      return { ...m, location: v, parent: remembered ?? m.parent };
    });
  const onParent = (v: string) =>
    setMeta((m) => {
      rememberCad(m.location, v);
      return { ...m, parent: v };
    });

  function loadPlotByNumber() {
    const n = plotNumberInput.trim();
    if (!n) return;
    const plot = cogoPlots.find((p) => p.number.toLowerCase() === n.toLowerCase());
    if (!plot) {
      setPlotNumberError(`No plot numbered "${n}" found. Number it first in ${cogoTabLabel(config.discipline)} — the Lot Number prompt after finishing a polygon, or Tables → Polygons → Position.`);
      return;
    }
    setPlotNumberError(null);
    setSelParcelId(null); // a typed-in plot always wins over a Parcels-tab pick
    setDiagramFigure(plot.fig);
    setForcePicker(false);
    const suggested = suggestDiagramScale(plot.fig.points);
    setMeta((m) => ({ ...m, lotName: plot.number.toUpperCase(), scale: suggested }));
  }

  if (forcePicker || !fig || points.length < 3) {
    return (
      <Card>
        <div className="py-12 text-center text-slate-500">
          <p className="text-lg font-medium text-slate-700">Choose a lot to draw its diagram</p>

          <p className="mt-1 text-sm">Type the Lot Number you used in {cogoTabLabel(config.discipline)}:</p>
          <div className="mx-auto mt-3 flex max-w-xs items-center gap-2">
            <Input
              value={plotNumberInput}
              onChange={(v) => { setPlotNumberInput(v); setPlotNumberError(null); }}
              placeholder="e.g. 102"
              onKeyDown={(e) => { if (e.key === "Enter") loadPlotByNumber(); }}
            />
            <Button onClick={loadPlotByNumber} disabled={!plotNumberInput.trim()}>Load</Button>
          </div>
          {plotNumberError && <p className="mx-auto mt-2 max-w-xs text-xs text-red-600">{plotNumberError}</p>}

          <p className="my-4 text-xs uppercase tracking-wide text-slate-300">or</p>

          {parcels.length > 0 ? (
            <>
              <p className="mt-1 text-sm">Pick the lot (parcel) you want a diagram for:</p>
              <div className="mx-auto mt-4 max-w-xs text-left">
                <Select
                  value={selParcelId ?? ""}
                  onChange={(v) => { setSelParcelId(v || null); if (v) setForcePicker(false); }}
                  options={[{ value: "", label: "— select a lot —" }, ...parcels.map((p) => ({ value: p.id, label: p.number || "(unnamed)" }))]}
                />
              </div>
              <p className="mt-3 text-xs text-slate-400">…or run a closed traverse in the {cogoTabLabel(config.discipline)}.</p>
            </>
          ) : (
            <p className="mt-1 text-sm">
              Build a parcel in the <strong>Parcels</strong> tab, or run a <strong>closed traverse</strong> in the {cogoTabLabel(config.discipline)} —
              the diagram is drawn from its beacon coordinates and sides.
            </p>
          )}
          <div className="mt-4 flex justify-center gap-2">
            {/* Only relevant when a diagram is ALREADY loaded and the user
                opened this screen just to switch lots (client req
                2026-08-24) — lets them back out without losing it. */}
            {forcePicker && fig && points.length >= 3 && (
              <Button variant="ghost" onClick={() => setForcePicker(false)}>← Back to current diagram</Button>
            )}
            <Button variant="ghost" onClick={() => setActiveTab("parcels")}>Go to Parcels</Button>
            <Button variant="ghost" onClick={() => setActiveTab("cogo")}>Go to {cogoTabLabel(config.discipline)}</Button>
          </div>
        </div>
      </Card>
    );
  }

  const isBorehole = kind === "borehole";
  const isLease = kind === "lease";

  return (
    <div className="space-y-5">
      {/* Lot / parcel picker — which figure this diagram draws. Always
          rendered (not just when Parcels-tab lots exist) with a "Change
          Lot" escape hatch back to the picker screen — previously the only
          way back was this dropdown, which didn't even appear for a lot
          loaded by typing its number, leaving no way back at all (client
          req 2026-08-24). */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm">
        {parcels.length > 0 && (
          <>
            <span className="text-sm font-medium text-slate-600">Lot / parcel:</span>
            <div className="min-w-[200px]">
              <Select
                value={selParcelId ?? ""}
                onChange={(v) => setSelParcelId(v || null)}
                options={[{ value: "", label: cogoResult ? `${cogoTabLabel(config.discipline)} traverse figure` : "— pick a lot —" }, ...parcels.map((p) => ({ value: p.id, label: p.number || "(unnamed)" }))]}
              />
            </div>
            {selParcelId && <span className="text-xs text-slate-400">drawing this lot · {fig.area_ha.toFixed(4)} ha</span>}
          </>
        )}
        <div className="ml-auto">
          <Button variant="ghost" onClick={() => setForcePicker(true)}>← Change Lot</Button>
        </div>
      </div>

      {/* Diagram type selector */}
      <div className="flex flex-wrap gap-2">
        {KINDS.map((k) => (
          <button
            key={k.id}
            onClick={() => setKind(k.id)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              kind === k.id
                ? "bg-brand text-white shadow-sm"
                : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>
      <p className="-mt-2 text-sm text-slate-500">{KINDS.find((k) => k.id === kind)?.blurb}</p>

      <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
        <div className="space-y-4">
          {isLease ? (
            <Card title="Tribal Lease Details">
              <div className="space-y-3">
                <Field label="File No"><Input value={leaseMeta.fileNo} onChange={setLease("fileNo")} /></Field>
                <Field label="Date"><Input value={leaseMeta.date} onChange={setLease("date")} /></Field>
                <Field label="Compiled by (Mapping)"><Input value={leaseMeta.compiledBy} onChange={setLease("compiledBy")} /></Field>
                <Field label="Applicant name"><Input value={leaseMeta.applicantName} onChange={setLease("applicantName")} /></Field>
                <Field label="Use / purpose"><Input value={leaseMeta.useType} onChange={setLease("useType")} /></Field>
                <Field label="Tribal Lot No."><Input value={leaseMeta.tribalLot} onChange={setLease("tribalLot")} /></Field>
                <Field label="Village / block"><Input value={leaseMeta.village} onChange={setLease("village")} /></Field>
                <Field label="Postal address"><Input value={leaseMeta.postal} onChange={setLease("postal")} /></Field>
                <Field label="Locality scale 1:N"><Input type="number" value={leaseMeta.localityScale} onChange={setLease("localityScale")} /></Field>
                <Field label="Boundary scale 1:N"><Input type="number" value={leaseMeta.boundaryScale} onChange={setLease("boundaryScale")} /></Field>
              </div>
            </Card>
          ) : (
            <>
              <Card title="Diagram Details">
                <div className="space-y-3">
                  <Field label={isBorehole ? "Borehole name / site" : "Land called (lot name)"}>
                    <Input value={meta.lotName} onChange={set("lotName")} />
                  </Field>
                  {isBorehole ? (
                    <>
                      <Field label="Borehole No.">
                        <Input value={meta.boreholeNo ?? ""} onChange={set("boreholeNo")} />
                      </Field>
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="Borehole Easting"><Input type="number" value={meta.boreholeE ?? 0} onChange={set("boreholeE")} /></Field>
                        <Field label="Borehole Northing"><Input type="number" value={meta.boreholeN ?? 0} onChange={set("boreholeN")} /></Field>
                      </div>
                    </>
                  ) : (
                    <>
                      <Field label="Parent / portion">
                        <Input value={meta.parent} onChange={onParent} placeholder="e.g. A PORTION OF CADASTRE 243" />
                      </Field>
                      <Field label="Parent / portion — extra line (optional)">
                        <Input value={meta.parent2 ?? ""} onChange={set("parent2")} placeholder="for plots with a longer history" />
                      </Field>
                      <Field label="Parent / portion — extra line 2 (optional)">
                        <Input value={meta.parent3 ?? ""} onChange={set("parent3")} placeholder="e.g. A PORTION OF CADASTRE 87" />
                      </Field>
                    </>
                  )}
                  {(kind === "compiled" || kind === "framed") && (
                    <Field label={kind === "framed" ? "Framed from (General Plan No.)" : "Compiled from (source document)"}>
                      <Input value={meta.sourceRef ?? ""} onChange={set("sourceRef")} />
                    </Field>
                  )}
                  <Field label="Situate at (location)"><Input value={meta.location} onChange={onLocation} placeholder="e.g. CHARLESHILL" /></Field>
                  <Field label="Tribal / administrative area"><Input value={meta.tribalArea} onChange={set("tribalArea")} /></Field>
                  <Field label="Land surveyor"><Input value={meta.surveyor} onChange={set("surveyor")} /></Field>
                  <Field label="Date"><Input value={meta.surveyedDate} onChange={set("surveyedDate")} /></Field>
                  <Field label="Scale 1:N"><Input type="number" value={meta.scale} onChange={set("scale")} /></Field>
                  {!isBorehole && (
                    <Field label="Beacon description"><Input value={meta.beaconDescription} onChange={set("beaconDescription")} /></Field>
                  )}
                </div>
              </Card>
              {!isBorehole && (
                <Card title="Adjoining Parcels">
                  <p className="mb-2 text-xs text-slate-400">
                    These dashed extension lines are added by hand, the same way a surveyor marks them up on
                    paper — there's no survey data to compute them from. They just mark that a side borders a
                    neighbouring plot, with no label. Click "Draw Extension Line" below, then click two points
                    directly on the preview to draw one. Click an existing line to select it — drag the line
                    itself to move it, drag an end-handle to stretch that end (hold Shift to rotate the whole
                    line around the other end instead), type an exact length/angle while dragging, or press
                    Delete to remove it. Esc cancels a drag in progress.
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant={drawingAnnotation ? "primary" : "ghost"}
                      onClick={() => { setDrawingAnnotation((v) => !v); setPendingPoint(null); }}
                    >
                      {drawingAnnotation ? (pendingPoint ? "Click the end point…" : "Click the start point…") : "Draw Extension Line"}
                    </Button>
                    {selectedAnnotationId && (
                      <Button variant="ghost" onClick={deleteSelectedAnnotation}>Delete Selected Line</Button>
                    )}
                  </div>
                </Card>
              )}
              {!isBorehole && (
                <Card title="Custom Text">
                  <p className="mb-2 text-xs text-slate-400">
                    For a note the fixed template wording doesn't cover — e.g. a remark next to a specific
                    corner (client req 2026-08-24). Click "Add Text" below, then click where it should sit on
                    the preview and type it. Click an existing note to select it, then drag to move it,
                    double-click to edit its wording, or Delete to remove it.
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant={addingText ? "primary" : "ghost"}
                      onClick={() => setAddingText((v) => !v)}
                    >
                      {addingText ? "Click where it should go…" : "Add Text"}
                    </Button>
                    {selectedTextId && (
                      <Button variant="ghost" onClick={deleteSelectedText}>Delete Selected Text</Button>
                    )}
                  </div>
                </Card>
              )}
              <Card title="Registration">
                <div className="space-y-3">
                  <Field label="D.S.M No."><Input value={meta.dsmNo} onChange={set("dsmNo")} /></Field>
                  <Field label="S.R No."><Input value={meta.srNo} onChange={set("srNo")} /></Field>
                  {!isBorehole && (
                    <Field label="General Plan No."><Input value={meta.gpNo} onChange={set("gpNo")} /></Field>
                  )}
                  <Field label="Degree Square"><Input value={meta.degreeSquare} onChange={set("degreeSquare")} /></Field>
                  <Field label="D.S.M File"><Input value={meta.dsmFile ?? ""} onChange={set("dsmFile")} placeholder="e.g. CAD T9" /></Field>
                  <Field label="Comp."><Input value={meta.comp ?? ""} onChange={set("comp")} /></Field>
                  <Field label="LIR No."><Input value={meta.lirNo ?? ""} onChange={set("lirNo")} /></Field>
                  <Field label="Immediate parent diagram No. (subdivisions)"><Input value={meta.parentDiagramNo ?? meta.parentDiagram ?? ""} onChange={set("parentDiagramNo")} placeholder="e.g. SR 1087/2014" /></Field>
                  <Field label="Name above ‘Registrar of Deeds’ (optional)"><Input value={meta.annexName ?? ""} onChange={set("annexName")} placeholder="optional" /></Field>
                </div>
              </Card>
            </>
          )}
          <Card title="Output">
            <div className="flex flex-col gap-2">
              <Button onClick={downloadSvg}>⬇ Download SVG</Button>
              <Button variant="ghost" onClick={printDiagram}>Print / Save PDF</Button>
              <Button variant="ghost" onClick={downloadDxf}>⬇ Download DXF</Button>
            </div>
            {/* Client req 2026-08-26: "i also want to save Dxf under tribal
                lease" — the DXF button used to be hidden for the lease kind,
                but downloadDxf() only ever needed points/sides, which the
                lease sketch already has same as every other kind. */}
            <p className="mt-2 text-xs text-slate-400">
              DXF exports the surveyed geometry (beacons + boundary), not the printed sheet layout — opens
              directly in AutoCAD and most CAD/GIS software. DGN (MicroStation) isn't available: it's a
              proprietary binary format with no reliable open writer, so a from-scratch export would risk
              producing a file that doesn't actually open correctly. If you need DGN, the common path is
              importing this DXF into MicroStation (or a converter) and saving as DGN there.
            </p>
          </Card>
        </div>

        <Card title={`${KINDS.find((k) => k.id === kind)?.label} Preview`} className="overflow-auto">
          <div className="rounded-lg border border-slate-200">
            {isLease ? (
              <TribalLeaseSketch ref={svgRef} meta={fullLeaseMeta} points={points} sides={sides} />
            ) : isBorehole ? (
              <BoreholeDiagram ref={svgRef} meta={fullMeta} points={points} />
            ) : (
              <SgDiagram
                ref={svgRef}
                meta={fullMeta}
                points={points}
                sides={sides}
                extraPoints={extraPoints}
                manualAnnotations={annotations}
                pendingAnnotationPoint={pendingPoint}
                selectedAnnotationId={selectedAnnotationId}
                drawMode={drawingAnnotation || addingText}
                onCanvasClick={handleCanvasClick}
                onAnnotationClick={handleAnnotationClick}
                onAnnotationHandleDown={handleAnnotationHandleDown}
                onCanvasMouseMove={handleCanvasMouseMove}
                onCanvasMouseUp={handleCanvasMouseUp}
                manualTexts={texts}
                selectedTextId={selectedTextId}
                onTextClick={handleTextClick}
                onTextDoubleClick={handleTextDoubleClick}
                onTextHandleDown={handleTextHandleDown}
                onTransform={(t) => { transformRef.current = t; }}
              />
            )}
          </div>
          {/* Live dynamic-input readout while stretching/rotating an
              extension-line grip (client req 2026-08-24, Part 28 —
              "matching the AutoCAD demo's dynamic input fields, so the user
              can type an exact value instead of dragging by eye"). Length
              is in the printed sheet's millimetres, not ground metres —
              these lines are freehand annotations, not measured survey
              data. Positioned via the SVG's own screen CTM so it tracks the
              grip correctly regardless of the preview's zoom/scroll. */}
          {draggingAnnotation && draggingAnnotation.handle !== "move" && (() => {
            const a = annotations.find((x) => x.id === draggingAnnotation.id);
            const svg = svgRef.current;
            const tr = transformRef.current;
            if (!a || !svg || !tr) return null;
            const ctm = svg.getScreenCTM();
            if (!ctm) return null;
            const svgPos = draggingAnnotation.handle === "start" ? tr.toScreen(a.e1, a.n1) : tr.toScreen(a.e2, a.n2);
            const pt = svg.createSVGPoint();
            pt.x = svgPos.x;
            pt.y = svgPos.y;
            const p = pt.matrixTransform(ctm);
            const isRotate = draggingAnnotation.rotate;
            return (
              <div
                className="fixed z-20 w-40 rounded border border-brand bg-white p-2 text-xs shadow-md"
                style={{ left: p.x + 12, top: p.y + 12 }}
              >
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="font-semibold text-brand-dark">{isRotate ? "Rotate" : "Stretch"}</span>
                  <button type="button" onClick={cancelAnnotationDrag} className="text-slate-400 hover:text-slate-700" aria-label="Cancel">✕</button>
                </div>
                <label className="mb-1 block">
                  <span className="mb-0.5 block text-slate-500">Length (mm)</span>
                  <input
                    type="number"
                    value={draggingAnnotation.lengthText}
                    readOnly={isRotate}
                    onChange={(e) => setDraggingAnnotation((g) => (g ? { ...g, lengthText: e.target.value } : g))}
                    onKeyDown={(e) => { if (e.key === "Enter") applyAnnotationReadout(); if (e.key === "Escape") cancelAnnotationDrag(); }}
                    className={`w-full rounded border border-slate-200 px-1.5 py-1 ${isRotate ? "bg-slate-50 text-slate-500" : ""}`}
                  />
                </label>
                <label className="mb-1.5 block">
                  <span className="mb-0.5 block text-slate-500">Angle (bearing)</span>
                  <input
                    value={draggingAnnotation.angleText}
                    onChange={(e) => setDraggingAnnotation((g) => (g ? { ...g, angleText: e.target.value } : g))}
                    onKeyDown={(e) => { if (e.key === "Enter") applyAnnotationReadout(); if (e.key === "Escape") cancelAnnotationDrag(); }}
                    className="w-full rounded border border-slate-200 px-1.5 py-1"
                  />
                </label>
                <button type="button" onClick={applyAnnotationReadout} className="w-full rounded bg-brand px-1.5 py-1 font-semibold text-white">Apply</button>
              </div>
            );
          })()}
          {/* Custom-text prompt (client req 2026-08-24) — appears right where
              the surveyor clicked (new note) or where an existing one sits
              (double-click to edit), matching the same screen-CTM
              positioning as the stretch/rotate readout above. */}
          {textPrompt && (() => {
            const svg = svgRef.current;
            if (!svg) return null;
            const ctm = svg.getScreenCTM();
            if (!ctm) return null;
            const pt = svg.createSVGPoint();
            pt.x = textPrompt.x;
            pt.y = textPrompt.y;
            const p = pt.matrixTransform(ctm);
            return (
              <div
                className="fixed z-20 w-52 rounded border border-brand bg-white p-2 text-xs shadow-md"
                style={{ left: p.x + 12, top: p.y + 12 }}
              >
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="font-semibold text-brand-dark">{textPrompt.id ? "Edit Text" : "Add Text"}</span>
                  <button type="button" onClick={() => setTextPrompt(null)} className="text-slate-400 hover:text-slate-700" aria-label="Cancel">✕</button>
                </div>
                <input
                  autoFocus
                  value={textPrompt.value}
                  onChange={(e) => setTextPrompt((g) => (g ? { ...g, value: e.target.value } : g))}
                  onKeyDown={(e) => { if (e.key === "Enter") commitTextPrompt(); if (e.key === "Escape") setTextPrompt(null); }}
                  placeholder="Note text…"
                  className="mb-1.5 w-full rounded border border-slate-200 px-1.5 py-1"
                />
                <button type="button" onClick={commitTextPrompt} className="w-full rounded bg-brand px-1.5 py-1 font-semibold text-white">
                  {textPrompt.id ? "Save" : "Add"}
                </button>
              </div>
            );
          })()}
          <p className="mt-3 text-xs text-slate-400">
            {isLease ? (
              <>Boundary sketch &amp; coordinate schedule are drawn from the COGO figure. The locality sketch
              (surrounding lots) is populated once a base map is imported (DXF / Shapefile).</>
            ) : (
              <>Drawn from the computed figure ({points.length} beacons, area {fig.area_ha.toFixed(4)} ha).
              Template wording follows standard SG convention — verify against the official Botswana
              {" "}{KINDS.find((k) => k.id === kind)?.label.toLowerCase()} sample before lodging.</>
            )}
          </p>
        </Card>
      </div>
    </div>
  );
}
