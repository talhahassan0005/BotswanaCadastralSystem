/* Generate apps/web/lib/refMarksData.ts from the client's CONTROL POINTS files.
 * Reads .csv AND .xls/.xlsx; each village folder name carries its Lo band
 * (e.g. "GABORONE Lo25"). We detect id + Lo Y(east)/X(north) per row, convert
 * that Lo belt → WGS84, and emit one bundled RefMark[] the app loads as the
 * reference-mark seed. Run: npx tsx scripts/genRefMarks.ts
 *
 * Column detection is layout-tolerant (the client's files vary wildly): if a
 * header row is present we map by name (Y_coord_LO / X_coord_LO / easting /
 * northing); otherwise we identify the columns by MAGNITUDE — a Botswana Lo
 * northing sits ~2.0–2.95 million while the easting is far smaller — so a file
 * that lists X before Y, or carries extra UTM/height columns, still parses.
 */
import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";
import { transformPoint } from "../apps/web/lib/server/crs";

const ROOT = path.join(__dirname, "..", "CONTROL POINTS");
const OUT = path.join(__dirname, "..", "apps", "web", "lib", "refMarksData.ts");

// Some folders mislabel the coordinate origin or omit the band. Verified:
//  - FRANCISTOWN.csv data is on the Lo25/national origin (CM 25°) although the
//    folder says Lo27 → converting as Lo27 lands ~206 km too far east. Lo25
//    reproduces the true ~27.5°E position.
//  - MOGODITSHANE folder has no "LoNN" tag; it is a Gaborone-area Lo25 locality.
const BAND_OVERRIDE: Record<string, number> = { FRANCISTOWN: 25, MOGODITSHANE: 25 };

interface RefMark {
  id: string; number: string; name: string; type: string;
  lat: number; lon: number; description: string; status: string; region: string;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && !e.name.startsWith("~$") && /\.(csv|xls|xlsx)$/i.test(e.name)) out.push(p);
  }
  return out;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = String(v).trim().replace(/\s+/g, "");
  if (t === "") return null;
  const n = Number(t.includes(",") && !t.includes(".") ? t.replace(",", ".") : t.replace(/(?<=\d),(?=\d{3}\b)/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Read any supported file into rows of raw cell values. */
function readRows(file: string): unknown[][] {
  if (/\.csv$/i.test(file)) {
    return fs.readFileSync(file, "latin1").split(/\r?\n/).map((l) => l.split(","));
  }
  const wb = XLSX.readFile(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, raw: true }) as unknown[][];
}

const LO_NORTH = (n: number) => n >= 2.0e6 && n <= 2.95e6; // Botswana Lo X (northing)
const LO_EAST = (n: number) => Math.abs(n) >= 1000 && Math.abs(n) <= 5.0e5; // Lo Y (easting/westing)

/** Map a header row to {id, east, north} column indices, or null if not a header. */
function headerMap(cells: unknown[]): { id: number; east: number; north: number } | null {
  const lc = cells.map((c) => String(c ?? "").trim().toLowerCase());
  const anyNumeric = lc.some((c) => num(c) != null && c !== "");
  const textCount = lc.filter((c) => c && num(c) == null).length;
  if (anyNumeric || textCount < 2) return null; // a data row, not a header
  const find = (re: RegExp) => lc.findIndex((c) => re.test(c));
  const east = find(/^y(_coord)?(_lo)?$|easting|^e$|y_lo/);
  const north = find(/^x(_coord)?(_lo)?$|northing|^n$|x_lo/);
  let id = find(/oldid|^mark$|beacon|station|^id$|number|^name$|point/);
  if (id < 0) id = 0;
  return east >= 0 && north >= 0 ? { id, east, north } : null;
}

/** Pull {id, east, north} from a data row, by header map if given else by magnitude. */
function extractRow(
  cells: unknown[],
  hm: { id: number; east: number; north: number } | null
): { id: string; east: number; north: number } | null {
  if (hm) {
    const id = String(cells[hm.id] ?? "").trim();
    const east = num(cells[hm.east]);
    const north = num(cells[hm.north]);
    return id && east != null && north != null ? { id, east, north } : null;
  }
  const id = String(cells[0] ?? "").trim();
  if (!id) return null;
  let north: number | null = null;
  let east: number | null = null;
  for (let i = 1; i < cells.length; i++) {
    const n = num(cells[i]);
    if (n == null) continue;
    if (north == null && LO_NORTH(n)) north = n;
    else if (east == null && LO_EAST(n)) east = n;
    if (north != null && east != null) break;
  }
  return east != null && north != null ? { id, east, north } : null;
}

const marks: RefMark[] = [];
const seen = new Set<string>();
const perLocality: Record<string, { n: number; latSum: number; lonSum: number }> = {};
let files = 0, skippedNoBand = 0, skippedMixed = 0, rowsBad = 0;

for (const file of walk(ROOT)) {
  const isRoot = path.dirname(file) === ROOT;
  const folder = path.basename(path.dirname(file));
  const fname = path.basename(file, path.extname(file));
  // Village from the folder name; for files in the CONTROL POINTS root use the
  // file name instead (e.g. "KUMAKWANE Lo25.xls" -> KUMAKWANE).
  const nameSrc = isRoot ? fname : folder;
  const village = nameSrc.replace(/Lo\s*\d{2}.*$/i, "").replace(/[_]+/g, " ").trim() || fname.replace(/Lo\s*\d{2}.*$/i, "").trim() || folder;
  const bandMatch = (folder + " " + fname).match(/Lo\s*(\d{2})/i);
  const band = BAND_OVERRIDE[village.toUpperCase()] ?? (bandMatch ? Number(bandMatch[1]) : null);
  if (!band) { skippedNoBand++; continue; }

  let rows: unknown[][];
  try { rows = readRows(file); } catch { rowsBad++; continue; }

  // Skip mixed-band scratch/check files: if the sheet explicitly names more than
  // one Lo belt in its cells (e.g. both "LO 25" and "LO 27"), it is not a clean
  // single-locality list and would pollute the dataset — drop the whole file.
  const bandsMentioned = new Set<number>();
  for (const r of rows) for (const c of r) {
    const m = String(c ?? "").match(/\bLO\s*(\d{2})\b/i);
    if (m) bandsMentioned.add(Number(m[1]));
  }
  if (bandsMentioned.size > 1) { skippedMixed++; continue; }
  files++;

  // Detect a header row (first non-empty row that is all text with >=2 labels).
  let hm: { id: number; east: number; north: number } | null = null;
  for (const r of rows.slice(0, 3)) { hm = headerMap(r); if (hm) break; }

  for (const cells of rows) {
    const row = extractRow(cells, hm);
    if (!row) { rowsBad++; continue; }
    let lat: number, lon: number;
    try {
      [lat, lon] = transformPoint(row.east, row.north, `Lo${band}`, "WGS84");
    } catch { rowsBad++; continue; }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { rowsBad++; continue; }
    // Botswana sanity window (lat ~ -27..-17, lon ~ 20..29.5).
    if (lat > -16 || lat < -28 || lon < 19.5 || lon > 29.6) { rowsBad++; continue; }
    const key = `${village}|${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    marks.push({
      id: key.replace(/[^A-Za-z0-9]/g, "_"),
      number: row.id,
      name: village,
      type: "Reference mark",
      lat: Math.round(lat * 1e6) / 1e6,
      lon: Math.round(lon * 1e6) / 1e6,
      description: `Lo${band}`,
      status: "In good order",
      region: village,
    });
    const pl = (perLocality[village] ??= { n: 0, latSum: 0, lonSum: 0 });
    pl.n++; pl.latSum += lat; pl.lonSum += lon;
  }
}

const header = `// AUTO-GENERATED from CONTROL POINTS by scripts/genRefMarks.ts — do not edit by hand.\n` +
  `// ${marks.length} reference marks across ${new Set(marks.map((m) => m.name)).size} localities (converted to WGS84).\n` +
  `import type { RefMark } from "./refmarks";\n\n` +
  `export const REF_MARKS_DATA: RefMark[] = `;
fs.writeFileSync(OUT, header + JSON.stringify(marks, null, 0) + ";\n", "utf8");

console.log(`files=${files} skippedNoBand=${skippedNoBand} skippedMixed=${skippedMixed} badRows=${rowsBad}`);
console.log(`MARKS=${marks.length} localities=${new Set(marks.map((m) => m.name)).size}`);
console.log("per-locality centroid (verify each lands in the right town):");
for (const [v, p] of Object.entries(perLocality).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${v.padEnd(18)} n=${String(p.n).padStart(4)}  lat=${(p.latSum / p.n).toFixed(3)} lon=${(p.lonSum / p.n).toFixed(3)}`);
}
