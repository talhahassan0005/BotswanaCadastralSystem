/**
 * ESRI Shapefile WRITER — .shp (geometry) + .shx (index) + .dbf (attribute
 * table), one closed-ring Polygon feature per lot/plot (client req
 * 2026-09-24). The counterpart to parseShp's reader in shp.ts, same binary
 * conventions verified against that file: main/record headers big-endian,
 * geometry little-endian, shape type 5 = Polygon.
 *
 * Spec reference (ESRI Shapefile Technical Description, July 1998):
 *  - .shp: 100-byte file header, then one record per feature — an 8-byte
 *    big-endian record header (record number, content length in 16-bit
 *    words) followed by little-endian shape content.
 *  - .shx: the same 100-byte file header, then one 8-byte big-endian
 *    (offset, content length) pair per feature, both in 16-bit words —
 *    the offset is into the .shp file, at the start of that record's own
 *    8-byte record header.
 *  - .dbf: dBase III — a 32-byte file header, one 32-byte field descriptor
 *    per attribute, a 0x0D terminator, then one record per feature (a
 *    leading not-deleted flag byte + each field's value padded/aligned to
 *    its declared width), ending in a 0x1A end-of-file marker.
 */

export interface ShpFeature {
  /** Lot/plot number — becomes the .dbf "LOT_NUMBER" attribute. */
  number: string;
  /** Ring vertices, NOT closed (first point != last) — same shape
   *  gpPlots/dropClosingDuplicate already hand around this codebase; the
   *  closing vertex is added here, once, at write time. */
  points: { east: number; north: number }[];
  /** .dbf "AREA_M2" attribute — pass the SAME value already shown in the
   *  General Plan's own LOT AREAS table (p.fig.area_m2), not a separately
   *  recomputed one, so the export never disagrees with what's on the
   *  printed sheet. */
  areaM2: number;
}

const SHP_FILE_CODE = 9994;
const SHP_VERSION = 1000;
const SHAPE_TYPE_POLYGON = 5;

/** Ring points in Shapefile's required winding (outer rings clockwise, in
 *  an X-east/Y-north plane) — reverses the input only when the shoelace
 *  sum says it's currently counter-clockwise, so this works regardless of
 *  whatever winding the lot happened to be drawn/stored in. */
function toClockwise(points: { east: number; north: number }[]): { east: number; north: number }[] {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    sum += (b.east - a.east) * (b.north + a.north);
  }
  // sum > 0 here already indicates clockwise for this "sum of edge dx *
  // avg dy" form (the standard shoelace-via-trapezoids test), so a
  // NEGATIVE sum is the counter-clockwise case that needs reversing.
  return sum < 0 ? [...points].reverse() : points;
}

function buildShpAndShx(features: ShpFeature[]): { shp: Uint8Array; shx: Uint8Array } {
  // Pass 1: build each feature's little-endian record CONTENT (everything
  // after the 8-byte record header) so both files can be sized/written in
  // one pass over the results.
  const contents: Uint8Array[] = features.map((f) => {
    const ring = toClockwise(f.points);
    const closed = [...ring, ring[0]]; // Shapefile rings must close on themselves
    const n = closed.length;
    const buf = new ArrayBuffer(48 + n * 16); // type(4)+box(32)+numParts(4)+numPoints(4)+parts[1](4) + points
    const dv = new DataView(buf);
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for (const p of closed) {
      if (p.east < xmin) xmin = p.east;
      if (p.east > xmax) xmax = p.east;
      if (p.north < ymin) ymin = p.north;
      if (p.north > ymax) ymax = p.north;
    }
    dv.setInt32(0, SHAPE_TYPE_POLYGON, true);
    dv.setFloat64(4, xmin, true);
    dv.setFloat64(12, ymin, true);
    dv.setFloat64(20, xmax, true);
    dv.setFloat64(28, ymax, true);
    dv.setInt32(36, 1, true); // numParts — one ring per feature
    dv.setInt32(40, n, true); // numPoints
    dv.setInt32(44, 0, true); // parts[0] — the single ring starts at point 0
    let off = 48;
    for (const p of closed) {
      dv.setFloat64(off, p.east, true);
      dv.setFloat64(off + 8, p.north, true);
      off += 16;
    }
    return new Uint8Array(buf);
  });

  // Overall bounding box across every feature, for the two file headers.
  let bxmin = Infinity, bymin = Infinity, bxmax = -Infinity, bymax = -Infinity;
  for (const f of features) {
    for (const p of f.points) {
      if (p.east < bxmin) bxmin = p.east;
      if (p.east > bxmax) bxmax = p.east;
      if (p.north < bymin) bymin = p.north;
      if (p.north > bymax) bymax = p.north;
    }
  }
  if (!features.length) bxmin = bymin = bxmax = bymax = 0;

  const shpRecordsBytes = contents.reduce((s, c) => s + 8 + c.length, 0);
  const shpTotalBytes = 100 + shpRecordsBytes;
  const shxTotalBytes = 100 + features.length * 8;

  function writeHeader(dv: DataView, fileBytes: number) {
    dv.setInt32(0, SHP_FILE_CODE, false);
    for (let i = 4; i <= 20; i += 4) dv.setInt32(i, 0, false); // 5 unused ints
    dv.setInt32(24, fileBytes / 2, false); // file length in 16-bit words
    dv.setInt32(28, SHP_VERSION, true);
    dv.setInt32(32, SHAPE_TYPE_POLYGON, true);
    dv.setFloat64(36, bxmin, true);
    dv.setFloat64(44, bymin, true);
    dv.setFloat64(52, bxmax, true);
    dv.setFloat64(60, bymax, true);
    dv.setFloat64(68, 0, true); // Zmin
    dv.setFloat64(76, 0, true); // Zmax
    dv.setFloat64(84, 0, true); // Mmin
    dv.setFloat64(92, 0, true); // Mmax
  }

  const shp = new Uint8Array(shpTotalBytes);
  const shpDv = new DataView(shp.buffer);
  writeHeader(shpDv, shpTotalBytes);
  const shx = new Uint8Array(shxTotalBytes);
  const shxDv = new DataView(shx.buffer);
  writeHeader(shxDv, shxTotalBytes);

  let shpOff = 100, shxOff = 100;
  contents.forEach((content, i) => {
    shpDv.setInt32(shpOff, i + 1, false); // record number, 1-based
    shpDv.setInt32(shpOff + 4, content.length / 2, false); // content length, words
    shp.set(content, shpOff + 8);
    shxDv.setInt32(shxOff, shpOff / 2, false); // offset of this record, words
    shxDv.setInt32(shxOff + 4, content.length / 2, false);
    shpOff += 8 + content.length;
    shxOff += 8;
  });

  return { shp, shx };
}

const DBF_LOT_FIELD_LEN = 20;
const DBF_AREA_FIELD_LEN = 18;
const DBF_AREA_DECIMALS = 3;

function padField(text: string, len: number, alignRight = false): string {
  const t = text.slice(0, len);
  return alignRight ? t.padStart(len, " ") : t.padEnd(len, " ");
}

function buildDbf(features: ShpFeature[]): Uint8Array {
  const fields = [
    { name: "LOT_NUMBER", type: "C", len: DBF_LOT_FIELD_LEN, dec: 0 },
    { name: "AREA_M2", type: "N", len: DBF_AREA_FIELD_LEN, dec: DBF_AREA_DECIMALS },
  ] as const;
  const recordLen = 1 + fields.reduce((s, f) => s + f.len, 0); // +1 for the deletion flag
  const headerLen = 32 + fields.length * 32 + 1;
  const totalLen = headerLen + recordLen * features.length + 1; // +1 for the 0x1A EOF marker

  const buf = new Uint8Array(totalLen);
  const dv = new DataView(buf.buffer);
  const today = new Date();

  dv.setUint8(0, 0x03); // version: dBase III, no memo
  dv.setUint8(1, Math.max(0, today.getFullYear() - 1900));
  dv.setUint8(2, today.getMonth() + 1);
  dv.setUint8(3, today.getDate());
  dv.setUint32(4, features.length, true);
  dv.setUint16(8, headerLen, true);
  dv.setUint16(10, recordLen, true);
  // bytes 12-31 (reserved, transaction/encryption flags, LAN id) — left 0

  let off = 32;
  for (const f of fields) {
    const nameBytes = new TextEncoder().encode(f.name.slice(0, 10));
    buf.set(nameBytes, off); // remaining bytes of the 11-byte name field stay 0 (null-padded)
    dv.setUint8(off + 11, f.type.charCodeAt(0));
    dv.setUint32(off + 12, 0, true); // field data address — unused in the file itself
    dv.setUint8(off + 16, f.len);
    dv.setUint8(off + 17, f.dec);
    off += 32;
  }
  dv.setUint8(off, 0x0d); // field descriptor terminator
  off += 1;

  const enc = new TextEncoder();
  for (const feat of features) {
    dv.setUint8(off, 0x20); // " " = not deleted
    off += 1;
    const lotStr = padField(feat.number ?? "", DBF_LOT_FIELD_LEN);
    buf.set(enc.encode(lotStr), off);
    off += DBF_LOT_FIELD_LEN;
    const areaStr = padField(feat.areaM2.toFixed(DBF_AREA_DECIMALS), DBF_AREA_FIELD_LEN, true);
    buf.set(enc.encode(areaStr), off);
    off += DBF_AREA_FIELD_LEN;
  }
  dv.setUint8(off, 0x1a); // end-of-file marker

  return buf;
}

export function buildShapefileSet(features: ShpFeature[]): { shp: Uint8Array; shx: Uint8Array; dbf: Uint8Array } {
  const { shp, shx } = buildShpAndShx(features);
  const dbf = buildDbf(features);
  return { shp, shx, dbf };
}
