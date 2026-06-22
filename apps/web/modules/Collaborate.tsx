"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount } from "@/lib/account";
import { useStore } from "@/lib/store";
import { Badge, Button, Card, Field, Input } from "@/components/ui";
import { checkIn, checkOut, listActiveCheckIns, subscribeCheckIns, type CheckIn } from "@/lib/checkins";
import { haversineKm } from "@/lib/refmarks";

export function Collaborate() {
  const { user, configured } = useAccount();
  const { config } = useStore();

  const [checkins, setCheckins] = useState<CheckIn[]>([]);
  const [pos, setPos] = useState<{ lat: number; lon: number } | null>(null);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [contact, setContact] = useState("");
  const [share, setShare] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    const { data, error } = await listActiveCheckIns();
    setCheckins(data);
    if (error) setError(error);
  }
  useEffect(() => {
    if (!user) return;
    reload();
    const unsub = subscribeCheckIns(reload); // live updates
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const mine = user ? checkins.find((c) => c.surveyor === user.id) ?? null : null;
  const others = checkins.filter((c) => c.surveyor !== user?.id);
  const surveyorName = (user?.user_metadata?.full_name as string) || config.surveyor || user?.email || "Surveyor";

  function locate(then?: (p: { lat: number; lon: number }) => void) {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoMsg("Geolocation is not supported by this browser.");
      return;
    }
    setGeoMsg("Locating…");
    navigator.geolocation.getCurrentPosition(
      (g) => { const p = { lat: g.coords.latitude, lon: g.coords.longitude }; setPos(p); setGeoMsg(null); then?.(p); },
      (e) => setGeoMsg(e.message || "Unable to get your location."),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  async function doCheckIn() {
    if (!user || !pos) return;
    setBusy(true); setError(null);
    const { error } = await checkIn({
      surveyor: user.id, surveyor_name: surveyorName, project_name: config.name,
      lat: pos.lat, lon: pos.lon, note, contact, share_contact: share,
    });
    setBusy(false);
    if (error) { setError(error); return; }
    reload();
  }
  async function doCheckOut() {
    if (!user) return;
    setBusy(true);
    await checkOut(user.id);
    setBusy(false);
    reload();
  }

  // ---- gated states ----
  if (!configured) {
    return <Card><div className="py-10 text-center text-slate-500">The collaboration backend isn’t configured.</div></Card>;
  }
  if (!user) {
    return (
      <Card>
        <div className="py-10 text-center text-slate-500">
          <p className="text-lg">Sign in to check in &amp; collaborate</p>
          <p className="mt-1 text-sm">Use the bar above to sign in, then check in at your project to network with nearby surveyors.</p>
        </div>
      </Card>
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
      {/* My status / check-in */}
      <div className="space-y-4">
        <Card title="Your Check-in">
          {mine ? (
            <div className="space-y-2 text-sm">
              <p className="text-emerald-600">You are checked in.</p>
              <Row label="At" value={`${mine.lat.toFixed(5)}, ${mine.lon.toFixed(5)}`} />
              <Row label="Project" value={mine.project_name ?? "—"} />
              {mine.note && <Row label="Note" value={mine.note} />}
              <Row label="Contact shared" value={mine.share_contact ? "Yes" : "No"} />
              <div className="mt-3"><Button onClick={doCheckOut} disabled={busy} loading={busy}>Check out</Button></div>
            </div>
          ) : (
            <div className="space-y-3">
              <Button onClick={() => locate()} disabled={busy} loading={busy}>Use my location</Button>
              {pos && <p className="text-xs text-emerald-600">Location: {pos.lat.toFixed(5)}, {pos.lon.toFixed(5)}</p>}
              {geoMsg && <p className="text-xs text-slate-500">{geoMsg}</p>}
              <Field label="Note (what you're doing)"><Input value={note} onChange={setNote} placeholder="e.g. boundary survey, Lot 14182" /></Field>
              <Field label="Contact (phone / email)"><Input value={contact} onChange={setContact} placeholder="+267 … or you@firm.co.bw" /></Field>
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} /> Share my contact with other surveyors
              </label>
              <Button onClick={doCheckIn} disabled={busy || !pos}>Check in here</Button>
              {!pos && <p className="text-xs text-slate-400">Get your location first to check in.</p>}
            </div>
          )}
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </Card>

        <Card title="Active Surveyors">
          <p className="mb-2 text-xs text-slate-400">{others.length} other surveyor(s) checked in{pos ? " · sorted by distance" : ""}.</p>
          <div className="max-h-[360px] space-y-2 overflow-y-auto">
            {sortByDistance(others, pos).map((c) => (
              <div key={c.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-slate-800">{c.surveyor_name ?? "Surveyor"}</span>
                  {pos && <span className="text-xs font-medium text-brand-dark">{fmtKm(haversineKm(pos.lat, pos.lon, c.lat, c.lon))}</span>}
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-2">
                  <span className="text-sm text-slate-600">{c.project_name ?? "—"}</span>
                  <Badge kind="check">{timeAgo(c.created_at)}</Badge>
                </div>
                {c.note && <p className="mt-1 text-sm text-slate-500">{c.note}</p>}
                {c.share_contact && c.contact && <ContactLink contact={c.contact} />}
              </div>
            ))}
            {others.length === 0 && <p className="text-sm text-slate-400">No other surveyors are checked in right now.</p>}
          </div>
        </Card>
      </div>

      {/* Map */}
      <Card title="Active Surveyors — Map">
        <PresenceMap checkins={checkins} me={pos} myId={user.id} />
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
          <span className="flex items-center gap-1"><Dot c="#059669" /> you (checked in)</span>
          <span className="flex items-center gap-1"><Dot c="#0f172a" /> other surveyor</span>
          <span className="flex items-center gap-1"><Dot c="#2563eb" /> your location</span>
          <span className="ml-auto">Privacy: contact is shown only if a surveyor chose to share it.</span>
        </div>
      </Card>
    </div>
  );
}

function ContactLink({ contact }: { contact: string }) {
  const isEmail = contact.includes("@");
  const href = isEmail ? `mailto:${contact}` : `tel:${contact.replace(/\s+/g, "")}`;
  return (
    <a href={href} className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-brand-dark underline">
      {isEmail ? "Email" : "Phone"}: {contact}
    </a>
  );
}

function PresenceMap({ checkins, me, myId }: { checkins: CheckIn[]; me: { lat: number; lon: number } | null; myId: string }) {
  const W = 760, H = 460, pad = 40;
  const pts = [...checkins.map((c) => ({ lat: c.lat, lon: c.lon })), ...(me ? [me] : [])];
  if (pts.length === 0) {
    return <div className="grid h-48 place-items-center rounded-lg bg-slate-50 text-sm text-slate-400">No active check-ins to map.</div>;
  }
  const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const k = Math.cos((lat0 * Math.PI) / 180) || 1;
  const px = (lon: number) => lon * k;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, px(p.lon)); maxX = Math.max(maxX, px(p.lon)); minY = Math.min(minY, p.lat); maxY = Math.max(maxY, p.lat); }
  const spanX = Math.max(maxX - minX, 1e-6), spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const offX = (W - spanX * scale) / 2, offY = (H - spanY * scale) / 2;
  const toX = (lon: number) => offX + (px(lon) - minX) * scale;
  const toY = (lat: number) => offY + (maxY - lat) * scale;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} xmlns="http://www.w3.org/2000/svg" style={{ width: "100%", height: "auto", background: "#f8fafc", borderRadius: 12 }}>
      {checkins.map((c) => {
        const isMe = c.surveyor === myId;
        return (
          <g key={c.id}>
            <circle cx={toX(c.lon)} cy={toY(c.lat)} r={isMe ? 7 : 5} fill={isMe ? "#059669" : "#0f172a"} stroke="white" strokeWidth={1.5} />
            <text x={toX(c.lon) + 8} y={toY(c.lat) + 3} fontSize={10} fill="#334155">{c.surveyor_name ?? "Surveyor"}</text>
          </g>
        );
      })}
      {me && (
        <g>
          <circle cx={toX(me.lon)} cy={toY(me.lat)} r={6} fill="#2563eb" stroke="white" strokeWidth={2} />
          <circle cx={toX(me.lon)} cy={toY(me.lat)} r={12} fill="none" stroke="#2563eb" strokeWidth={1.2} opacity={0.5} />
        </g>
      )}
    </svg>
  );
}

function sortByDistance(list: CheckIn[], me: { lat: number; lon: number } | null): CheckIn[] {
  if (!me) return list;
  return [...list].sort((a, b) => haversineKm(me.lat, me.lon, a.lat, a.lon) - haversineKm(me.lat, me.lon, b.lat, b.lon));
}
function fmtKm(km: number): string { return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`; }
function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
function Dot({ c }: { c: string }) { return <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c }} />; }
function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-3"><span className="text-slate-500">{label}</span><span className="font-medium text-slate-800">{value}</span></div>;
}
