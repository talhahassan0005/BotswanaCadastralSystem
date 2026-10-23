"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { Button, Card } from "@/components/ui";
import { transformPoint } from "@/lib/server/crs";
import { inverse } from "@/lib/server/geometry";
import { formatDms } from "@/lib/server/angles";
import { createZip } from "@/lib/zip";
import type { ParcelDoc } from "@/lib/types";
import type { WPoint } from "@/lib/cogoTools/types";

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
const BOTSWANA_CENTER: [number, number] = [-22.33, 24.68];

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

interface LLBeacon { id: string; lat: number; lon: number }
interface LLParcel { number: string; ring: [number, number][] }

/**
 * GIS Map (client req): a geo-referenced satellite basemap (Esri World Imagery)
 * with the project's beacons & parcels overlaid, plus KML export / Open in
 * Google Earth. Coordinates are projected (Lo/UTM) → WGS84 via crs.transformPoint.
 */
export function GisMap() {
  const { cogoResult, parcelDoc, config, cogoPlots, cogoWorkspaceDoc, setCogoWorkspaceDoc } = useStore();
  const mapDivRef = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading map…");

  // ---- Map tools (client req 2026-10-22): live cursor coordinates, an Add
  // Point tool (click the map or type coordinates — the point also lands in
  // the Cadastral/COGO work station) and a ruler. ----
  type Tool = "none" | "point" | "ruler";
  const [tool, setTool] = useState<Tool>("none");
  const toolRef = useRef<Tool>("none");
  toolRef.current = tool;
  const mapRef = useRef<any>(null);
  const [mapReady, setMapReady] = useState(0);
  const coordBoxRef = useRef<HTMLDivElement | null>(null);
  const manualLayerRef = useRef<any>(null);
  const rulerLayerRef = useRef<any>(null);
  // Manually added points live in the COGO work station's own saved doc
  // ("extra" points), so they show up there and in its Points table.
  const docRef = useRef<Record<string, unknown>>((cogoWorkspaceDoc ?? {}) as Record<string, unknown>);
  const [manualPts, setManualPts] = useState<WPoint[]>(() => ((docRef.current.extra as WPoint[] | undefined) ?? []));
  const [ruler, setRuler] = useState<{ east: number; north: number; lat: number; lon: number }[]>([]);
  const [typed, setTyped] = useState({ name: "", y: "", x: "" });
  const [typedErr, setTypedErr] = useState<string | null>(null);
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
  function addTypedPoint() {
    const y = Number(typed.y.replace(/\s/g, "")), x = Number(typed.x.replace(/\s/g, ""));
    if (!typed.y.trim() || !typed.x.trim() || !isFinite(y) || !isFinite(x)) { setTypedErr("Enter Y and X as numbers."); return; }
    const ll = toLatLon(y, x);
    if (!ll) { setTypedErr(`These coordinates don't fall on the map in ${src}.`); return; }
    setTypedErr(null);
    addPoint(typed.name, y, x);
    setTyped({ name: "", y: "", x: "" });
    mapRef.current?.setView(ll, Math.max(mapRef.current.getZoom?.() ?? 16, 16));
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
        if (ll) beacons.push({ id: b.id, lat: ll[0], lon: ll[1] });
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
          if (!seen.has(key)) { seen.add(key); beacons.push({ id: pt.name ?? "?", lat: ll[0], lon: ll[1] }); }
        }
        if (ring.length >= 3) parcels.push({ number: plot.number || "plot", ring });
      }
    } else if (cogoResult?.points?.length) {
      inputCount = cogoResult.points.length;
      const ring: [number, number][] = [];
      for (const p of cogoResult.points) {
        const ll = toLL(p.east, p.north);
        if (ll) {
          beacons.push({ id: p.name ?? "?", lat: ll[0], lon: ll[1] });
          ring.push(ll);
        }
      }
      if (ring.length >= 3 && cogoResult.type === "closed") parcels.push({ number: config.name || "figure", ring });
    }
    return { beacons, parcels, inputCount };
  }, [cogoResult, parcelDoc, cogoPlots, config.coordinateSystem, config.name]);

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
        map = L.map(mapDivRef.current);
        // maxNativeZoom starts at 17 (available almost everywhere in
        // Botswana) and is then set to what Esri really has at the place
        // being viewed, re-checked after each move.
        const sat = L.tileLayer(ESRI_IMAGERY, { maxZoom: 19, maxNativeZoom: 17, attribution: "Imagery © Esri" });
        const streets = L.tileLayer(OSM, { maxZoom: 19, attribution: "© OpenStreetMap" });
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
        L.control.layers({ "Satellite (Esri)": sat, "Streets (OSM)": streets }).addTo(map);

        const bounds: [number, number][] = [];
        for (const p of parcels) {
          L.polygon(p.ring, { color: "#facc15", weight: 2, fillColor: "#facc15", fillOpacity: 0.15 })
            .bindTooltip(p.number, { permanent: false })
            .addTo(map);
          bounds.push(...p.ring);
        }
        for (const b of beacons) {
          L.circleMarker([b.lat, b.lon], { radius: 4, color: "#22d3ee", weight: 2, fillColor: "#22d3ee", fillOpacity: 1 })
            .bindTooltip(b.id, { permanent: false })
            .addTo(map);
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
          const t = toolRef.current;
          if (t === "none") return;
          const en = toENRef.current(ev.latlng.lat, ev.latlng.lng);
          if (!en) return;
          if (t === "point") addPointRef.current("", en[0], en[1]);
          else setRuler((r) => [...r, { east: en[0], north: en[1], lat: ev.latlng.lat, lon: ev.latlng.lng }]);
        });
        manualLayerRef.current = L.layerGroup().addTo(map);
        rulerLayerRef.current = L.layerGroup().addTo(map);
        mapRef.current = map;
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
      mapRef.current = null;
      manualLayerRef.current = null;
      rulerLayerRef.current = null;
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
      L.circleMarker(ll, { radius: 5, color: "#c026d3", weight: 2, fillColor: "#f0abfc", fillOpacity: 1 })
        .bindTooltip(p.name, { permanent: true, direction: "right", offset: [6, 0] })
        .addTo(group);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualPts, mapReady]);

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

  const earthUrl = `https://earth.google.com/web/@${centroid[0]},${centroid[1]},1000a,3000d,35y,0h,0t,0r`;
  // Client-added points (the Add Point tool) count as exportable data too —
  // previously this only looked at beacons/parcels, so a project with
  // nothing BUT manually-added GIS points had both export buttons
  // wrongly disabled.
  const hasData = beacons.length > 0 || manualPts.length > 0;

  return (
    <div className="space-y-4">
      <Card title="GIS Map — satellite basemap & survey overlay">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Button onClick={exportKml} disabled={!hasData}>⬇ Export KML</Button>
          <Button onClick={exportKmz} disabled={!hasData}>⬇ Export KMZ</Button>
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
          <span className="text-xs text-slate-500">{err ? `Map error: ${err}` : status}</span>
        </div>
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span className="font-medium">Add point by coordinates ({displayLo(src)}):</span>
          <input value={typed.name} onChange={(e) => setTyped((t) => ({ ...t, name: e.target.value }))} placeholder={`Name (${nextPointName()})`} className="w-28 rounded-md border border-slate-200 px-2 py-1 focus:border-brand focus:outline-none" />
          <input value={typed.y} onChange={(e) => setTyped((t) => ({ ...t, y: e.target.value }))} placeholder="Y (e.g. -97468.060)" className="w-40 rounded-md border border-slate-200 px-2 py-1 font-mono focus:border-brand focus:outline-none" />
          <input value={typed.x} onChange={(e) => setTyped((t) => ({ ...t, x: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter") addTypedPoint(); }} placeholder="X (e.g. 2728457.058)" className="w-40 rounded-md border border-slate-200 px-2 py-1 font-mono focus:border-brand focus:outline-none" />
          <Button variant="ghost" onClick={addTypedPoint}>Add</Button>
          {typedErr && <span className="text-red-600">{typedErr}</span>}
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
        <div ref={mapDivRef} className="h-[480px] w-full rounded-lg border border-slate-200 bg-slate-100" />
        <p className="mt-2 text-xs text-slate-400">
          Basemap: Esri World Imagery (geo-referenced satellite). Your beacons &amp; parcels are projected from
          {" "}{config.coordinateSystem} to WGS84 and overlaid. Switch Satellite/Streets via the layers control.
          {!hasData && " Build a parcel or run a closed traverse to see your survey on the map."}
        </p>
      </Card>
    </div>
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

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
