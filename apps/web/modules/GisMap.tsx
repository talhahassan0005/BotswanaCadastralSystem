"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { apiJson } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Button, Card } from "@/components/ui";
import { transformPoint, CRS_LIST, isGeographic } from "@/lib/server/crs";
import { parseSurveyCsv } from "@/lib/server/csv";
import { inverse } from "@/lib/server/geometry";
import { formatDms } from "@/lib/server/angles";
import { createZip } from "@/lib/zip";
import { writeDxf, type ImportedDrawing } from "@/lib/dxf";
import type { ParcelDoc, StockpileResult } from "@/lib/types";
import type { WPoint } from "@/lib/cogoTools/types";
import { REF_MARKS, type RefMark } from "@/lib/refmarks";

// Leaflet is loaded from a CDN at runtime (no npm dependency) — keeps the
// build self-contained. `window.L` is the global Leaflet namespace.
declare global {
  interface Window {
    L?: any;
  }
}

const ESRI_IMAGERY =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const OSM = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
/** Esri's transparent reference layer: country boundary lines and place
 *  names — towns and villages — meant to be drawn over imagery. Client req
 *  2026-11-16: "i want the map to show the country's boundary lines and
 *  village names", with a Google Earth screenshot for reference. The
 *  imagery on its own is unlabelled, so there was no way to tell which
 *  country or village you were looking at. */
/** The Reference Marks panel sits beside this map but is a separate
 *  component, so it drives the map through here rather than either one
 *  knowing about the other (client req 2026-11-16: double-clicking a mark
 *  takes you to it, and searching by village zooms to that village).
 *  A single point flies in close; several are framed together. */
type GisShow = (points: [number, number][], zoom?: number) => void;
let gisShow: GisShow | null = null;
export function showOnGisMap(points: [number, number][], zoom?: number) {
  if (points.length) gisShow?.(points, zoom);
}
type GisAddConvertedPoint = (a: number, b: number, cs: string, name?: string) => boolean;
let gisAddConvertedPoint: GisAddConvertedPoint | null = null;
let gisConversionPick: ((lat: number, lon: number) => void) | null = null;
const ESRI_BOUNDARIES_PLACES =
  "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";
const BOTSWANA_CENTER: [number, number] = [-22.33, 24.68];
// Allow close inspection beyond the provider's native imagery resolution.
// Leaflet will upscale the best available tile instead of stopping the map
// at z19; maxNativeZoom below prevents requests for non-existent tiles.
const GIS_MAX_ZOOM = 23;

/** Deepest zoom Esri actually has imagery for at a place (client screenshot
 *  2026-10-23: "Map data not yet available" tiles — rural Botswana often only
 *  goes to z17). Asks Esri's tilemap service; beyond this zoom Leaflet scales
 *  up the last real tile instead of showing the placeholder. */
async function esriImageryMaxZoom(lat: number, lon: number): Promise<number> {
  const tile = (z: number) => {
    const n = 2 ** z, r = (lat * Math.PI) / 180;
    return { x: Math.floor(((lon + 180) / 360) * n), y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n) };
  };
  const zs = [19, 18, 17, 16, 15, 14, 13];
  const has = await Promise.all(zs.map(async (z) => {
    try {
      const { x, y } = tile(z);
      const r = await fetch(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tilemap/${z}/${y}/${x}/1/1`);
      const j = await r.json();
      return Array.isArray(j?.data) && j.data[0] === 1;
    } catch {
      return null;
    }
  }));
  if (has.every((h) => h === null)) return 17; // service unreachable: a safe Botswana-wide value
  const i = has.findIndex((h) => h === true);
  return i >= 0 ? zs[i] : 13;
}

function loadLeaflet(): Promise<any> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return reject(new Error("no window"));
    if (window.L) return resolve(window.L);
    if (!document.getElementById("leaflet-css")) {
      const link = document.createElement("link");
      link.id = "leaflet-css";
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);
    }
    const existing = document.getElementById("leaflet-js") as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(window.L));
      existing.addEventListener("error", () => reject(new Error("map library failed to load")));
      if (window.L) resolve(window.L);
      return;
    }
    const s = document.createElement("script");
    s.id = "leaflet-js";
    s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    s.onload = () => resolve(window.L);
    s.onerror = () => reject(new Error("map library failed to load (check internet connection)"));
    document.head.appendChild(s);
  });
}

interface LLBeacon { id: string; lat: number; lon: number; east: number; north: number; rl?: number | null }
interface LLParcel { number: string; ring: [number, number][] }

// ---- Geodetic helpers for drawn features (Haversine-based) ----
const R_EARTH = 6371008.8; // mean radius in metres
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance between two WGS84 points, in metres. */
function haversineM(a: [number, number], b: [number, number]): number {
  const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Total length of a polyline (or polygon perimeter when closed=true). */
function polylineLength(pts: [number, number][], closed: boolean): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversineM(pts[i - 1], pts[i]);
  if (closed && pts.length >= 3) d += haversineM(pts[pts.length - 1], pts[0]);
  return d;
}

/** Spherical excess polygon area in m² (Girard's theorem, good enough for
 *  drawn shapes up to city-scale). */
function polygonAreaM2(pts: [number, number][]): number {
  if (pts.length < 3) return 0;
  // Shoelace on projected coordinates is simpler: we approximate by
  // treating latitude/longitude as a local Cartesian grid scaled by the
  // cosine of the mean latitude — accurate to <0.1% for shapes under a
  // few hundred km.
  const meanLat = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cosLat = Math.cos(toRad(meanLat));
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    // Convert to metres from the mean point
    const ax = toRad(a[1]) * cosLat, ay = toRad(a[0]);
    const bx = toRad(b[1]) * cosLat, by = toRad(b[0]);
    sum += ax * by - bx * ay;
  }
  return Math.abs(sum / 2) * R_EARTH * R_EARTH;
}

function pointInPolygon(point: [number, number], polygon: [number, number][]): boolean {
  let inside = false;
  const [py, px] = point;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i], [yj, xj] = polygon[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function formatArea(m2: number): string {
  if (m2 >= 1e6) return `${(m2 / 1e6).toFixed(4)} km²`;
  if (m2 >= 1e4) return `${(m2 / 1e4).toFixed(4)} ha`;
  return `${m2.toFixed(2)} m²`;
}

function formatLength(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(3)} km`;
  return `${m.toFixed(3)} m`;
}

/**
 * GIS Map (client req): a geo-referenced satellite basemap (Esri World Imagery)
 * with the project's beacons & parcels overlaid, plus KML export / Open in
 * Google Earth. Coordinates are projected (Lo/UTM) → WGS84 via crs.transformPoint.
 */
export function GisMap() {
  const { cogoResult, parcelDoc, config, cogoPlots, cogoWorkspaceDoc, setCogoWorkspaceDoc, importResult } = useStore();
  const mapDivRef = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading map…");

  // ---- Map tools (client req 2026-10-22): live cursor coordinates, an Add
  // Point tool (click the map or type coordinates — the point also lands in
  // the Cadastral/COGO work station) and a ruler. ----
  // Drawing tools (client req 2026-11-17): Draw Polygon, Draw Line, Circle,
  // Calculate Area — same as Google Earth. Drawn features appear as "layers"
  // in a left-side panel.
  type Tool = "none" | "point" | "ruler" | "draw-polygon" | "draw-line" | "draw-circle" | "select-computation" | "select";
  const [tool, setTool] = useState<Tool>("none");
  const toolRef = useRef<Tool>("none");
  toolRef.current = tool;
  const [selectedMapItem, setSelectedMapItem] = useState<
    { kind: "manual-point" | "drawn-layer"; id: string; name: string } | null
  >(null);
  const mapRef = useRef<any>(null);
  const [mapReady, setMapReady] = useState(0);
  const coordBoxRef = useRef<HTMLDivElement | null>(null);
  const manualLayerRef = useRef<any>(null);
  const previewPointLayerRef = useRef<any>(null);
  const rulerLayerRef = useRef<any>(null);
  const pointsLayerRef = useRef<any>(null);
  const polysLayerRef = useRef<any>(null);
  const refMarksLayerRef = useRef<any>(null);
  const gridLayerRef = useRef<any>(null);
  const [showPoints, setShowPoints] = useState(true);
  const [showPolygons, setShowPolygons] = useState(true);
  const [showRefMarks, setShowRefMarks] = useState(false);
  const [showGridLines, setShowGridLines] = useState(true);
  // Manually added points live in the COGO work station's own saved doc
  // ("extra" points), so they show up there and in its Points table.
  const docRef = useRef<Record<string, unknown>>((cogoWorkspaceDoc ?? {}) as Record<string, unknown>);
  const [manualPts, setManualPts] = useState<WPoint[]>(() => ((docRef.current.extra as WPoint[] | undefined) ?? []));
  const [ruler, setRuler] = useState<{ east: number; north: number; lat: number; lon: number }[]>([]);
  // A typed point can be given in any registered system, not only the
  // project's own grid (client req 2026-11-16: "add an option to also add a
  // point by wgs 84 coordinates, UTM"). `cs` is what the pair below is in;
  // it is converted to the project grid on Add.
  const [typed, setTyped] = useState({ name: "", y: "", x: "", cs: "" });
  const [typedErr, setTypedErr] = useState<string | null>(null);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [selectionResult, setSelectionResult] = useState<{
    area: number; volume: number; maxHeight: number; minHeight: number; pointCount: number;
  } | null>(null);
  const src = config.coordinateSystem;
  const toEN = (lat: number, lon: number): [number, number] | null => {
    try {
      const [e, n] = transformPoint(lat, lon, "WGS84", src);
      return isFinite(e) && isFinite(n) ? [e, n] : null;
    } catch {
      return null;
    }
  };
  const toLatLon = (e: number, n: number): [number, number] | null => {
    try {
      const [lat, lon] = transformPoint(e, n, src, "WGS84");
      return isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
    } catch {
      return null;
    }
  };
  function nextPointName(): string {
    const used = new Set(manualPts.map((p) => p.name.toUpperCase()));
    let i = 1;
    while (used.has(`P${i}`)) i++;
    return `P${i}`;
  }
  function addPoint(name: string, east: number, north: number) {
    const p: WPoint = { id: `gis-${Date.now()}-${Math.round(Math.random() * 1e6)}`, name: name.trim() || nextPointName(), east, north };
    setManualPts((cur) => {
      const next = [...cur, p];
      docRef.current = { ...docRef.current, extra: next };
      setCogoWorkspaceDoc(docRef.current);
      return next;
    });
  }
  const addPointRef = useRef(addPoint);
  addPointRef.current = addPoint;
  const toENRef = useRef(toEN);
  toENRef.current = toEN;
  const srcRef = useRef(src);
  srcRef.current = src;
  const toLatLonRef = useRef(toLatLon);
  toLatLonRef.current = toLatLon;
  useEffect(() => {
    gisAddConvertedPoint = (a, b, cs, name = "") => {
      if (!mapRef.current) return false;
      try {
        const [east, north] = cs === srcRef.current ? [a, b] : transformPoint(a, b, cs, srcRef.current);
        const ll = toLatLonRef.current(east, north);
        if (!ll) return false;
        addPointRef.current(name, east, north);
        mapRef.current.setView(ll, Math.max(mapRef.current.getZoom?.() ?? 16, 16));
        return true;
      } catch {
        return false;
      }
    };
    return () => { gisAddConvertedPoint = null; };
  }, []);
  /** What the two boxes mean in a given system. The order is NOT the same
   *  everywhere: a Lo belt is written (Y, X), UTM is written (Easting,
   *  Northing), and a geographic system is (latitude, longitude). Getting
   *  this wrong would drop the point on the other side of the world, so the
   *  labels are driven from the same place the conversion is. */
  function csFields(cs: string): { a: string; b: string; aPh: string; bPh: string } {
    if (isGeographic(cs)) return { a: "Latitude", b: "Longitude", aPh: "Lat (e.g. -24.694249)", bPh: "Lon (e.g. 25.901351)" };
    if (/^UTM/i.test(cs.replace(/\s/g, ""))) return { a: "Easting", b: "Northing", aPh: "Easting (e.g. 389123.45)", bPh: "Northing (e.g. 7268431.02)" };
    return { a: "Y", b: "X", aPh: "Y (e.g. -97468.060)", bPh: "X (e.g. 2728457.058)" };
  }
  function resolveTypedPoint(): { east: number; north: number; ll: [number, number] } | null {
    const cs = typed.cs || src;
    const y = Number(typed.y.replace(/\s/g, "")), x = Number(typed.x.replace(/\s/g, ""));
    const f = csFields(cs);
    if (!typed.y.trim() || !typed.x.trim() || !isFinite(y) || !isFinite(x)) { setTypedErr(`Enter ${f.a} and ${f.b} as numbers.`); return null; }
    // Bring the pair onto the project's own grid first — everything
    // downstream (the point list, the Cadastral work station, the exports)
    // is in that grid, so a point typed in WGS84 or UTM has to land there
    // too rather than being stored in whatever system it was quoted in.
    let e = y, n = x;
    if (cs !== src) {
      try {
        [e, n] = transformPoint(y, x, cs, src);
      } catch (ex: any) {
        setTypedErr(ex?.message ?? `Could not convert from ${cs}.`);
        return null;
      }
      if (!isFinite(e) || !isFinite(n)) { setTypedErr(`Those coordinates don't convert from ${cs}.`); return null; }
    }
    const ll = toLatLon(e, n);
    if (!ll) { setTypedErr(`These coordinates don't fall on the map in ${src}.`); return null; }
    setTypedErr(null);
    return { east: e, north: n, ll };
  }
  function addTypedPoint() {
    const resolved = resolveTypedPoint();
    if (!resolved) return;
    const { east, north, ll } = resolved;
    previewPointLayerRef.current?.clearLayers();
    addPoint(typed.name, east, north);
    setTyped({ name: "", y: "", x: "", cs: typed.cs });
    mapRef.current?.setView(ll, Math.max(mapRef.current.getZoom?.() ?? 16, 16));
  }
  function zoomToTypedPoint() {
    const resolved = resolveTypedPoint();
    if (!resolved) return;
    const L = window.L, map = mapRef.current, layer = previewPointLayerRef.current;
    if (!L || !map || !layer) { setTypedErr("The map is still loading."); return; }
    layer.clearLayers();
    L.circleMarker(resolved.ll, {
      radius: 8, color: "#f59e0b", weight: 3, fillColor: "#fef3c7", fillOpacity: 0.9,
    })
      .bindTooltip(`Preview: ${esc(typed.name.trim() || "new point")}`, { permanent: true, direction: "right", offset: [8, 0] })
      .addTo(layer);
    map.setView(resolved.ll, Math.max(map.getZoom?.() ?? 17, 17));
  }

  async function computeSelection(polygon: [number, number][]) {
    setSelectionError(null);
    setSelectionResult(null);
    if (polygon.length < 3) { setSelectionError("Draw at least three corners around the section."); return; }
    const selected = beacons.filter((b) => b.rl != null && pointInPolygon([b.lat, b.lon], polygon));
    if (selected.length < 3) {
      setSelectionError("The selection needs at least three points with RL values.");
      return;
    }
    const heights = selected.map((p) => p.rl as number);
    const minHeight = Math.min(...heights), maxHeight = Math.max(...heights);
    setSelectionBusy(true);
    try {
      const volume = await apiJson<StockpileResult>("/stockpile", {
        points: selected.map((p) => ({ name: p.id, x: p.east, y: p.north, z: p.rl })),
        interval: 0,
        datumMode: "manual",
        datum: minHeight,
      });
      setSelectionResult({
        area: polygonAreaM2(polygon),
        volume: volume.volume_m3,
        maxHeight,
        minHeight,
        pointCount: selected.length,
      });
    } catch (e: any) {
      setSelectionError(e?.message ?? "Could not compute this selection.");
    } finally {
      setSelectionBusy(false);
    }
  }
  const computeSelectionRef = useRef(computeSelection);
  computeSelectionRef.current = computeSelection;
  // ---- Drawing tools state (client req 2026-11-17) ----
  interface DrawnLayer {
    id: string;
    kind: "polygon" | "line" | "circle";
    name: string;
    visible: boolean;
    // polygon/line: array of [lat,lon]; circle: single centre
    latlngs: [number, number][];
    // circle only
    radius?: number; // metres
    // computed
    areaM2?: number;
    perimeterM?: number;
    leafletId?: number; // internal
  }
  const [drawnLayers, setDrawnLayers] = useState<DrawnLayer[]>([]);
  const drawnLayersRef = useRef<DrawnLayer[]>([]);
  drawnLayersRef.current = drawnLayers;
  const [drawDraft, setDrawDraft] = useState<[number, number][]>([]);
  const drawDraftRef = useRef<[number, number][]>([]);
  drawDraftRef.current = drawDraft;
  const drawLayerRef = useRef<any>(null); // Leaflet layer group for drawn features
  const drawDraftLayerRef = useRef<any>(null); // Leaflet layer group for in-progress drawing
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const drawIdRef = useRef(1);

  function finishDrawing() {
    const t = toolRef.current;
    const pts = drawDraftRef.current;
    if (t === "draw-polygon" && pts.length >= 3) {
      const id = `draw-${Date.now()}-${drawIdRef.current++}`;
      const area = polygonAreaM2(pts);
      const perim = polylineLength(pts, true);
      setDrawnLayers((ls) => [...ls, {
        id, kind: "polygon", name: `Polygon ${drawnLayersRef.current.filter((l) => l.kind === "polygon").length + 1}`,
        visible: true, latlngs: pts, areaM2: area, perimeterM: perim,
      }]);
    } else if (t === "draw-line" && pts.length >= 2) {
      const id = `draw-${Date.now()}-${drawIdRef.current++}`;
      const len = polylineLength(pts, false);
      setDrawnLayers((ls) => [...ls, {
        id, kind: "line", name: `Line ${drawnLayersRef.current.filter((l) => l.kind === "line").length + 1}`,
        visible: true, latlngs: pts, perimeterM: len,
      }]);
    }
    setDrawDraft([]);
    setTool("none");
  }
  function finishCircle(centre: [number, number], radiusM: number) {
    const id = `draw-${Date.now()}-${drawIdRef.current++}`;
    const area = Math.PI * radiusM * radiusM;
    setDrawnLayers((ls) => [...ls, {
      id, kind: "circle",
      name: `Circle ${drawnLayersRef.current.filter((l) => l.kind === "circle").length + 1}`,
      visible: true, latlngs: [centre], radius: radiusM,
      areaM2: area, perimeterM: 2 * Math.PI * radiusM,
    }]);
    setDrawDraft([]);
    setTool("none");
  }
  function removeLayer(id: string) {
    setDrawnLayers((ls) => ls.filter((l) => l.id !== id));
  }
  function deleteSelectedMapItem() {
    if (!selectedMapItem) return;
    if (selectedMapItem.kind === "manual-point") {
      setManualPts((cur) => {
        const next = cur.filter((p) => p.id !== selectedMapItem.id);
        docRef.current = { ...docRef.current, extra: next };
        setCogoWorkspaceDoc(docRef.current);
        return next;
      });
    } else {
      removeLayer(selectedMapItem.id);
    }
    setSelectedMapItem(null);
  }
  function toggleLayerVisibility(id: string) {
    setDrawnLayers((ls) => ls.map((l) => l.id === id ? { ...l, visible: !l.visible } : l));
  }
  function renameLayer(id: string, name: string) {
    setDrawnLayers((ls) => ls.map((l) => l.id === id ? { ...l, name } : l));
  }

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const box = map.getContainer() as HTMLElement;
    if (tool === "none") box.classList.remove("leaflet-crosshair");
    else box.classList.add("leaflet-crosshair");
  }, [tool, mapReady]);
  useEffect(() => {
    if (tool === "none") return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setTool("none"); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool]);

  const { beacons, parcels, inputCount } = useMemo(() => {
    const src = config.coordinateSystem;
    const toLL = (e: number, n: number): [number, number] | null => {
      try {
        const [lat, lon] = transformPoint(e, n, src, "WGS84");
        if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
        return [lat, lon];
      } catch {
        return null;
      }
    };
    const pd = parcelDoc as ParcelDoc | null;
    const beacons: LLBeacon[] = [];
    const parcels: LLParcel[] = [];
    let inputCount = 0;

    if (pd?.beacons?.length) {
      inputCount = pd.beacons.length;
      const by = new Map(pd.beacons.map((b) => [b.id, b] as const));
      for (const b of pd.beacons) {
        const ll = toLL(b.east, b.north);
        if (ll) beacons.push({ id: b.id, lat: ll[0], lon: ll[1], east: b.east, north: b.north });
      }
      for (const p of pd.parcels ?? []) {
        const ring: [number, number][] = [];
        for (const id of p.beaconIds) {
          const b = by.get(id);
          if (b) {
            const ll = toLL(b.east, b.north);
            if (ll) ring.push(ll);
          }
        }
        if (ring.length >= 3) parcels.push({ number: p.number || "parcel", ring });
      }
    } else if (cogoPlots.length) {
      // Plots drawn/numbered in the Cadastral workstation (client req
      // 2026-10-21: "I also want the plot to appear here") — each lot as its
      // own polygon; beacons shared between adjoining lots are placed once.
      const seen = new Set<string>();
      for (const plot of cogoPlots) {
        const ring: [number, number][] = [];
        for (const pt of plot.fig.points) {
          inputCount++;
          const ll = toLL(pt.east, pt.north);
          if (!ll) continue;
          ring.push(ll);
          const key = `${pt.east.toFixed(3)},${pt.north.toFixed(3)}`;
          if (!seen.has(key)) { seen.add(key); beacons.push({ id: pt.name ?? "?", lat: ll[0], lon: ll[1], east: pt.east, north: pt.north }); }
        }
        if (ring.length >= 3) parcels.push({ number: plot.number || "plot", ring });
      }
    } else if (cogoResult?.points?.length) {
      inputCount = cogoResult.points.length;
      const ring: [number, number][] = [];
      for (const p of cogoResult.points) {
        const ll = toLL(p.east, p.north);
        if (ll) {
          beacons.push({ id: p.name ?? "?", lat: ll[0], lon: ll[1], east: p.east, north: p.north });
          ring.push(ll);
        }
      }
      if (ring.length >= 3 && cogoResult.type === "closed") parcels.push({ number: config.name || "figure", ring });
    } else if (importResult?.rows?.length) {
      // COGO can display the raw Data Import point cloud before the user
      // computes a traverse or creates numbered plots. GIS previously had
      // no equivalent fallback, so the same visible COGO points simply
      // disappeared on this tab. Project every valid imported coordinate
      // through the selected project CRS and show it as a map beacon; no
      // polygon is invented because an unordered point cloud has no safe
      // boundary order.
      const rows = importResult.rows.filter((row) => row.east != null && row.north != null);
      inputCount = rows.length;
      for (const row of rows) {
        const ll = toLL(row.east as number, row.north as number);
        if (ll) beacons.push({
          id: row.beaconId ?? `P${row.index}`,
          lat: ll[0], lon: ll[1],
          east: row.east as number, north: row.north as number,
          rl: row.rl,
        });
      }
    }
    return { beacons, parcels, inputCount };
  }, [cogoResult, parcelDoc, cogoPlots, importResult, config.coordinateSystem, config.name]);

  const centroid = useMemo<[number, number]>(() => {
    const all = [...beacons.map((b) => [b.lat, b.lon] as [number, number]), ...parcels.flatMap((p) => p.ring)];
    if (!all.length) return BOTSWANA_CENTER;
    const lat = all.reduce((s, p) => s + p[0], 0) / all.length;
    const lon = all.reduce((s, p) => s + p[1], 0) / all.length;
    return [lat, lon];
  }, [beacons, parcels]);

  useEffect(() => {
    let map: any;
    let cancelled = false;
    setErr(null);
    setStatus("Loading map…");
    loadLeaflet()
      .then((L) => {
        if (cancelled || !mapDivRef.current) return;
        map = L.map(mapDivRef.current, { maxZoom: GIS_MAX_ZOOM });
        // maxNativeZoom starts at 17 (available almost everywhere in
        // Botswana) and is then set to what Esri really has at the place
        // being viewed, re-checked after each move.
        const sat = L.tileLayer(ESRI_IMAGERY, { maxZoom: GIS_MAX_ZOOM, maxNativeZoom: 17, attribution: "Imagery © Esri" });
        const streets = L.tileLayer(OSM, { maxZoom: GIS_MAX_ZOOM, maxNativeZoom: 19, attribution: "© OpenStreetMap" });
        sat.addTo(map);
        let checkSeq = 0;
        const fitImageryZoom = () => {
          const seq = ++checkSeq;
          const c = map.getCenter();
          esriImageryMaxZoom(c.lat, c.lng).then((z) => {
            if (cancelled || seq !== checkSeq || sat.options.maxNativeZoom === z) return;
            sat.options.maxNativeZoom = z;
            if (map.hasLayer(sat)) sat._resetView?.();
          });
        };
        map.on("moveend", fitImageryZoom);
        // Boundaries and place names ride in their own pane, above the
        // imagery but below the survey markers. Without a pane of their own
        // they sit in the tile pane with the base layers, and switching
        // Satellite/Streets re-adds the base map over the top of them.
        map.createPane("labels");
        const labelPane = map.getPane("labels");
        if (labelPane) { labelPane.style.zIndex = "350"; labelPane.style.pointerEvents = "none"; }
        const places = L.tileLayer(ESRI_BOUNDARIES_PLACES, {
          pane: "labels", maxZoom: GIS_MAX_ZOOM, maxNativeZoom: 19, attribution: "Boundaries & places © Esri",
        });
        places.addTo(map);
        L.control.layers(
          { "Satellite (Esri)": sat, "Streets (OSM)": streets },
          { "Boundaries & place names": places }
        ).addTo(map);

        const bounds: [number, number][] = [];
        const polyGroup = L.layerGroup().addTo(map);
        const ptGroup = L.layerGroup().addTo(map);
        pointsLayerRef.current = ptGroup;
        polysLayerRef.current = polyGroup;
        for (const p of parcels) {
          L.polygon(p.ring, { color: "#facc15", weight: 2, fillColor: "#facc15", fillOpacity: 0.15 })
            .bindTooltip(p.number, { permanent: false })
            .addTo(polyGroup);
          bounds.push(...p.ring);
        }
        for (const b of beacons) {
          L.circleMarker([b.lat, b.lon], { radius: 4, color: "#22d3ee", weight: 2, fillColor: "#22d3ee", fillOpacity: 1 })
            .bindTooltip(b.id, { permanent: false })
            .bindPopup(
              `<div style="min-width:210px;font-size:12px">` +
              `<div style="font-weight:700;font-size:13px;margin-bottom:6px">${esc(b.id)}</div>` +
              `<div><span style="color:#64748b">${esc(displayLo(config.coordinateSystem))} Y:</span> ${b.east.toFixed(3)}</div>` +
              `<div><span style="color:#64748b">${esc(displayLo(config.coordinateSystem))} X:</span> ${b.north.toFixed(3)}</div>` +
              (b.rl != null ? `<div><span style="color:#64748b">RL:</span> ${b.rl.toFixed(3)} m</div>` : "") +
              `<div><span style="color:#64748b">Latitude:</span> ${b.lat.toFixed(8)}</div>` +
              `<div><span style="color:#64748b">Longitude:</span> ${b.lon.toFixed(8)}</div>` +
              `</div>`
            )
            .addTo(ptGroup);
          bounds.push([b.lat, b.lon]);
        }
        if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 18 });
        else map.setView(BOTSWANA_CENTER, 6);

        // Live cursor coordinates, bottom-right (client req 2026-10-22).
        const CoordBox = L.Control.extend({
          onAdd() {
            const div = L.DomUtil.create("div");
            div.style.cssText = "background:rgba(255,255,255,0.9);padding:3px 8px;border-radius:4px;font:12px/1.4 ui-monospace,monospace;color:#0f172a;min-width:210px;text-align:right;box-shadow:0 1px 3px rgba(0,0,0,0.25)";
            div.textContent = "Move the cursor over the map";
            coordBoxRef.current = div;
            return div;
          },
        });
        new CoordBox({ position: "bottomright" }).addTo(map);
        map.on("mousemove", (ev: any) => {
          const div = coordBoxRef.current;
          if (!div) return;
          const en = toENRef.current(ev.latlng.lat, ev.latlng.lng);
          div.innerHTML = (en ? `Y ${en[0].toFixed(3)} &nbsp; X ${en[1].toFixed(3)}<br/>` : "") +
            `<span style="color:#64748b">${ev.latlng.lat.toFixed(6)}, ${ev.latlng.lng.toFixed(6)}</span>`;
        });
        map.on("click", (ev: any) => {
          if (gisConversionPick) {
            const pick = gisConversionPick;
            gisConversionPick = null;
            pick(ev.latlng.lat, ev.latlng.lng);
            return;
          }
          const t = toolRef.current;
          if (t === "none") return;
          if (t === "select") { setSelectedMapItem(null); return; }
          const ll: [number, number] = [ev.latlng.lat, ev.latlng.lng];
          const en = toENRef.current(ll[0], ll[1]);
          if (t === "point") { if (en) addPointRef.current("", en[0], en[1]); }
          else if (t === "ruler") { if (en) setRuler((r) => [...r, { east: en[0], north: en[1], lat: ll[0], lon: ll[1] }]); }
          else if (t === "draw-polygon" || t === "draw-line") {
            setDrawDraft((d) => [...d, ll]);
          } else if (t === "select-computation") {
            setDrawDraft((d) => [...d, ll]);
          } else if (t === "draw-circle") {
            const draft = drawDraftRef.current;
            if (draft.length === 0) {
              setDrawDraft([ll]);
            } else {
              const radiusM = haversineM(draft[0], ll);
              finishCircle(draft[0], radiusM);
            }
          }
        });
        // Reference marks layer (off by default — 2057 marks). Hovering
        // names the mark; clicking opens its full record (client req
        // 2026-11-16: "When i click on ref mark it should show its
        // attributs"), including the grid coordinates in the project's own
        // system, which is what the mark actually gets used for. Built when
        // the popup opens, not when the layer is, so it follows a change of
        // coordinate system and costs nothing for the 2000+ unopened marks.
        const rmGroup = L.layerGroup();
        const refMarkPopup = (rm: RefMark) => {
          const row = (k: string, v: string) =>
            v ? `<tr><td style="color:#64748b;padding-right:8px;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="color:#0f172a">${esc(v)}</td></tr>` : "";
          const en = toENRef.current(rm.lat, rm.lon);
          const grid = en ? `${en[0].toFixed(3)},  ${en[1].toFixed(3)}` : "outside this system";
          return (
            `<div style="min-width:210px;font-size:12px">` +
            `<div style="font-weight:700;font-size:13px;color:#0f172a">${esc(rm.number)}</div>` +
            `<div style="color:#475569;margin-bottom:6px">${esc(rm.name)}</div>` +
            `<table style="border-collapse:collapse">` +
            row("Type", rm.type) +
            row("Status", rm.status) +
            row("Region", rm.region) +
            row("Description", rm.description) +
            row(`Y, X (${displayLo(srcRef.current)})`, grid) +
            row("Lat, Lon", `${rm.lat.toFixed(6)},  ${rm.lon.toFixed(6)}`) +
            `</table></div>`
          );
        };
        for (const rm of REF_MARKS) {
          L.circleMarker([rm.lat, rm.lon], { radius: 5, color: "#f97316", weight: 2, fillColor: "#fff7ed", fillOpacity: 0.9 })
            .bindTooltip(`<strong>${rm.number}</strong><br/>${rm.name}`, { permanent: false })
            .bindPopup(() => refMarkPopup(rm), { maxWidth: 320 })
            .addTo(rmGroup);
        }
        refMarksLayerRef.current = rmGroup;
        gridLayerRef.current = L.layerGroup().addTo(map);
        manualLayerRef.current = L.layerGroup().addTo(map);
        previewPointLayerRef.current = L.layerGroup().addTo(map);
        rulerLayerRef.current = L.layerGroup().addTo(map);
        drawLayerRef.current = L.layerGroup().addTo(map);
        drawDraftLayerRef.current = L.layerGroup().addTo(map);
        mapRef.current = map;
        gisShow = (points, zoom) => {
          if (points.length === 1) map.flyTo(points[0], zoom ?? 16, { duration: 0.8 });
          else map.flyToBounds(L.latLngBounds(points).pad(0.25), { duration: 0.8, maxZoom: zoom ?? 15 });
        };
        setMapReady((n) => n + 1);
        setStatus(
          bounds.length
            ? `${beacons.length} beacon(s), ${parcels.length} parcel(s) overlaid.`
            : inputCount > 0
            ? `Could not place ${inputCount} point(s) on the map — the project coordinate system (${config.coordinateSystem}) doesn't match the stored coordinates (out of lat/lon range). Check the project CRS.`
            : "No survey data yet — basemap centred on Botswana."
        );
      })
      .catch((e) => setErr(e.message));
    return () => {
      cancelled = true;
      gisShow = null; // the map this pointed at is about to be destroyed
      mapRef.current = null;
      manualLayerRef.current = null;
      previewPointLayerRef.current = null;
      rulerLayerRef.current = null;
      refMarksLayerRef.current = null;
      gridLayerRef.current = null;
      drawLayerRef.current = null;
      drawDraftLayerRef.current = null;
      coordBoxRef.current = null;
      if (map) map.remove();
    };
  }, [beacons, parcels, inputCount, config.coordinateSystem]);

  // Manually added points (magenta, labelled) — redrawn in place, so adding
  // one never re-zooms the map.
  useEffect(() => {
    const L = window.L, group = manualLayerRef.current;
    if (!L || !group) return;
    group.clearLayers();
    for (const p of manualPts) {
      const ll = toLatLon(p.east, p.north);
      if (!ll) continue;
      const selected = selectedMapItem?.kind === "manual-point" && selectedMapItem.id === p.id;
      const marker = L.circleMarker(ll, {
        radius: selected ? 8 : 5,
        color: selected ? "#dc2626" : "#c026d3",
        weight: selected ? 3 : 2,
        fillColor: selected ? "#fca5a5" : "#f0abfc",
        fillOpacity: 1,
      })
        .bindTooltip(p.name, { permanent: true, direction: "right", offset: [6, 0] })
        .bindPopup(
          `<div style="min-width:210px;font-size:12px">` +
          `<div style="font-weight:700;font-size:13px;margin-bottom:6px">${esc(p.name)}</div>` +
          `<div><span style="color:#64748b">${esc(displayLo(config.coordinateSystem))} Y:</span> ${p.east.toFixed(3)}</div>` +
          `<div><span style="color:#64748b">${esc(displayLo(config.coordinateSystem))} X:</span> ${p.north.toFixed(3)}</div>` +
          `<div><span style="color:#64748b">Latitude:</span> ${ll[0].toFixed(8)}</div>` +
          `<div><span style="color:#64748b">Longitude:</span> ${ll[1].toFixed(8)}</div>` +
          `</div>`
        );
      marker.on("click", (ev: any) => {
        if (toolRef.current !== "select") return;
        L.DomEvent.stopPropagation(ev);
        setSelectedMapItem({ kind: "manual-point", id: p.id, name: p.name });
      });
      marker.addTo(group);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualPts, mapReady, selectedMapItem]);

  // Ruler: the clicked points joined by a line, each leg labelled with its
  // grid distance (from the projected Y/X, like the survey itself).
  useEffect(() => {
    const L = window.L, group = rulerLayerRef.current;
    if (!L || !group) return;
    group.clearLayers();
    if (!ruler.length) return;
    L.polyline(ruler.map((r) => [r.lat, r.lon]), { color: "#f97316", weight: 2, dashArray: "6 4" }).addTo(group);
    ruler.forEach((r, i) => {
      L.circleMarker([r.lat, r.lon], { radius: 4, color: "#f97316", weight: 2, fillColor: "#fff", fillOpacity: 1 }).addTo(group);
      if (i > 0) {
        const a = ruler[i - 1];
        const [, d] = inverse(a, r);
        L.tooltip({ permanent: true, direction: "center", className: "" })
          .setLatLng([(a.lat + r.lat) / 2, (a.lon + r.lon) / 2])
          .setContent(`${d.toFixed(3)} m`)
          .addTo(group);
      }
    });
  }, [ruler, mapReady]);
  const rulerLegs = ruler.slice(1).map((r, i) => inverse(ruler[i], r));
  const rulerTotal = rulerLegs.reduce((s, [, d]) => s + d, 0);

  // Render drawn features (polygons, lines, circles) on the map.
  useEffect(() => {
    const L = window.L, group = drawLayerRef.current;
    if (!L || !group) return;
    group.clearLayers();
    for (const layer of drawnLayers) {
      if (!layer.visible) continue;
      const selected = selectedMapItem?.kind === "drawn-layer" && selectedMapItem.id === layer.id;
      if (layer.kind === "polygon") {
        const pg = L.polygon(layer.latlngs, { color: selected ? "#dc2626" : "#3b82f6", weight: selected ? 4 : 2, fillColor: selected ? "#ef4444" : "#3b82f6", fillOpacity: selected ? 0.22 : 0.15 });
        pg.bindTooltip(layer.name, { permanent: false });
        if (layer.areaM2 != null) pg.bindPopup(`<strong>${esc(layer.name)}</strong><br/>Area: ${formatArea(layer.areaM2)}<br/>Perimeter: ${formatLength(layer.perimeterM ?? 0)}`);
        pg.on("click", (ev: any) => {
          if (toolRef.current === "select") {
            L.DomEvent.stopPropagation(ev);
            setSelectedMapItem({ kind: "drawn-layer", id: layer.id, name: layer.name });
            return;
          }
          if (toolRef.current !== "select-computation") return;
          L.DomEvent.stopPropagation(ev);
          setDrawDraft(layer.latlngs);
          void computeSelectionRef.current(layer.latlngs);
        });
        pg.addTo(group);
      } else if (layer.kind === "line") {
        const pl = L.polyline(layer.latlngs, { color: selected ? "#dc2626" : "#ef4444", weight: selected ? 5 : 2.5 });
        pl.bindTooltip(layer.name, { permanent: false });
        if (layer.perimeterM != null) pl.bindPopup(`<strong>${esc(layer.name)}</strong><br/>Length: ${formatLength(layer.perimeterM)}`);
        pl.on("click", (ev: any) => {
          if (toolRef.current !== "select") return;
          L.DomEvent.stopPropagation(ev);
          setSelectedMapItem({ kind: "drawn-layer", id: layer.id, name: layer.name });
        });
        pl.addTo(group);
      } else if (layer.kind === "circle" && layer.radius != null) {
        const c = L.circle(layer.latlngs[0], { radius: layer.radius, color: selected ? "#dc2626" : "#8b5cf6", weight: selected ? 4 : 2, fillColor: selected ? "#ef4444" : "#8b5cf6", fillOpacity: selected ? 0.2 : 0.1 });
        c.bindTooltip(layer.name, { permanent: false });
        c.bindPopup(`<strong>${esc(layer.name)}</strong><br/>Radius: ${formatLength(layer.radius)}<br/>Area: ${formatArea(layer.areaM2 ?? 0)}`);
        c.on("click", (ev: any) => {
          if (toolRef.current !== "select") return;
          L.DomEvent.stopPropagation(ev);
          setSelectedMapItem({ kind: "drawn-layer", id: layer.id, name: layer.name });
        });
        c.addTo(group);
      }
    }
  }, [drawnLayers, mapReady, selectedMapItem]);

  // Render the in-progress drawing draft (dashed preview).
  useEffect(() => {
    const L = window.L, group = drawDraftLayerRef.current;
    if (!L || !group) return;
    group.clearLayers();
    if (!drawDraft.length) return;
    if (tool === "draw-polygon" || tool === "draw-line" || tool === "select-computation") {
      L.polyline(drawDraft, { color: "#3b82f6", weight: 2, dashArray: "6 4" }).addTo(group);
      for (const pt of drawDraft) {
        L.circleMarker(pt, { radius: 4, color: "#3b82f6", weight: 2, fillColor: "#fff", fillOpacity: 1 }).addTo(group);
      }
    } else if (tool === "draw-circle" && drawDraft.length === 1) {
      L.circleMarker(drawDraft[0], { radius: 5, color: "#8b5cf6", weight: 2, fillColor: "#fff", fillOpacity: 1 }).addTo(group);
    }
  }, [drawDraft, tool, mapReady]);

  // Clear draft when tool changes away from a draw tool.
  useEffect(() => {
    if (tool !== "draw-polygon" && tool !== "draw-line" && tool !== "draw-circle" && tool !== "select-computation") {
      setDrawDraft([]);
      const group = drawDraftLayerRef.current;
      if (group) group.clearLayers();
    }
  }, [tool]);

  // Publish drawing state to the external DrawingToolsPanel component.
  useEffect(() => {
    publishDrawingState(
      { tool, drawDraft, drawnLayers },
      {
        setTool: (t: string) => setTool(t as Tool),
        finishDrawing,
        undoLast: () => setDrawDraft((d) => d.slice(0, -1)),
        cancelDraw: () => { setDrawDraft([]); setTool("none"); },
        toggleLayer: toggleLayerVisibility,
        renameLayer,
        removeLayer,
      }
    );
  });

  function buildKml(): string {
    const marks: string[] = [];
    for (const b of beacons) marks.push(`<Placemark><name>${esc(b.id)}</name><Point><coordinates>${b.lon},${b.lat},0</coordinates></Point></Placemark>`);
    for (const p of manualPts) {
      const ll = toLatLon(p.east, p.north);
      if (ll) marks.push(`<Placemark><name>${esc(p.name)}</name><Point><coordinates>${ll[1]},${ll[0]},0</coordinates></Point></Placemark>`);
    }
    for (const p of parcels) {
      const coords = [...p.ring, p.ring[0]].map(([la, lo]) => `${lo},${la},0`).join(" ");
      marks.push(`<Placemark><name>${esc(p.number)}</name><Style><LineStyle><color>ff00ccff</color><width>2</width></LineStyle><PolyStyle><color>3300ccff</color></PolyStyle></Style><Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`);
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(config.name || "Survey")}</name>${marks.join("")}</Document></kml>`;
  }
  // Toggle points/polygons layer visibility
  useEffect(() => {
    const map = mapRef.current;
    const layer = pointsLayerRef.current;
    if (!map || !layer) return;
    if (showPoints) map.addLayer(layer); else map.removeLayer(layer);
  }, [showPoints, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = polysLayerRef.current;
    if (!map || !layer) return;
    if (showPolygons) map.addLayer(layer); else map.removeLayer(layer);
  }, [showPolygons, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = refMarksLayerRef.current;
    if (!map || !layer) return;
    if (showRefMarks) map.addLayer(layer); else map.removeLayer(layer);
  }, [showRefMarks, mapReady]);

  // Elo graticule: only odd-numbered whole-degree lines are named/drawn
  // (21, 23, 25, 27, 29). Do not add decimal, minute or second labels.
  useEffect(() => {
    const L = window.L, map = mapRef.current, group = gridLayerRef.current;
    if (!L || !map || !group) return;
    const draw = () => {
      group.clearLayers();
      if (!showGridLines) return;
      const bounds = map.getBounds();
      const west = bounds.getWest(), east = bounds.getEast();
      const south = bounds.getSouth(), north = bounds.getNorth();
      const step = 1;
      const label = (v: number, axis: "lat" | "lon") =>
        `${Math.abs(v).toFixed(0)}°${axis === "lat" ? (v < 0 ? "S" : "N") : (v < 0 ? "W" : "E")}`;
      const lineStyle = { color: "#475569", weight: 1, opacity: 0.5, interactive: false };
      const icon = (text: string, rotate = false, horizontalTick = false) => L.divIcon({
        className: "",
        html: `<span style="display:inline-flex;align-items:center;gap:2px;background:rgba(255,255,255,.86);padding:1px 3px;border-radius:2px;color:#334155;font:10px/1.2 ui-monospace,monospace;white-space:nowrap;${rotate ? "transform:rotate(-90deg);transform-origin:left top;" : ""}"><i style="display:inline-block;${horizontalTick ? "width:8px;height:0;border-top:1px solid #334155" : "width:0;height:8px;border-left:1px solid #334155"}"></i>${text}</span>`,
        iconSize: [1, 1],
        iconAnchor: [0, 0],
      });
      const lonStart = Math.ceil(west / step) * step;
      for (let lon = lonStart, guard = 0; lon <= east + step * 1e-6 && guard < 50; lon += step, guard++) {
        const v = Number(lon.toFixed(10));
        if (Math.abs(Math.round(v)) % 2 !== 1) continue;
        L.polyline([[south, v], [north, v]], lineStyle).addTo(group);
        L.marker([north - (north - south) * 0.035, v], { icon: icon(label(v, "lon")), interactive: false }).addTo(group);
        L.marker([south + (north - south) * 0.035, v], { icon: icon(label(v, "lon")), interactive: false }).addTo(group);
      }
      const latStart = Math.ceil(south / step) * step;
      for (let lat = latStart, guard = 0; lat <= north + step * 1e-6 && guard < 50; lat += step, guard++) {
        const v = Number(lat.toFixed(10));
        if (Math.abs(Math.round(v)) % 2 !== 1) continue;
        L.polyline([[v, west], [v, east]], lineStyle).addTo(group);
        L.marker([v, west + (east - west) * 0.015], { icon: icon(label(v, "lat"), true, true), interactive: false }).addTo(group);
        L.marker([v, east - (east - west) * 0.015], { icon: icon(label(v, "lat"), true, true), interactive: false }).addTo(group);
      }
    };
    draw();
    map.on("moveend", draw);
    return () => { map.off("moveend", draw); group.clearLayers(); };
  }, [showGridLines, mapReady]);

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  function exportKml() {
    const blob = new Blob([buildKml()], { type: "application/vnd.google-earth.kml+xml" });
    downloadBlob(blob, `${(config.name || "survey").replace(/\s+/g, "_")}.kml`);
  }
  // Client req 2026-10-22: "I should also be able to export KML, kmz files"
  // — KMZ is just KML zipped (Google Earth's own preferred format, since it
  // keeps a large placemark set small); same content as Export KML above,
  // wrapped with the dependency-free zip writer already built for the
  // Shapefile export (lib/zip.ts), named doc.kml inside the archive — the
  // conventional root filename every KMZ reader (Google Earth included)
  // looks for.
  function exportKmz() {
    const blob = createZip([{ name: "doc.kml", data: new TextEncoder().encode(buildKml()) }]);
    downloadBlob(blob, `${(config.name || "survey").replace(/\s+/g, "_")}.kmz`);
  }

  /** Export the live GIS drawing, including every edit made on this screen,
   * in the project's survey grid. DXF is a Cartesian format, so map-drawn
   * WGS84 vertices are converted back to the active Lo/UTM grid before they
   * are written. Invisible drawing layers are intentionally retained: hiding
   * a layer is a display edit, not a request to discard its survey data. */
  function exportDxf() {
    const drawing: ImportedDrawing = { points: [], polylines: [], circles: [], texts: [] };

    for (const b of beacons) {
      drawing.points.push({ x: b.east, y: b.north, label: b.id, layer: "SURVEY_POINTS" });
    }
    for (const p of manualPts) {
      drawing.points.push({ x: p.east, y: p.north, label: p.name, layer: "GIS_POINTS" });
    }
    for (const parcel of parcels) {
      const pts = parcel.ring.map(([lat, lon]) => toEN(lat, lon)).filter((p): p is [number, number] => p != null);
      if (pts.length < 3) continue;
      drawing.polylines.push({ pts: pts.map(([x, y]) => ({ x, y })), closed: true, layer: "PARCELS" });
      const x = pts.reduce((sum, p) => sum + p[0], 0) / pts.length;
      const y = pts.reduce((sum, p) => sum + p[1], 0) / pts.length;
      drawing.texts.push({ x, y, text: parcel.number, height: 2.5, layer: "PARCEL_LABELS", anchor: "middle" });
    }
    for (const layer of drawnLayers) {
      const pts = layer.latlngs.map(([lat, lon]) => toEN(lat, lon)).filter((p): p is [number, number] => p != null);
      if (layer.kind === "circle") {
        const centre = pts[0];
        if (centre && layer.radius && layer.radius > 0) {
          drawing.circles!.push({ x: centre[0], y: centre[1], r: layer.radius, layer: "GIS_CIRCLES" });
          drawing.texts.push({ x: centre[0], y: centre[1], text: layer.name, height: 2.5, layer: "GIS_LABELS", anchor: "middle" });
        }
        continue;
      }
      const minimum = layer.kind === "polygon" ? 3 : 2;
      if (pts.length < minimum) continue;
      drawing.polylines.push({
        pts: pts.map(([x, y]) => ({ x, y })),
        closed: layer.kind === "polygon",
        layer: layer.kind === "polygon" ? "GIS_POLYGONS" : "GIS_LINES",
      });
      const x = pts.reduce((sum, p) => sum + p[0], 0) / pts.length;
      const y = pts.reduce((sum, p) => sum + p[1], 0) / pts.length;
      drawing.texts.push({ x, y, text: layer.name, height: 2.5, layer: "GIS_LABELS", anchor: "middle" });
    }

    const blob = new Blob([writeDxf(drawing)], { type: "application/dxf" });
    downloadBlob(blob, `${(config.name || "survey").replace(/\s+/g, "_")}_gis.dxf`);
  }

  const earthUrl = `https://earth.google.com/web/@${centroid[0]},${centroid[1]},1000a,3000d,35y,0h,0t,0r`;
  // Client-added points (the Add Point tool) count as exportable data too —
  // previously this only looked at beacons/parcels, so a project with
  // nothing BUT manually-added GIS points had both export buttons
  // wrongly disabled.
  const hasData = beacons.length > 0 || manualPts.length > 0 || parcels.length > 0 || drawnLayers.length > 0;

  return (
    <div>
      <Card title="GIS Map — satellite basemap & survey overlay">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Button onClick={exportKml} disabled={!hasData}>⬇ Export KML</Button>
          <Button onClick={exportKmz} disabled={!hasData}>⬇ Export KMZ</Button>
          <Button onClick={exportDxf} disabled={!hasData}>⬇ Export DXF</Button>
          <a href={earthUrl} target="_blank" rel="noopener noreferrer">
            <Button variant="ghost">Open in Google Earth →</Button>
          </a>
          <Button variant={tool === "point" ? "primary" : "ghost"} onClick={() => setTool((t) => (t === "point" ? "none" : "point"))}>
            {tool === "point" ? "Click the map to add points…" : "Add Point"}
          </Button>
          <Button variant={tool === "ruler" ? "primary" : "ghost"} onClick={() => setTool((t) => (t === "ruler" ? "none" : "ruler"))}>
            <RulerIcon />
            {tool === "ruler" ? "Click points to measure…" : "Ruler"}
          </Button>
          <Button
            variant={tool === "select" ? "primary" : "ghost"}
            onClick={() => {
              const active = tool === "select";
              setTool(active ? "none" : "select");
              if (active) setSelectedMapItem(null);
            }}
          >
            {tool === "select" ? "Click an item…" : "Select"}
          </Button>
          <Button variant="ghost" onClick={deleteSelectedMapItem} disabled={!selectedMapItem}>
            Delete
          </Button>
          {selectedMapItem && <span className="text-xs text-red-600">Selected: {selectedMapItem.name}</span>}
          <Button
            variant={tool === "select-computation" ? "primary" : "ghost"}
            onClick={() => {
              const active = tool === "select-computation";
              setTool(active ? "none" : "select-computation");
              setDrawDraft([]);
              setSelectionResult(null);
              setSelectionError(null);
            }}
          >
            Selecting Computation
          </Button>
          {tool === "select-computation" && drawDraft.length >= 3 && (
            <Button variant="ghost" onClick={() => void computeSelection(drawDraft)} disabled={selectionBusy}>
              {selectionBusy ? "Computing…" : "Compute Selection"}
            </Button>
          )}
          <span className="text-xs text-slate-500">{err ? `Map error: ${err}` : status}</span>
          {/* Layer visibility toggles */}
          {(beacons.length > 0 || parcels.length > 0) && (
            <span className="ml-2 flex items-center gap-2 border-l border-slate-200 pl-2 text-xs text-slate-600">
              <label className="flex cursor-pointer items-center gap-1">
                <input type="checkbox" checked={showPoints} onChange={(e) => setShowPoints(e.target.checked)} className="accent-brand" />
                Points
              </label>
              <label className="flex cursor-pointer items-center gap-1">
                <input type="checkbox" checked={showPolygons} onChange={(e) => setShowPolygons(e.target.checked)} className="accent-brand" />
                Polygons
              </label>
            </span>
          )}
          <span className="ml-2 flex items-center gap-2 border-l border-slate-200 pl-2 text-xs text-slate-600">
            <label className="flex cursor-pointer items-center gap-1">
              <input type="checkbox" checked={showGridLines} onChange={(e) => setShowGridLines(e.target.checked)} className="accent-brand" />
              Grid Lines
            </label>
            <label className="flex cursor-pointer items-center gap-1">
              <input type="checkbox" checked={showRefMarks} onChange={(e) => setShowRefMarks(e.target.checked)} className="accent-brand" />
              Ref Marks
            </label>
          </span>
        </div>
        {tool === "select-computation" && !selectionResult && !selectionError && (
          <p className="mb-2 text-xs text-slate-500">Click around the required section, then choose Compute Selection. You can also click an existing drawn polygon.</p>
        )}
        {selectionError && <p className="mb-2 text-xs text-red-600">{selectionError}</p>}
        {selectionResult && (
          <div className="mb-2 flex flex-wrap gap-x-5 gap-y-1 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-700">
            <span><strong>Area:</strong> {formatArea(selectionResult.area)}</span>
            <span><strong>Volume:</strong> {selectionResult.volume.toLocaleString(undefined, { maximumFractionDigits: 3 })} m³</span>
            <span><strong>Maximum height:</strong> {selectionResult.maxHeight.toFixed(3)} m</span>
            <span><strong>Lowest height:</strong> {selectionResult.minHeight.toFixed(3)} m</span>
            <span className="text-slate-400">{selectionResult.pointCount} selected point(s)</span>
          </div>
        )}
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span className="font-medium">Add point by coordinates:</span>
          {/* Any registered system, not just the project's grid. The boxes
              relabel themselves because the order differs per system — see
              csFields. The point is converted onto the project grid on Add. */}
          <select
            value={typed.cs || src}
            onChange={(e) => { setTyped((t) => ({ ...t, cs: e.target.value })); setTypedErr(null); }}
            title="The system the coordinates below are in"
            className="max-w-[190px] rounded-md border border-slate-200 px-2 py-1 focus:border-brand focus:outline-none"
          >
            {!CRS_LIST.some((c) => c.code === src) && <option value={src}>{displayLo(src)} (project)</option>}
            {CRS_LIST.map((c) => (
              <option key={c.code} value={c.code}>{c.code === src ? `${c.label} — project` : c.label}</option>
            ))}
          </select>
          <input value={typed.name} onChange={(e) => setTyped((t) => ({ ...t, name: e.target.value }))} placeholder={`Name (${nextPointName()})`} className="w-28 rounded-md border border-slate-200 px-2 py-1 focus:border-brand focus:outline-none" />
          <input value={typed.y} onChange={(e) => setTyped((t) => ({ ...t, y: e.target.value }))} placeholder={csFields(typed.cs || src).aPh} className="w-44 rounded-md border border-slate-200 px-2 py-1 font-mono focus:border-brand focus:outline-none" />
          <input value={typed.x} onChange={(e) => setTyped((t) => ({ ...t, x: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter") addTypedPoint(); }} placeholder={csFields(typed.cs || src).bPh} className="w-44 rounded-md border border-slate-200 px-2 py-1 font-mono focus:border-brand focus:outline-none" />
          <Button variant="ghost" onClick={addTypedPoint}>Add</Button>
          <Button variant="ghost" onClick={zoomToTypedPoint}>Zoom to Point</Button>
          {typedErr && <span className="text-red-600">{typedErr}</span>}
          {!typedErr && (typed.cs || src) !== src && (
            <span className="text-slate-400">converted to {displayLo(src)} on Add</span>
          )}
          {manualPts.length > 0 && <span className="text-slate-400">{manualPts.length} added point(s) — also in the Cadastral work station.</span>}
        </div>
        {ruler.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-3 rounded-md bg-orange-50 px-3 py-1.5 text-xs text-orange-900">
            <span className="font-medium">Ruler:</span>
            {rulerLegs.length > 0 ? (
              <>
                <span>last leg {rulerLegs[rulerLegs.length - 1][1].toFixed(3)} m, bearing {formatDms(rulerLegs[rulerLegs.length - 1][0])}</span>
                {rulerLegs.length > 1 && <span>total {rulerTotal.toFixed(3)} m ({rulerLegs.length} legs)</span>}
              </>
            ) : (
              <span>click a second point</span>
            )}
            <Button variant="ghost" onClick={() => setRuler([])}>Clear ruler</Button>
          </div>
        )}
        {/* The basemap is the work surface on this tab, so it takes the
            height the screen actually has instead of a fixed 600px box
            (client req 2026-11-15: "Increase this windo"). The floor keeps
            it at its old size on a short screen, so nothing gets smaller
            than it was; the offset is the header, tab bar and the toolbar
            rows above it. */}
        <div ref={mapDivRef} className="h-[calc(100vh-260px)] min-h-[600px] w-full rounded-lg border border-slate-200 bg-slate-100" />
        <p className="mt-2 text-xs text-slate-400">
          Basemap: Esri World Imagery (geo-referenced satellite). Your beacons &amp; parcels are projected from
          {" "}{config.coordinateSystem} to WGS84 and overlaid. Switch Satellite/Streets, and turn country boundaries and place names on or off, via the layers control.
          {!hasData && " Build a parcel or run a closed traverse to see your survey on the map."}
        </p>
      </Card>
    </div>
  );
}

/** Coordinate conversion panel: UTM <-> WGS84 <-> LO (any registered CRS). */
export function CoordConverter({ projectCs }: { projectCs: string }) {
  const defaultSrc = CRS_LIST.find((c) => projectCs.includes(c.code.replace("Lo", "Lo ")))?.code
    ?? CRS_LIST.find((c) => c.code.startsWith("Lo 25"))?.code
    ?? CRS_LIST[0].code;
  const [src, setSrc] = useState(defaultSrc);
  const [dst, setDst] = useState("WGS84");
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [result, setResult] = useState<[number, number] | null>(null);
  const [err, setErr] = useState("");
  const [resultNote, setResultNote] = useState("");
  const [manualPoints, setManualPoints] = useState("");
  const [pickingMapPoint, setPickingMapPoint] = useState(false);
  useEffect(() => () => { gisConversionPick = null; }, []);
  // Whole-file conversion (client req 2026-11-16: "Add option to load csv")
  // — the single Y/X pair above is fine for one check, but a job arrives as
  // a list. Reuses the same CSV reader the Data Import tab uses, so the same
  // headers, aliases and junk-file detection apply here.
  const csvRef = useRef<HTMLInputElement>(null);
  const [batch, setBatch] = useState<{ name: string; a: number; b: number }[] | null>(null);
  const [batchNote, setBatchNote] = useState("");

  function loadCsv(file: File) {
    setErr(""); setBatch(null); setBatchNote("");
    const reader = new FileReader();
    reader.onerror = () => setErr("Could not read that file.");
    reader.onload = () => {
      try {
        const parsed = parseSurveyCsv(String(reader.result ?? ""));
        // The Y box is the easting field and the X box the northing one, the
        // way this grid is written down here — the same pairing "Add point by
        // coordinates" uses on the map above. Keep them in that order.
        const usable = parsed.rows.filter((r) => r.east != null && r.north != null);
        if (usable.length === 0) {
          setErr(parsed.notice ?? "No rows with both coordinates were found in that file.");
          return;
        }
        const out: { name: string; a: number; b: number }[] = [];
        let failed = 0;
        for (const r of usable) {
          try {
            const [x, y] = transformPoint(r.east as number, r.north as number, src, dst);
            out.push({ name: r.beaconId ?? `P${r.index}`, a: x, b: y });
          } catch { failed++; }
        }
        if (out.length === 0) { setErr("None of those coordinates could be converted between the chosen systems."); return; }
        setBatch(out);
        const skipped = parsed.rows.length - usable.length;
        setBatchNote(
          `${out.length} converted` +
          (skipped ? ` · ${skipped} row${skipped > 1 ? "s" : ""} without coordinates skipped` : "") +
          (failed ? ` · ${failed} failed` : "")
        );
      } catch (e: any) {
        setErr(e?.message ?? "Could not read that CSV.");
      }
    };
    reader.readAsText(file);
  }

  function convertManualPoints() {
    setErr(""); setBatch(null); setBatchNote(""); setResultNote("");
    const lines = manualPoints.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) { setErr("Enter one or more points first."); return; }
    const out: { name: string; a: number; b: number }[] = [];
    let failed = 0;
    lines.forEach((line, index) => {
      const cells = line.split(",").map((cell) => cell.trim());
      const hasName = cells.length >= 3;
      const name = hasName ? cells[0] : `P${index + 1}`;
      const av = Number(cells[hasName ? 1 : 0]);
      const bv = Number(cells[hasName ? 2 : 1]);
      if (!name || !isFinite(av) || !isFinite(bv)) { failed++; return; }
      try {
        const [ra, rb] = transformPoint(av, bv, src, dst);
        if (!isFinite(ra) || !isFinite(rb)) { failed++; return; }
        out.push({ name, a: ra, b: rb });
      } catch { failed++; }
    });
    if (out.length === 0) { setErr("No valid points were found. Use Name,Y,X or Y,X, one point per line."); return; }
    setBatch(out);
    setBatchNote(`${out.length} converted${failed ? ` · ${failed} invalid line${failed > 1 ? "s" : ""} skipped` : ""}`);
  }

  function downloadBatch() {
    if (!batch) return;
    const geo = dst === "WGS84";
    const head = geo ? "Name,Latitude,Longitude" : "Name,Y,X";
    const dp = geo ? 8 : 3;
    const csv = [head, ...batch.map((r) => `${r.name},${r.a.toFixed(dp)},${r.b.toFixed(dp)}`)].join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `converted-${dst.replace(/[^A-Za-z0-9]+/g, "")}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function convert() {
    setErr(""); setResult(null); setResultNote("");
    const av = parseFloat(a), bv = parseFloat(b);
    if (isNaN(av) || isNaN(bv)) { setErr("Enter valid numbers in both fields."); return; }
    try {
      setResult(transformPoint(av, bv, src, dst));
    } catch (e: any) {
      setErr(e?.message ?? "Conversion failed.");
    }
  }

  function addResultToMap() {
    if (!result) return;
    const added = gisAddConvertedPoint?.(result[0], result[1], dst) ?? false;
    setResultNote(added ? "Added to map." : "The point could not be added to the map.");
  }

  async function copyResult() {
    if (!result) return;
    const labels = isGeoDst ? ["Lat", "Lon"] : ["Y", "X"];
    const dp = isGeoDst ? 8 : 3;
    const text = `${labels[0]}: ${result[0].toFixed(dp)}\n${labels[1]}: ${result[1].toFixed(dp)}`;
    try {
      await navigator.clipboard.writeText(text);
      setResultNote("Copied.");
    } catch {
      setResultNote("Could not copy the result.");
    }
  }

  function addBatchToMap() {
    if (!batch) return;
    const added = batch.reduce((count, point) =>
      count + (gisAddConvertedPoint?.(point.a, point.b, dst, point.name) ? 1 : 0), 0);
    setBatchNote(`${added} of ${batch.length} added to map.`);
  }

  async function copyBatch() {
    if (!batch) return;
    const dp = isGeoDst ? 8 : 3;
    const text = batch.map((point) => `${point.name},${point.a.toFixed(dp)},${point.b.toFixed(dp)}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setBatchNote(`${batch.length} point${batch.length > 1 ? "s" : ""} copied.`);
    } catch {
      setBatchNote("Could not copy the converted points.");
    }
  }

  function pickPointOnMap() {
    if (pickingMapPoint) {
      gisConversionPick = null;
      setPickingMapPoint(false);
      setResultNote("");
      return;
    }
    setPickingMapPoint(true);
    setResultNote("Click a point on the map.");
    gisConversionPick = (lat, lon) => {
      setPickingMapPoint(false);
      try {
        const source = src === "WGS84" ? [lat, lon] as [number, number] : transformPoint(lat, lon, "WGS84", src);
        const converted = transformPoint(source[0], source[1], src, dst);
        const sourceDp = src === "WGS84" ? 8 : 3;
        setA(source[0].toFixed(sourceDp));
        setB(source[1].toFixed(sourceDp));
        setResult(converted);
        setErr("");
        setResultNote("Map point converted.");
      } catch (e: any) {
        setErr(e?.message ?? "That map point could not be converted.");
        setResultNote("");
      }
    };
  }

  const srcInfo = CRS_LIST.find((c) => c.code === src);
  const dstInfo = CRS_LIST.find((c) => c.code === dst);
  const isGeoSrc = src === "WGS84";
  const isGeoDst = dst === "WGS84";

  return (
    <Card title="Coordinate Conversion — UTM / WGS84 / Lo">
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">From</label>
            <select value={src} onChange={(e) => { setSrc(e.target.value); setResult(null); setBatch(null); setBatchNote(""); }}
              className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm focus:border-brand focus:outline-none">
              {CRS_LIST.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div>
                <label className="mb-0.5 block text-xs text-slate-500">{isGeoSrc ? "Latitude" : "Y (Northing)"}</label>
                <input value={a} onChange={(e) => { setA(e.target.value); setResult(null); }}
                  placeholder={isGeoSrc ? "e.g. -22.5" : "e.g. -97468.06"}
                  className="h-10 w-full rounded-md border border-slate-200 px-3 font-mono text-base focus:border-brand focus:outline-none" />
              </div>
              <div>
                <label className="mb-0.5 block text-xs text-slate-500">{isGeoSrc ? "Longitude" : "X (Easting)"}</label>
                <input value={b} onChange={(e) => { setB(e.target.value); setResult(null); }}
                  placeholder={isGeoSrc ? "e.g. 25.9" : "e.g. 2728457.06"}
                  onKeyDown={(e) => { if (e.key === "Enter") convert(); }}
                  className="h-10 w-full rounded-md border border-slate-200 px-3 font-mono text-base focus:border-brand focus:outline-none" />
              </div>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">To</label>
            <select value={dst} onChange={(e) => { setDst(e.target.value); setResult(null); setBatch(null); setBatchNote(""); }}
              className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm focus:border-brand focus:outline-none">
              {CRS_LIST.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
            {result && (
              <div className="mt-2 rounded-md bg-slate-50 px-3 py-2 font-mono text-sm">
                <div className="text-xs text-slate-500 mb-1">{dstInfo?.label}</div>
                {isGeoDst ? (
                  <>
                    <div>Lat: <span className="font-medium">{result[0].toFixed(8)}</span></div>
                    <div>Lon: <span className="font-medium">{result[1].toFixed(8)}</span></div>
                  </>
                ) : (
                  <>
                    <div>Y: <span className="font-medium">{result[0].toFixed(3)}</span></div>
                    <div>X: <span className="font-medium">{result[1].toFixed(3)}</span></div>
                  </>
                )}
              </div>
            )}
            {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={convert}>Convert</Button>
          <Button variant="ghost" onClick={pickPointOnMap}>{pickingMapPoint ? "Cancel Pick" : "Pick on Map"}</Button>
          {result && <Button variant="ghost" onClick={addResultToMap}>Add to Map</Button>}
          {result && <Button variant="ghost" onClick={copyResult}>Copy</Button>}
          <button onClick={() => { setSrc(dst); setDst(src); setResult(null); setBatch(null); setBatchNote(""); }}
            className="text-xs text-slate-500 hover:text-slate-800 underline">
            Swap
          </button>
        </div>
        {resultNote && <p className="text-xs text-slate-500">{resultNote}</p>}

        <div className="border-t border-slate-200 pt-3">
          <label className="mb-1 block text-xs font-medium text-slate-600">Type one or multiple points</label>
          <textarea
            value={manualPoints}
            onChange={(e) => setManualPoints(e.target.value)}
            rows={5}
            placeholder={"A,-97468.060,2728457.058\nB,-97470.125,2728462.441\n-97475.300,2728470.900"}
            className="w-full resize-y rounded-md border border-slate-200 px-3 py-2 font-mono text-sm focus:border-brand focus:outline-none"
          />
          <p className="mt-1 text-xs text-slate-400">One per line: Name,Y,X or Y,X.</p>
          <div className="mt-2">
            <Button variant="ghost" onClick={convertManualPoints}>Convert Points</Button>
          </div>
        </div>

        {/* A whole file at once (client req 2026-11-16). Same From/To pair as
            the single conversion above, so the list converts exactly the way
            one typed point would. */}
        <div className="border-t border-slate-200 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" onClick={() => csvRef.current?.click()}>Load CSV</Button>
            {batch && <Button variant="ghost" onClick={downloadBatch}>Download converted</Button>}
            {batch && <Button variant="ghost" onClick={addBatchToMap}>Add All to Map</Button>}
            {batch && <Button variant="ghost" onClick={copyBatch}>Copy All</Button>}
            {batch && (
              <button onClick={() => { setBatch(null); setBatchNote(""); }}
                className="text-xs text-slate-500 hover:text-slate-800 underline">Clear</button>
            )}
            <input
              ref={csvRef} type="file" accept=".csv,.txt" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) loadCsv(f); e.target.value = ""; }}
            />
          </div>
          {!batch && !err && (
            <p className="mt-1 text-xs text-slate-400">
              Columns: name, {isGeoSrc ? "latitude, longitude" : "Y, X"} — with or without a header row.
            </p>
          )}
          {batchNote && <p className="mt-1 text-xs text-slate-500">{batchNote}</p>}
          {batch && (
            <div className="mt-2 max-h-56 overflow-y-auto rounded-md bg-slate-50 px-2 py-1.5">
              <table className="w-full font-mono text-[11px] tabular-nums">
                <thead>
                  <tr className="text-left text-slate-500">
                    <th className="pr-2 font-medium">Name</th>
                    <th className="pr-2 font-medium">{isGeoDst ? "Lat" : "Y"}</th>
                    <th className="font-medium">{isGeoDst ? "Lon" : "X"}</th>
                  </tr>
                </thead>
                <tbody>
                  {batch.map((r, i) => (
                    <tr key={i}>
                      <td className="pr-2 truncate">{r.name}</td>
                      <td className="pr-2">{r.a.toFixed(isGeoDst ? 8 : 3)}</td>
                      <td>{r.b.toFixed(isGeoDst ? 8 : 3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/** "Lo 25 Botswana" -> "Lo 25°" for labels. */
function displayLo(cs: string): string {
  const m = cs.match(/Lo\s*(\d+)/i);
  return m ? `Lo ${m[1]}°` : cs;
}

/** Client req 2026-10-22 ("use ruler icon"): a plain monochrome ruler glyph
 *  for the Ruler tool button — a measuring bar with tick marks, same
 *  stroke-icon convention used throughout the app (no colour). */
function RulerIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="2.5" y="8.5" width="19" height="7" rx="1" />
      <path d="M6 8.5v2.5M9.5 8.5v4M13 8.5v2.5M16.5 8.5v4" strokeWidth="1.3" />
    </svg>
  );
}

/** Drawing tools + layers panel (client req 2026-11-17: "it should appear on
 *  the left side as layers" — under the Coordinate Conversion panel). The
 *  drawing state lives in GisMap above; this panel drives it via the shared
 *  module-level channel, same pattern as showOnGisMap. */
type DrawTool = "draw-polygon" | "draw-line" | "draw-circle";
interface DrawingPanelState {
  tool: string;
  drawDraft: [number, number][];
  drawnLayers: { id: string; kind: string; name: string; visible: boolean; latlngs: [number, number][]; radius?: number; areaM2?: number; perimeterM?: number }[];
}
type DrawingPanelActions = {
  setTool: (t: string) => void;
  finishDrawing: () => void;
  undoLast: () => void;
  cancelDraw: () => void;
  toggleLayer: (id: string) => void;
  renameLayer: (id: string, name: string) => void;
  removeLayer: (id: string) => void;
};
let _drawingPanelState: DrawingPanelState = { tool: "none", drawDraft: [], drawnLayers: [] };
let _drawingPanelActions: DrawingPanelActions | null = null;
let _drawingPanelNotify: (() => void) | null = null;

/** Called by GisMap to push its state to the external panel. */
function publishDrawingState(s: DrawingPanelState, a: DrawingPanelActions) {
  _drawingPanelState = s;
  _drawingPanelActions = a;
  _drawingPanelNotify?.();
}

export function DrawingToolsPanel() {
  const [, setTick] = useState(0);
  useEffect(() => {
    _drawingPanelNotify = () => setTick((n) => n + 1);
    return () => { _drawingPanelNotify = null; };
  }, []);
  const { tool, drawDraft, drawnLayers } = _drawingPanelState;
  const a = _drawingPanelActions;
  const setTool = (t: string) => a?.setTool(t);
  return (
    <Card title="Drawing Tools & Layers">
      {/* ---- Drawing tools ---- */}
      <div className="flex flex-col gap-1">
        <button
          className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${tool === "draw-polygon" ? "bg-brand text-white" : "text-slate-700 hover:bg-slate-100"}`}
          onClick={() => setTool(tool === "draw-polygon" ? "none" : "draw-polygon")}
        >
          <PolygonIcon /> Draw Polygon
        </button>
        <button
          className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${tool === "draw-line" ? "bg-brand text-white" : "text-slate-700 hover:bg-slate-100"}`}
          onClick={() => setTool(tool === "draw-line" ? "none" : "draw-line")}
        >
          <LineIcon /> Draw Line
        </button>
        <button
          className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${tool === "draw-circle" ? "bg-brand text-white" : "text-slate-700 hover:bg-slate-100"}`}
          onClick={() => setTool(tool === "draw-circle" ? "none" : "draw-circle")}
        >
          <CircleIcon /> Circle
        </button>
      </div>
      {/* Drawing status / finish controls */}
      {(tool === "draw-polygon" || tool === "draw-line") && drawDraft.length > 0 && (
        <div className="mt-2 rounded-md bg-blue-50 px-3 py-2 text-[11px] text-blue-800">
          <div className="font-medium">{drawDraft.length} point{drawDraft.length !== 1 ? "s" : ""}</div>
          {drawDraft.length >= 2 && <div>{formatLength(polylineLength(drawDraft, false))}</div>}
          {tool === "draw-polygon" && drawDraft.length >= 3 && <div>Area: {formatArea(polygonAreaM2(drawDraft))}</div>}
          <div className="mt-1 flex gap-1">
            <button onClick={() => a?.finishDrawing()}
              disabled={tool === "draw-polygon" ? drawDraft.length < 3 : drawDraft.length < 2}
              className="rounded bg-brand px-2 py-0.5 text-[10px] font-semibold text-white disabled:opacity-40">Finish</button>
            <button onClick={() => a?.undoLast()}
              className="rounded bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600 hover:bg-slate-200">Undo</button>
            <button onClick={() => a?.cancelDraw()}
              className="rounded bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600 hover:bg-slate-200">Cancel</button>
          </div>
        </div>
      )}
      {tool === "draw-circle" && drawDraft.length === 1 && (
        <div className="mt-2 rounded-md bg-purple-50 px-3 py-2 text-[11px] text-purple-800">
          <div>Centre placed — click map to set radius</div>
          <button onClick={() => a?.cancelDraw()}
            className="mt-1 rounded bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600 hover:bg-slate-200">Cancel</button>
        </div>
      )}
      {/* ---- Layers list ---- */}
      <div className="mt-3 border-t border-slate-200 pt-2 text-xs font-semibold text-slate-700">
        Layers{drawnLayers.length > 0 ? ` (${drawnLayers.length})` : ""}
      </div>
      {drawnLayers.length === 0 ? (
        <div className="py-2 text-[11px] text-slate-400">
          No layers yet. Use the tools above to draw on the map.
        </div>
      ) : (
        drawnLayers.map((layer) => (
          <div key={layer.id} className="border-b border-slate-100 py-2 text-xs">
            <div className="flex items-center gap-1.5">
              <input type="checkbox" checked={layer.visible} onChange={() => a?.toggleLayer(layer.id)}
                className="accent-brand" style={{ width: 13, height: 13 }} />
              <span className="inline-block h-2 w-2 rounded-full shrink-0" style={{
                backgroundColor: layer.kind === "polygon" ? "#3b82f6" : layer.kind === "line" ? "#ef4444" : "#8b5cf6",
              }} />
              <input
                value={layer.name}
                onChange={(e) => a?.renameLayer(layer.id, e.target.value)}
                className="min-w-0 flex-1 truncate bg-transparent text-[11px] font-medium text-slate-700 outline-none focus:bg-slate-50 focus:px-1"
                title="Click to rename"
              />
              <button onClick={() => a?.removeLayer(layer.id)}
                className="shrink-0 text-slate-400 hover:text-red-500" title="Delete">
                x
              </button>
            </div>
            <div className="mt-0.5 pl-5 text-[10px] text-slate-500 leading-relaxed">
              {layer.kind === "polygon" && (
                <>
                  <div>Area: {formatArea(layer.areaM2 ?? 0)}</div>
                  <div>Perimeter: {formatLength(layer.perimeterM ?? 0)}</div>
                </>
              )}
              {layer.kind === "line" && (
                <div>Length: {formatLength(layer.perimeterM ?? 0)}</div>
              )}
              {layer.kind === "circle" && (
                <>
                  <div>Radius: {formatLength(layer.radius ?? 0)}</div>
                  <div>Area: {formatArea(layer.areaM2 ?? 0)}</div>
                </>
              )}
            </div>
          </div>
        ))
      )}
    </Card>
  );
}

function PolygonIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M5 17L3 7l8-3 7 3 2 10-6 4z" />
    </svg>
  );
}

function LineIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 20L20 4" />
      <circle cx="4" cy="20" r="2" />
      <circle cx="20" cy="4" r="2" />
    </svg>
  );
}

function CircleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
