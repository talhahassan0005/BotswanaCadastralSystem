/**
 * Botswana survey reference-mark database (Module: GIS / Reference Marks).
 *
 * The marks live in the Supabase `ref_marks` table (loaded via fetchRefMarks).
 * The REF_MARKS array below is the SEED used as a fallback when the backend is
 * not configured or the table is empty — and is what `Publish seed` uploads.
 * Replace/extend the table with the official Department of Surveys & Mapping
 * (DSM) export; the UI is fully data-driven.
 */

import { supabase } from "./supabaseClient";
import { REF_MARKS_DATA } from "./refMarksData";

export interface RefMark {
  id: string;
  number: string; // official mark number / designation
  name: string; // place / locality
  type: "Trigonometrical beacon" | "Town survey mark" | "Reference mark";
  lat: number; // WGS84
  lon: number; // WGS84
  description: string;
  status: "In good order" | "Witness mark" | "Reported destroyed" | "Not visited";
  region: string;
}

// Hand fallback (approximate town positions) — used only if the generated
// client dataset is empty. The real seed is REF_MARKS_DATA (CONTROL POINTS).
const SEED_FALLBACK: RefMark[] = [
  { id: "1", number: "T 24/101", name: "Gaborone", type: "Trigonometrical beacon", lat: -24.6282, lon: 25.9231, description: "Concrete pillar, brass bolt", status: "In good order", region: "South-East" },
  { id: "2", number: "T 25/044", name: "Lobatse", type: "Trigonometrical beacon", lat: -25.2210, lon: 25.6770, description: "Concrete beacon on hill", status: "In good order", region: "South-East" },
  { id: "3", number: "T 24/318", name: "Molepolole", type: "Town survey mark", lat: -24.4067, lon: 25.4951, description: "Standard iron peg in kerb", status: "In good order", region: "Kweneng" },
  { id: "4", number: "T 24/206", name: "Kanye", type: "Trigonometrical beacon", lat: -24.9833, lon: 25.3500, description: "Pillar with vane", status: "Witness mark", region: "Southern" },
  { id: "5", number: "T 24/512", name: "Jwaneng", type: "Reference mark", lat: -24.6017, lon: 24.7280, description: "Brass plate in concrete", status: "In good order", region: "Southern" },
  { id: "6", number: "T 23/077", name: "Mahalapye", type: "Trigonometrical beacon", lat: -23.1041, lon: 26.8142, description: "Concrete beacon", status: "Reported destroyed", region: "Central" },
  { id: "7", number: "T 22/133", name: "Palapye", type: "Town survey mark", lat: -22.5500, lon: 27.1250, description: "Iron peg, 12mm", status: "In good order", region: "Central" },
  { id: "8", number: "T 22/061", name: "Serowe", type: "Trigonometrical beacon", lat: -22.3875, lon: 26.7108, description: "Pillar on koppie", status: "In good order", region: "Central" },
  { id: "9", number: "T 22/240", name: "Selebi-Phikwe", type: "Reference mark", lat: -21.9764, lon: 27.8478, description: "Brass bolt in slab", status: "Not visited", region: "Central" },
  { id: "10", number: "T 21/018", name: "Francistown", type: "Trigonometrical beacon", lat: -21.1702, lon: 27.5078, description: "Concrete pillar", status: "In good order", region: "North-East" },
  { id: "11", number: "T 19/004", name: "Maun", type: "Trigonometrical beacon", lat: -19.9833, lon: 23.4167, description: "Beacon near airport", status: "In good order", region: "North-West" },
  { id: "12", number: "T 17/002", name: "Kasane", type: "Reference mark", lat: -17.8000, lon: 25.1500, description: "Brass plate, riverbank", status: "Witness mark", region: "Chobe" },
  { id: "13", number: "T 21/090", name: "Ghanzi", type: "Trigonometrical beacon", lat: -21.7000, lon: 21.6500, description: "Concrete beacon", status: "In good order", region: "Ghanzi" },
  { id: "14", number: "T 21/142", name: "Charleshill", type: "Reference mark", lat: -21.9300, lon: 20.9800, description: "Iron peg near Lot 14182", status: "In good order", region: "Ghanzi" },
  { id: "15", number: "T 26/011", name: "Tsabong", type: "Trigonometrical beacon", lat: -26.0167, lon: 22.4000, description: "Pillar, sand dune ridge", status: "Not visited", region: "Kgalagadi" },
  { id: "16", number: "T 24/660", name: "Ramotswa", type: "Town survey mark", lat: -24.8667, lon: 25.8167, description: "Standard mark in pavement", status: "In good order", region: "South-East" },
];

/** Reference-mark seed: the client's CONTROL POINTS dataset (1481 marks across 23
 *  localities, converted to WGS84), falling back to the hand list if empty. */
export const REF_MARKS: RefMark[] = REF_MARKS_DATA.length ? REF_MARKS_DATA : SEED_FALLBACK;

const R_KM = 6371.0088;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in kilometres between two WGS84 lat/lon points. */
export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Case-insensitive search by mark number, name, region or type. */
export function searchMarks(query: string, marks: RefMark[] = REF_MARKS): RefMark[] {
  const q = query.trim().toLowerCase();
  if (!q) return marks;
  return marks.filter((m) =>
    [m.number, m.name, m.region, m.type, m.status].some((f) => f.toLowerCase().includes(q))
  );
}

/** Marks ordered by distance from (lat, lon); returns the closest `limit`. */
export function nearestMarks(
  lat: number,
  lon: number,
  limit = 10,
  marks: RefMark[] = REF_MARKS
): { mark: RefMark; km: number }[] {
  return marks
    .map((mark) => ({ mark, km: haversineKm(lat, lon, mark.lat, mark.lon) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, limit);
}

/** Google Maps directions deep-link to a mark (opens the user's Maps app). */
export function directionsUrl(lat: number, lon: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
}

// ---------------------------------------------------------------------------
// Backend (Supabase ref_marks) — with graceful fallback to the seed array.
// ---------------------------------------------------------------------------
const COLS = "id,number,name,type,lat,lon,description,status,region";

/** Load marks from the `ref_marks` table; falls back to the bundled seed when
 *  the backend isn't configured, errors, or the table is empty. */
export async function fetchRefMarks(): Promise<{ marks: RefMark[]; source: "database" | "seed" }> {
  if (!supabase) return { marks: REF_MARKS, source: "seed" };
  const { data, error } = await supabase.from("ref_marks").select(COLS).order("number");
  if (error || !data || data.length === 0) return { marks: REF_MARKS, source: "seed" };
  return { marks: data as RefMark[], source: "database" };
}

/** Upsert marks into the table (keyed on `number`). Used by Publish-seed / CSV import. */
export async function importRefMarks(marks: Omit<RefMark, "id">[]): Promise<{ count: number; error?: string }> {
  if (!supabase) return { count: 0, error: "Backend not configured." };
  const rows = marks.map((m) => ({
    number: m.number, name: m.name, type: m.type, lat: m.lat, lon: m.lon,
    description: m.description, status: m.status, region: m.region,
  }));
  const { data, error } = await supabase.from("ref_marks").upsert(rows, { onConflict: "number" }).select("id");
  return { count: data?.length ?? 0, error: error?.message };
}

/** Parse a CSV of marks: number,name,type,lat,lon,description,status,region (header optional). */
export function parseRefMarkCsv(text: string): Omit<RefMark, "id">[] {
  const out: Omit<RefMark, "id">[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const c = line.split(",").map((s) => s.trim());
    if (c.length < 5) continue;
    const lat = Number(c[3]);
    const lon = Number(c[4]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue; // skips header row too
    out.push({
      number: c[0], name: c[1] ?? "", type: (c[2] || "Reference mark") as RefMark["type"],
      lat, lon, description: c[5] ?? "", status: (c[6] || "In good order") as RefMark["status"], region: c[7] ?? "",
    });
  }
  return out;
}
