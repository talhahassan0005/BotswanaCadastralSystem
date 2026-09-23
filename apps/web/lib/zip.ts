/**
 * Minimal, dependency-free ZIP writer — STORE method only (no compression).
 * Built for the Shapefile export (client req 2026-09-24): a .shp needs its
 * .shx/.dbf/.prj siblings alongside it to be valid, so the four files are
 * packaged into one .zip the browser can download as a single file. STORE
 * (uncompressed) keeps this small and dependency-free while still producing
 * a fully standard, universally-readable ZIP — no compression codec needed.
 *
 * Format reference: PKWARE's .ZIP File Format Specification — local file
 * header + data per entry, followed by one central directory record per
 * entry, followed by a single end-of-central-directory record.
 */

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

// Standard ZIP CRC-32 (polynomial 0xEDB88320), table-based.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS date/time packed the way ZIP local/central headers expect — a fixed
 *  stand-in timestamp is fine here (nothing downstream reads it). */
const DOS_TIME = 0;
const DOS_DATE = (1 << 9) | (1 << 5) | 1; // 1980-01-01, the ZIP epoch

export function createZip(entries: ZipEntry[]): Blob {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header signature
    local.setUint16(4, 20, true); // version needed to extract
    local.setUint16(6, 0, true); // flags
    local.setUint16(8, 0, true); // method = 0 (store)
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true); // compressed size
    local.setUint32(22, size, true); // uncompressed size
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true); // extra field length
    chunks.push(new Uint8Array(local.buffer), nameBytes, entry.data);

    const cdir = new DataView(new ArrayBuffer(46));
    cdir.setUint32(0, 0x02014b50, true); // central directory header signature
    cdir.setUint16(4, 20, true); // version made by
    cdir.setUint16(6, 20, true); // version needed
    cdir.setUint16(8, 0, true); // flags
    cdir.setUint16(10, 0, true); // method = 0 (store)
    cdir.setUint16(12, DOS_TIME, true);
    cdir.setUint16(14, DOS_DATE, true);
    cdir.setUint32(16, crc, true);
    cdir.setUint32(20, size, true);
    cdir.setUint32(24, size, true);
    cdir.setUint16(28, nameBytes.length, true);
    cdir.setUint16(30, 0, true); // extra field length
    cdir.setUint16(32, 0, true); // comment length
    cdir.setUint16(34, 0, true); // disk number start
    cdir.setUint16(36, 0, true); // internal attrs
    cdir.setUint32(38, 0, true); // external attrs
    cdir.setUint32(42, offset, true); // offset of local header
    central.push(new Uint8Array(cdir.buffer), nameBytes);

    offset += 30 + nameBytes.length + size;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) centralSize += c.length;

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // end of central directory signature
  end.setUint16(4, 0, true); // disk number
  end.setUint16(6, 0, true); // disk with central directory
  end.setUint16(8, entries.length, true); // entries on this disk
  end.setUint16(10, entries.length, true); // total entries
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  end.setUint16(20, 0, true); // comment length

  // TS's DOM lib types Uint8Array's `buffer` as the broader ArrayBufferLike
  // (it could in principle wrap a SharedArrayBuffer), which BlobPart's own
  // stricter ArrayBufferView<ArrayBuffer> constraint then rejects — these
  // are always plain, freshly-allocated ArrayBuffers here, so this is safe.
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)] as BlobPart[], { type: "application/zip" });
}
