"use client";

import { useMemo, useState } from "react";
import { Badge, Button, Card, Input } from "@/components/ui";
import {
  REF_MARKS,
  directionsUrl,
  nearestMarks,
  searchMarks,
  type RefMark,
} from "@/lib/refmarks";
import { transformPoint } from "@/lib/server/crs";

const STATUS_KIND: Record<RefMark["status"], string> = {
  "In good order": "valid",
  "Witness mark": "check",
  "Reported destroyed": "error",
  "Not visited": "default",
};

export function RefMarks() {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [user, setUser] = useState<{ lat: number; lon: number } | null>(null);
  const [geo, setGeo] = useState<{ state: "idle" | "locating" | "ok" | "error"; msg?: string }>({ state: "idle" });

  const filtered = useMemo(() => searchMarks(query), [query]);
  const rows = useMemo(
    () =>
      user
        ? nearestMarks(user.lat, user.lon, filtered.length, filtered)
        : filtered.map((mark) => ({ mark, km: undefined as number | undefined })),
    [filtered, user]
  );
  const selected = selectedId ? REF_MARKS.find((m) => m.id === selectedId) ?? null : null;

  function locate() {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeo({ state: "error", msg: "Geolocation is not supported by this browser." });
      return;
    }
    setGeo({ state: "locating" });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUser({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setGeo({ state: "ok" });
      },
      (err) => {
        setUser(null); // drop the stale fix so the list reverts to unsorted
        setGeo({ state: "error", msg: err.message || "Unable to get your location." });
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
      {/* List + search */}
      <div className="space-y-4">
        <Card title="Reference Marks" icon={<span>📍</span>}>
          <Input value={query} onChange={setQuery} placeholder="Search by number, place, region…" />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button onClick={locate} disabled={geo.state === "locating"}>
              {geo.state === "locating" ? "Locating…" : "📡 Nearest to me"}
            </Button>
            {user && (
              <Button variant="ghost" onClick={() => setUser(null)}>Clear location</Button>
            )}
          </div>
          {geo.state === "ok" && user && (
            <p className="mt-2 text-xs text-emerald-600">
              Your location: {user.lat.toFixed(5)}, {user.lon.toFixed(5)} — list sorted by distance.
            </p>
          )}
          {geo.state === "error" && <p className="mt-2 text-xs text-red-600">{geo.msg}</p>}
          <p className="mt-2 text-xs text-slate-400">{rows.length} of {REF_MARKS.length} marks</p>
        </Card>

        <div className="max-h-[460px] space-y-2 overflow-y-auto pr-1">
          {rows.map(({ mark, km }) => (
            <button
              key={mark.id}
              onClick={() => setSelectedId(mark.id)}
              className={`block w-full rounded-lg border p-3 text-left transition ${
                selectedId === mark.id ? "border-brand bg-brand-light/30" : "border-slate-200 bg-white hover:bg-slate-50"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-800">{mark.number}</span>
                {km != null && <span className="text-xs font-medium text-brand-dark">{fmtKm(km)}</span>}
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-2">
                <span className="text-sm text-slate-600">{mark.name} · {mark.region}</span>
                <Badge kind={STATUS_KIND[mark.status]}>{mark.status}</Badge>
              </div>
            </button>
          ))}
          {rows.length === 0 && <p className="px-1 text-sm text-slate-400">No marks match “{query}”.</p>}
        </div>
      </div>

      {/* Map + detail */}
      <div className="space-y-5">
        <Card title="Locator Map" icon={<span>🗺</span>}>
          <RefMap marks={REF_MARKS} filteredIds={new Set(filtered.map((m) => m.id))} selected={selected} user={user} onSelect={setSelectedId} />
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
            <span className="flex items-center gap-1"><Dot c="#0f172a" /> mark</span>
            <span className="flex items-center gap-1"><Dot c="#059669" /> selected</span>
            <span className="flex items-center gap-1"><Dot c="#2563eb" /> you</span>
            <span className="ml-auto">Seed data — replace with the official DSM dataset.</span>
          </div>
        </Card>

        {selected && <Detail mark={selected} user={user} />}
      </div>
    </div>
  );
}

function Detail({ mark, user }: { mark: RefMark; user: { lat: number; lon: number } | null }) {
  // Show the official Lo grid coordinates (nearest 2° odd belt) alongside WGS84.
  const cm = nearestOddMeridian(mark.lon);
  const [Y, X] = useMemo(() => transformPoint(mark.lat, mark.lon, "WGS84", `Lo${cm}`), [mark, cm]);
  const dist = user ? nearestMarks(user.lat, user.lon, 1, [mark])[0]?.km : undefined;

  return (
    <Card title={`${mark.number} — ${mark.name}`} icon={<span>📍</span>}>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <Row label="Type" value={mark.type} />
        <Row label="Status" value={mark.status} />
        <Row label="Region" value={mark.region} />
        {dist != null && <Row label="Distance from you" value={fmtKm(dist)} />}
        <Row label="Latitude (WGS84)" value={mark.lat.toFixed(6)} />
        <Row label="Longitude (WGS84)" value={mark.lon.toFixed(6)} />
        <Row label={`Lo ${cm}° Y`} value={Y.toFixed(2)} />
        <Row label={`Lo ${cm}° X`} value={X.toFixed(2)} />
      </dl>
      <p className="mt-3 text-sm text-slate-600"><span className="text-slate-400">Description: </span>{mark.description}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <a
          href={directionsUrl(mark.lat, mark.lon)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-dark"
        >
          🧭 Directions
        </a>
        <a
          href={`https://www.google.com/maps?q=${mark.lat},${mark.lon}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          View on map
        </a>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Locator map (equirectangular, dependency-free)
// ---------------------------------------------------------------------------
function RefMap({
  marks,
  filteredIds,
  selected,
  user,
  onSelect,
}: {
  marks: RefMark[];
  filteredIds: Set<string>;
  selected: RefMark | null;
  user: { lat: number; lon: number } | null;
  onSelect: (id: string) => void;
}) {
  const W = 760;
  const H = 520;
  const pad = 46;

  const pts = [...marks.map((m) => ({ lon: m.lon, lat: m.lat })), ...(user ? [user] : [])];
  const lat0 = pts.reduce((s, p) => s + p.lat, 0) / (pts.length || 1);
  const k = Math.cos((lat0 * Math.PI) / 180) || 1; // longitude compression
  const px = (lon: number) => lon * k;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, px(p.lon)); maxX = Math.max(maxX, px(p.lon));
    minY = Math.min(minY, p.lat); maxY = Math.max(maxY, p.lat);
  }
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const offX = (W - spanX * scale) / 2;
  const offY = (H - spanY * scale) / 2;
  const toX = (lon: number) => offX + (px(lon) - minX) * scale;
  const toY = (lat: number) => offY + (maxY - lat) * scale; // north up

  return (
    <svg viewBox={`0 0 ${W} ${H}`} xmlns="http://www.w3.org/2000/svg" style={{ width: "100%", height: "auto", background: "#f8fafc", borderRadius: 12 }}>
      {/* user position + rings to marks omitted for clarity */}
      {marks.map((m) => {
        const x = toX(m.lon), y = toY(m.lat);
        const isSel = selected?.id === m.id;
        const dim = !filteredIds.has(m.id) && !isSel; // never dim the active selection
        return (
          <g
            key={m.id}
            role="button"
            tabIndex={0}
            aria-label={`${m.number} — ${m.name}`}
            onClick={() => onSelect(m.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(m.id);
              }
            }}
            style={{ cursor: "pointer" }}
            opacity={dim ? 0.3 : 1}
          >
            <title>{`${m.number} — ${m.name}`}</title>
            <circle cx={x} cy={y} r={isSel ? 7 : 4.5} fill={isSel ? "#059669" : "#0f172a"} stroke="white" strokeWidth={1.4} />
            <text x={x + 8} y={y + 3} fontSize={10} fill="#334155">{m.number}</text>
          </g>
        );
      })}
      {user && (
        <g>
          <circle cx={toX(user.lon)} cy={toY(user.lat)} r={6} fill="#2563eb" stroke="white" strokeWidth={2} />
          <circle cx={toX(user.lon)} cy={toY(user.lat)} r={12} fill="none" stroke="#2563eb" strokeWidth={1.2} opacity={0.5} />
          <text x={toX(user.lon) + 10} y={toY(user.lat) - 8} fontSize={10} fontWeight="bold" fill="#2563eb">You</text>
        </g>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
function nearestOddMeridian(lon: number): number {
  const cm = 2 * Math.round((lon - 1) / 2) + 1; // nearest odd integer
  return Math.min(29, Math.max(13, cm)); // clamp to supported Lo13–Lo29 belts
}

function fmtKm(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

function Dot({ c }: { c: string }) {
  return <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c }} />;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="font-medium text-slate-800">{value}</dd>
    </div>
  );
}
