"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { Button, Card } from "@/components/ui";
import { transformPoint, CRS_LIST, isGeographic } from "@/lib/server/crs";
import { parseSurveyCsv } from "@/lib/server/csv";
import { inverse } from "@/lib/server/geometry";
import { formatDms } from "@/lib/server/angles";
import { createZip } from "@/lib/zip";
import type { ParcelDoc } from "@/lib/types";
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
const ESRI_BOUNDARIES_PLACES =
  "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";
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
  const pointsLayerRef = useRef<any>(null);
  const polysLayerRef = useRef<any>(null);
  const refMarksLayerRef = useRef<any>(null);
  const [showPoints, setShowPoints] = useState(true);
  const [showPolygons, setShowPolygons] = useState(true);
  const [showRefMarks, setShowRefMarks] = useState(false);
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
  function addTypedPoint() {
    const cs = typed.cs || src;
    const y = Number(typed.y.replace(/\s/g, "")), x = Number(typed.x.replace(/\s/g, ""));
    const f = csFields(cs);
    if (!typed.y.trim() || !typed.x.trim() || !isFinite(y) || !isFinite(x)) { setTypedErr(`Enter ${f.a} and ${f.b} as numbers.`); return; }
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
        return;
      }
      if (!isFinite(e) || !isFinite(n)) { setTypedErr(`Those coordinates don't convert from ${cs}.`); return; }
    }
    const ll = toLatLon(e, n);
    if (!ll) { setTypedErr(`These coordinates don't fall on the map in ${src}.`); return; }
    setTypedErr(null);
    addPoint(typed.name, e, n);
    setTyped({ name: "", y: "", x: "", cs: typed.cs });
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
        // Boundaries and place names ride in their own pane, above the
        // imagery but below the survey markers. Without a pane of their own
        // they sit in the tile pane with the base layers, and switching
        // Satellite/Streets re-adds the base map over the top of them.
        map.createPane("labels");
        const labelPane = map.getPane("labels");
        if (labelPane) { labelPane.style.zIndex = "350"; labelPane.style.pointerEvents = "none"; }
        const places = L.tileLayer(ESRI_BOUNDARIES_PLACES, {
          pane: "labels", maxZoom: 19, attribution: "Boundaries & places © Esri",
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
          const t = toolRef.current;
          if (t === "none") return;
          const en = toENRef.current(ev.latlng.lat, ev.latlng.lng);
          if (!en) return;
          if (t === "point") addPointRef.current("", en[0], en[1]);
          else setRuler((r) => [...r, { east: en[0], north: en[1], lat: ev.latlng.lat, lon: ev.latlng.lng }]);
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
      refMarksLayerRef.current = null;
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
    <div>
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
              <input type="checkbox" checked={showRefMarks} onChange={(e) => setShowRefMarks(e.target.checked)} className="accent-brand" />
              Ref Marks
            </label>
          </span>
        </div>
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
    setErr(""); setResult(null);
    const av = parseFloat(a), bv = parseFloat(b);
    if (isNaN(av) || isNaN(bv)) { setErr("Enter valid numbers in both fields."); return; }
    try {
      setResult(transformPoint(av, bv, src, dst));
    } catch (e: any) {
      setErr(e?.message ?? "Conversion failed.");
    }
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
                  className="w-full rounded-md border border-slate-200 px-2 py-1 font-mono text-sm focus:border-brand focus:outline-none" />
              </div>
              <div>
                <label className="mb-0.5 block text-xs text-slate-500">{isGeoSrc ? "Longitude" : "X (Easting)"}</label>
                <input value={b} onChange={(e) => { setB(e.target.value); setResult(null); }}
                  placeholder={isGeoSrc ? "e.g. 25.9" : "e.g. 2728457.06"}
                  onKeyDown={(e) => { if (e.key === "Enter") convert(); }}
                  className="w-full rounded-md border border-slate-200 px-2 py-1 font-mono text-sm focus:border-brand focus:outline-none" />
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
          <button onClick={() => { setSrc(dst); setDst(src); setResult(null); setBatch(null); setBatchNote(""); }}
            className="text-xs text-slate-500 hover:text-slate-800 underline">
            Swap
          </button>
        </div>

        {/* A whole file at once (client req 2026-11-16). Same From/To pair as
            the single conversion above, so the list converts exactly the way
            one typed point would. */}
        <div className="border-t border-slate-200 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" onClick={() => csvRef.current?.click()}>Load CSV</Button>
            {batch && <Button variant="ghost" onClick={downloadBatch}>Download converted</Button>}
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

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
