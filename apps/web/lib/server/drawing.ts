/**
 * Turn a parsed CAD drawing (DXF / Shapefile) into the same ParseResult shape
 * the CSV importer produces, so a surveyor can load a *parent diagram* drawing
 * straight into the Data Import preview and carry its beacon coordinates into
 * COGO / Parcels (the subdivision-from-parent-diagram workflow).
 *
 * Coordinate source priority (a cadastral drawing usually has one of these):
 *   1. POINT entities                          -> each is a beacon
 *   2. the largest closed boundary polyline    -> its vertices are the beacons
 *   3. any text labels                          -> their positions (control marks)
 *
 * Beacon names are taken from the nearest text label when one sits on the
 * vertex; otherwise a neutral P1, P2 … is used. The user is asked to verify the
 * names/order in the preview before proceeding (a drawing has no inherent
 * beacon order or bearings/distances).
 */

import type { ImportedDrawing } from "@/lib/dxf";
import type { ParseResult, ParsedRow } from "./csv";

interface XY {
  x: number;
  y: number;
}

function bbox(pts: XY[]) {
  let minx = Infinity,
    miny = Infinity,
    maxx = -Infinity,
    maxy = -Infinity;
  for (const p of pts) {
    minx = Math.min(minx, p.x);
    miny = Math.min(miny, p.y);
    maxx = Math.max(maxx, p.x);
    maxy = Math.max(maxy, p.y);
  }
  return { w: maxx - minx, h: maxy - miny };
}

/** Drop points that coincide with an earlier one (e.g. a closed ring repeats
 *  its first vertex at the end). */
function dedup(pts: XY[], tol: number): XY[] {
  const out: XY[] = [];
  for (const p of pts) {
    if (!out.some((q) => Math.hypot(q.x - p.x, q.y - p.y) <= tol)) out.push(p);
  }
  return out;
}

export function drawingToParseResult(d: ImportedDrawing): ParseResult {
  const texts = d.texts.filter((t) => t.text && t.text.trim());

  let coords: XY[] = [];
  let sourceLabel = "";
  if (d.points.length) {
    coords = d.points.map((p) => ({ x: p.x, y: p.y }));
    sourceLabel = `${d.points.length} survey point${d.points.length === 1 ? "" : "s"}`;
  } else if (d.polylines.length) {
    const closed = d.polylines.filter((pl) => pl.closed);
    const pool = closed.length ? closed : d.polylines;
    const chosen = pool.reduce((a, b) => {
      const ba = bbox(a.pts);
      const bb = bbox(b.pts);
      return bb.w * bb.h > ba.w * ba.h ? b : a;
    });
    coords = chosen.pts.map((p) => ({ x: p.x, y: p.y }));
    sourceLabel = `the ${chosen.closed ? "closed " : ""}boundary polyline (${coords.length} vertices)`;
  } else if (texts.length) {
    coords = texts.map((t) => ({ x: t.x, y: t.y }));
    sourceLabel = `${texts.length} labelled position${texts.length === 1 ? "" : "s"}`;
  }

  coords = dedup(coords, 1e-6);

  if (coords.length === 0) {
    return {
      rows: [],
      validCount: 0,
      warningCount: 0,
      errorCount: 0,
      detectedColumns: ["(drawing)"],
      notice:
        "No coordinates could be read from this drawing — it has no points, boundary polyline, or text with usable coordinates. " +
        "If it is a full CAD drawing you only want to view/edit, open it in the Editor tab instead.",
    };
  }

  const ext = bbox(coords);
  const span = Math.max(ext.w, ext.h, 1);
  const thresh = span * 0.03 + 1; // a label must sit within ~3% of the extent of a vertex to name it

  const labelAt = (p: XY): string | null => {
    let best: { text: string; dist: number } | null = null;
    for (const t of texts) {
      const dd = Math.hypot(t.x - p.x, t.y - p.y);
      if (!best || dd < best.dist) best = { text: t.text.trim(), dist: dd };
    }
    return best && best.dist <= thresh ? best.text : null;
  };

  const seen = new Set<string>();
  const rows: ParsedRow[] = [];
  coords.forEach((p, i) => {
    let label = labelAt(p) ?? `P${i + 1}`;
    if (seen.has(label)) {
      let k = 2;
      while (seen.has(`${label}-${k}`)) k++;
      label = `${label}-${k}`;
    }
    seen.add(label);
    rows.push({
      index: i + 1,
      beaconId: label,
      east: p.x,
      north: p.y,
      bearing: null,
      distance: null,
      status: "valid", // coordinates are present, so the row is usable
      issues: [],
    });
  });

  return {
    rows,
    validCount: rows.length,
    warningCount: 0,
    errorCount: 0,
    detectedColumns: ["Beacon (from labels)", "East", "North"],
    notice:
      `Read ${rows.length} coordinate${rows.length === 1 ? "" : "s"} from ${sourceLabel}. ` +
      "Beacon names came from nearby text labels where available — please check the names and the boundary order before computing. " +
      "A drawing carries no bearings/distances, so those columns are blank (coordinates are enough for COGO and Parcels).",
  };
}
