/**
 * Generates apps/web/lib/refMarksExtra.ts from a surveyor-supplied CSV of
 * reference marks (client req 2026-11-16: "Add this ref marks to the list.
 * I have marked their village names").
 *
 * Input columns: NAME, Y, X, VILLAGE — Y/X on a Botswana Lo belt, which the
 * file does not state. SOURCE_BELT below is that belt; change it and re-run
 * if a later file is on a different one. It is recorded on every mark so the
 * sheet can show where the figure came from, the same way the DSM seed does.
 *
 *   npx tsx scripts/genRefMarksFromCsv.ts "public/Ref Marks1.csv"
 */
import { readFileSync, writeFileSync } from "node:fs";
import { transformPoint } from "../apps/web/lib/server/crs";

const SOURCE_BELT = "Lo27";
const OUT = "apps/web/lib/refMarksExtra.ts";

const file = process.argv[2];
if (!file) { console.error("usage: genRefMarksFromCsv.ts <csv>"); process.exit(1); }

const lines = readFileSync(file, "utf8").trim().split(/\r?\n/).filter((l) => l.trim());
const head = lines[0].split(",").map((h) => h.trim().toUpperCase());
const col = (n: string) => head.indexOf(n);
const [iN, iY, iX, iV] = [col("NAME"), col("Y"), col("X"), col("VILLAGE")];
if (iN < 0 || iY < 0 || iX < 0) { console.error(`need NAME,Y,X columns; got ${head.join(",")}`); process.exit(1); }

type Out = { id: string; number: string; name: string; type: string; lat: number; lon: number; description: string; status: string; region: string };
const out: Out[] = [];
const skipped: string[] = [];
for (const line of lines.slice(1)) {
  const c = line.split(",").map((s) => s.trim());
  const number = c[iN], y = Number(c[iY]), x = Number(c[iX]);
  const village = iV >= 0 ? c[iV] : "";
  if (!number || !isFinite(y) || !isFinite(x)) { skipped.push(line); continue; }
  const [lat, lon] = transformPoint(y, x, SOURCE_BELT, "WGS84");
  if (!isFinite(lat) || !isFinite(lon)) { skipped.push(line); continue; }
  out.push({
    id: `${(village || "MARK").toUpperCase().replace(/\s+/g, "_")}_${number}`,
    number, name: village || number, type: "Reference mark",
    lat: +lat.toFixed(8), lon: +lon.toFixed(8),
    description: SOURCE_BELT, status: "In good order", region: village || "",
  });
}

const body = out.map((m) => "  " + JSON.stringify(m) + ",").join("\n");
writeFileSync(OUT,
`// AUTO-GENERATED from ${file.split(String.fromCharCode(92)).join("/")} by scripts/genRefMarksFromCsv.ts — do not edit by hand.
// ${out.length} reference marks across ${new Set(out.map((m) => m.name)).size} villages,
// converted from ${SOURCE_BELT} to WGS84.
import type { RefMark } from "./refmarks";

export const REF_MARKS_EXTRA: RefMark[] = [
${body}
];
`);
console.log(`wrote ${OUT}: ${out.length} marks, ${new Set(out.map((m) => m.name)).size} villages, ${skipped.length} skipped`);
for (const s of skipped) console.log("  skipped:", s);
