/**
 * Minimal, dependency-free ESRI Shapefile (.shp + .dbf) reader.
 * Reads Point, MultiPoint, PolyLine and Polygon shapes (the cadastral cases);
 * ignores Z/M values.
 *
 * Shapefile spec quirk: the main/record headers are big-endian, the geometry
 * is little-endian.
 */

import type { ImportedDrawing } from "./dxf";
import type { ImportResult, ParsedRow } from "./types";

// ---------------------------------------------------------------------------
// DBF reader (dBASE III+)
// ---------------------------------------------------------------------------
export function parseDbf(buf: ArrayBuffer): Record<string, string>[] {
  const dv = new DataView(buf);
  if (dv.byteLength < 32) return [];
  const numRecords = dv.getInt32(4, true);
  const headerBytes = dv.getInt16(8, true);
  const recordBytes = dv.getInt16(10, true);

  // Parse field descriptors (32 bytes each, starting at byte 32, terminated by 0x0D)
  const fields: { name: string; type: string; length: number }[] = [];
  let off = 32;
  while (off + 32 <= headerBytes) {
    if (dv.getUint8(off) === 0x0d) break;
    const nameBytes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const b = dv.getUint8(off + i);
      if (b !== 0) nameBytes.push(b);
    }
    const name = String.fromCharCode(...nameBytes);
    const type = String.fromCharCode(dv.getUint8(off + 11));
    const length = dv.getUint8(off + 16);
    fields.push({ name, type, length });
    off += 32;
  }

  const dec = new TextDecoder("latin1");
  const records: Record<string, string>[] = [];
  let recOff = headerBytes;
  for (let i = 0; i < numRecords; i++) {
    if (recOff + recordBytes > dv.byteLength) break;
    if (dv.getUint8(recOff) === 0x2a) { recOff += recordBytes; continue; } // deleted
    const rec: Record<string, string> = {};
    let fOff = recOff + 1; // skip deletion flag
    for (const f of fields) {
      rec[f.name] = dec.decode(new Uint8Array(buf, fOff, f.length)).trim();
      fOff += f.length;
    }
    records.push(rec);
    recOff += recordBytes;
  }
  return records;
}

// ---------------------------------------------------------------------------
// Cadastral SHP+DBF → ImportResult
// C file: points with NAME/Y/X/TYPE/SRNUMBER/DESCRIPTIO
// L file: lines with FROM_ID/TO_ID/DIRECTION/DISTANCE → bearing+distance rows
// P file: polygons with ERF/AREA → one summary row per lot
// ---------------------------------------------------------------------------
export function parseCadastralShp(
  cShp: ArrayBuffer, cDbf: ArrayBuffer,
  pDbf?: ArrayBuffer,
  lDbf?: ArrayBuffer,
): ImportResult {
  const rows: ParsedRow[] = [];

  // --- C file: beacons — use DBF Y/X fields (more precise than SHP geometry) ---
  const cAttrs = parseDbf(cDbf);
  let cCount = 0;
  for (const attr of cAttrs) {
    const name = attr["NAME"] || attr["BEACON"] || attr["ID"] || String(cCount + 1);
    // DBF Y = Easting, X = Northing (Botswana cadastral convention)
    const east  = parseFloat(attr["Y"] ?? "");
    const north = parseFloat(attr["X"] ?? "");
    const btype = attr["TYPE"]?.toLowerCase();
    const pointType =
      btype?.includes("block") || btype?.includes("corner") ? "beacon" as const :
      btype?.includes("trig")  ? "trig"   as const :
      btype?.includes("ref")   ? "ref"    as const : "beacon" as const;
    rows.push({
      index: rows.length + 1,
      beaconId: name,
      east:  Number.isFinite(east)  ? east  : null,
      north: Number.isFinite(north) ? north : null,
      bearing: null,
      distance: null,
      status: "valid",
      issues: [],
      pointType,
      srNo:        attr["SRNUMBER"]   || undefined,
      description: attr["DESCRIPTIO"] || undefined,
    });
    cCount++;
  }

  // --- L file: survey legs → bearing + distance rows (no coordinates yet) ---
  let lCount = 0;
  if (lDbf) {
    const lAttrs = parseDbf(lDbf);
    for (const attr of lAttrs) {
      const fromId = attr["FROM_ID"] || "";
      const toId   = attr["TO_ID"]   || "";
      const dir    = parseFloat(attr["DIRECTION"] ?? ""); // decimal degrees
      const dist   = parseFloat(attr["DISTANCE"]  ?? "");
      if (!Number.isFinite(dir) || !Number.isFinite(dist)) continue;
      // Convert decimal degrees → DMS string (e.g. "303.4310" → "303.43.10")
      const bearing = decDegToDms(dir);
      rows.push({
        index: rows.length + 1,
        beaconId: fromId || `L${lCount + 1}`,
        east: null,
        north: null,
        bearing,
        distance: Number.isFinite(dist) ? dist : null,
        status: "check",
        issues: [`leg ${fromId}→${toId}: coordinates not yet computed`],
        pointType: "wp" as const,
      });
      lCount++;
    }
  }

  // --- P file: one summary row per lot polygon ---
  let pCount = 0;
  if (pDbf) {
    const pAttrs = parseDbf(pDbf);
    for (const attr of pAttrs) {
      const erfNo = attr["ERF"] || attr["LOT"] || attr["PARCEL"] || String(pCount + 1);
      const area  = parseFloat(attr["AREA"] ?? "");
      rows.push({
        index: rows.length + 1,
        beaconId: `ERF ${erfNo}`,
        east: null,
        north: null,
        bearing: null,
        distance: Number.isFinite(area) ? area : null, // area stored in distance slot for display
        status: "check",
        issues: [`lot polygon — area ${Number.isFinite(area) ? area.toFixed(1) : "?"} m²`],
        pointType: "ref" as const,
      });
      pCount++;
    }
  }

  const validCount   = rows.filter((r) => r.status === "valid").length;
  const warningCount = rows.filter((r) => r.status === "check").length;
  const parts: string[] = [];
  if (cCount) parts.push(`${cCount} beacons`);
  if (lCount) parts.push(`${lCount} legs`);
  if (pCount) parts.push(`${pCount} lots`);

  return {
    filename: "cadastral.shp",
    rows,
    validCount,
    warningCount,
    errorCount: 0,
    detectedColumns: ["beaconId", "east", "north", "bearing", "distance"],
    notice: `Loaded ${parts.join(" + ")} from cadastral shapefiles.`,
  };
}

/** Convert decimal-degree bearing (e.g. 303.4310) to DMS string "303.43.10" */
function decDegToDms(dd: number): string {
  const d = Math.floor(dd);
  const mFrac = (dd - d) * 100;
  const m = Math.floor(mFrac);
  const s = Math.round((mFrac - m) * 100);
  return `${d}.${String(m).padStart(2, "0")}.${String(s).padStart(2, "0")}`;
}

export function parseShp(buf: ArrayBuffer): ImportedDrawing {
  const out: ImportedDrawing = { points: [], polylines: [], texts: [] };
  const dv = new DataView(buf);
  if (dv.byteLength < 100) return out;

  // File length is given in 16-bit words (big-endian) at byte 24.
  const fileLenBytes = Math.min(dv.getInt32(24, false) * 2, dv.byteLength);

  let off = 100; // records start after the 100-byte header
  while (off + 8 <= fileLenBytes) {
    const contentBytes = dv.getInt32(off + 4, false) * 2; // big-endian, words
    const shapeType = dv.getInt32(off + 8, true); // little-endian
    const p = off + 12; // start of shape geometry

    if (shapeType === 1) {
      // Point
      out.points.push({ x: dv.getFloat64(p, true), y: dv.getFloat64(p + 8, true) });
    } else if (shapeType === 8) {
      // MultiPoint: box(32) + numPoints(4) + points
      const numPoints = dv.getInt32(p + 32, true);
      let q = p + 36;
      for (let i = 0; i < numPoints; i++) {
        out.points.push({ x: dv.getFloat64(q, true), y: dv.getFloat64(q + 8, true) });
        q += 16;
      }
    } else if (shapeType === 3 || shapeType === 5) {
      // PolyLine(3) / Polygon(5): box(32) + numParts(4) + numPoints(4) + parts[] + points[]
      const numParts = dv.getInt32(p + 32, true);
      const numPoints = dv.getInt32(p + 36, true);
      let q = p + 40;
      const parts: number[] = [];
      for (let i = 0; i < numParts; i++) {
        parts.push(dv.getInt32(q, true));
        q += 4;
      }
      const coords: { x: number; y: number }[] = [];
      for (let i = 0; i < numPoints; i++) {
        coords.push({ x: dv.getFloat64(q, true), y: dv.getFloat64(q + 8, true) });
        q += 16;
      }
      for (let i = 0; i < numParts; i++) {
        const s = parts[i];
        const e = i + 1 < numParts ? parts[i + 1] : numPoints;
        const pts = coords.slice(s, e);
        if (pts.length >= 2) out.polylines.push({ pts, closed: shapeType === 5 });
      }
    }
    // shapeType 0 (Null) and unsupported types: skip via the length below.

    off += 8 + contentBytes;
  }
  return out;
}
