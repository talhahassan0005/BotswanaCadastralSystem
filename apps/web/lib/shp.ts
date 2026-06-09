/**
 * Minimal, dependency-free ESRI Shapefile (.shp) geometry reader for the
 * drafting editor. Reads Point, MultiPoint, PolyLine and Polygon shapes
 * (the cadastral cases); ignores Z/M values and the .dbf attribute file.
 *
 * Shapefile spec quirk: the main/record headers are big-endian, the geometry
 * is little-endian.
 */

import type { ImportedDrawing } from "./dxf";

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
