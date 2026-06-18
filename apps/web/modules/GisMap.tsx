"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { Button, Card } from "@/components/ui";
import { transformPoint } from "@/lib/server/crs";
import type { ParcelDoc } from "@/lib/types";

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
  const { cogoResult, parcelDoc, config } = useStore();
  const mapDivRef = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading map…");

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
  }, [cogoResult, parcelDoc, config.coordinateSystem, config.name]);

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
        const sat = L.tileLayer(ESRI_IMAGERY, { maxZoom: 19, attribution: "Imagery © Esri" });
        const streets = L.tileLayer(OSM, { maxZoom: 19, attribution: "© OpenStreetMap" });
        sat.addTo(map);
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
      if (map) map.remove();
    };
  }, [beacons, parcels, inputCount, config.coordinateSystem]);

  function exportKml() {
    const marks: string[] = [];
    for (const b of beacons) marks.push(`<Placemark><name>${esc(b.id)}</name><Point><coordinates>${b.lon},${b.lat},0</coordinates></Point></Placemark>`);
    for (const p of parcels) {
      const coords = [...p.ring, p.ring[0]].map(([la, lo]) => `${lo},${la},0`).join(" ");
      marks.push(`<Placemark><name>${esc(p.number)}</name><Style><LineStyle><color>ff00ccff</color><width>2</width></LineStyle><PolyStyle><color>3300ccff</color></PolyStyle></Style><Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`);
    }
    const kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(config.name || "Survey")}</name>${marks.join("")}</Document></kml>`;
    const blob = new Blob([kml], { type: "application/vnd.google-earth.kml+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(config.name || "survey").replace(/\s+/g, "_")}.kml`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const earthUrl = `https://earth.google.com/web/@${centroid[0]},${centroid[1]},1000a,3000d,35y,0h,0t,0r`;
  const hasData = beacons.length > 0;

  return (
    <div className="space-y-4">
      <Card title="GIS Map — satellite basemap & survey overlay">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Button onClick={exportKml} disabled={!hasData}>⬇ Export KML</Button>
          <a href={earthUrl} target="_blank" rel="noopener noreferrer">
            <Button variant="ghost">Open in Google Earth →</Button>
          </a>
          <span className="text-xs text-slate-500">{err ? `Map error: ${err}` : status}</span>
        </div>
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

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
