/**
 * Minimal, dependency-free DXF reader/writer for the in-app drafting editor.
 * Handles the entities a cadastral/survey drawing actually uses — LINE,
 * LWPOLYLINE, POLYLINE/VERTEX, POINT, TEXT/MTEXT, CIRCLE — and writes an
 * ENTITIES-only DXF that AutoCAD and other survey software re-import cleanly.
 *
 * Everything maps to a neutral `ImportedDrawing` shape shared with the
 * Shapefile reader (see ./shp), so the editor has one merge path.
 */

export interface ImportedDrawing {
  points: { x: number; y: number; label?: string; layer?: string }[];
  polylines: { pts: { x: number; y: number }[]; closed: boolean; layer?: string }[];
  /** `anchor` mirrors SVG's text-anchor ("start" is DXF's default left
   *  justification, so it's left unset there) — needed so a DXF export of a
   *  template with centred/right-aligned labels (e.g. table headers, right-
   *  aligned distance values) lands in the same place as the SVG/print
   *  version instead of always starting from its own left edge (client req
   *  2026-08-26, Part 34).
   *
   *  `widthFactor` (DXF group 41, default 1.0 when unset) horizontally
   *  scales the text — a real CAD viewer's default text style (e.g. AutoCAD
   *  "Standard"/txt.shx) renders each character noticeably WIDER than the
   *  browser's own font did when a template's column positions/word-wrap
   *  were computed against it, so text that fit cleanly on screen can bleed
   *  into the next column once opened in a CAD app (client req 2026-08-26,
   *  Part 34 follow-up: "font ... responsive nahi hai" — the content was
   *  all there, but overlapping). Compressing it back down compensates. */
  texts: { x: number; y: number; text: string; height: number; layer?: string; anchor?: "middle" | "end"; widthFactor?: number }[];
}

/** Sanitise a layer name for DXF (no spaces / reserved chars). */
function dxfLayer(name: string | undefined): string {
  return (name || "0").replace(/[^A-Za-z0-9_\-]/g, "_");
}

/** Strip MTEXT inline formatting (\A1; , {\fArial;...}, \P …) to plain text. */
function cleanText(s: string): string {
  return s
    .replace(/\\P/g, " ")
    .replace(/\\[A-Za-z][^;]*;/g, "")
    .replace(/[{}]/g, "")
    .trim();
}

export function parseDxf(text: string): ImportedDrawing {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) continue;
    pairs.push([code, lines[i + 1] ?? ""]);
  }

  // Restrict to the ENTITIES section so TABLES/BLOCKS (which also use code 0)
  // aren't mistaken for drawing entities. Fall back to whole file if absent.
  let start = 0;
  let end = pairs.length;
  for (let k = 0; k < pairs.length; k++) {
    if (pairs[k][0] === 2 && pairs[k][1].trim() === "ENTITIES") {
      start = k + 1;
      break;
    }
  }
  for (let k = start; k < pairs.length; k++) {
    if (pairs[k][0] === 0 && pairs[k][1].trim() === "ENDSEC") {
      end = k;
      break;
    }
  }

  const out: ImportedDrawing = { points: [], polylines: [], texts: [] };
  let cur: { type: string; codes: [number, string][] } | null = null;
  let openPoly: { pts: { x: number; y: number }[]; closed: boolean; layer?: string } | null = null;

  const num = (codes: [number, string][], c: number): number | undefined => {
    const f = codes.find(([k]) => k === c);
    return f ? parseFloat(f[1]) : undefined;
  };

  const flush = () => {
    if (!cur) return;
    const c = cur.codes;
    const lay = c.find(([k]) => k === 8)?.[1]?.trim() || undefined; // layer (code 8)
    switch (cur.type) {
      case "LINE": {
        const x1 = num(c, 10), y1 = num(c, 20), x2 = num(c, 11), y2 = num(c, 21);
        if ([x1, y1, x2, y2].every((v) => v != null))
          out.polylines.push({ pts: [{ x: x1!, y: y1! }, { x: x2!, y: y2! }], closed: false, layer: lay });
        break;
      }
      case "LWPOLYLINE": {
        const flag = num(c, 70) ?? 0;
        const pts: { x: number; y: number }[] = [];
        let cx: number | undefined;
        for (const [k, v] of c) {
          if (k === 10) cx = parseFloat(v);
          else if (k === 20 && cx != null) {
            pts.push({ x: cx, y: parseFloat(v) });
            cx = undefined;
          }
        }
        if (pts.length >= 2) out.polylines.push({ pts, closed: (flag & 1) === 1, layer: lay });
        else if (pts.length === 1) out.points.push({ ...pts[0], layer: lay });
        break;
      }
      case "POLYLINE": {
        const flag = num(c, 70) ?? 0;
        openPoly = { pts: [], closed: (flag & 1) === 1, layer: lay };
        break;
      }
      case "VERTEX": {
        const x = num(c, 10), y = num(c, 20);
        if (openPoly && x != null && y != null) openPoly.pts.push({ x, y });
        break;
      }
      case "POINT": {
        const x = num(c, 10), y = num(c, 20);
        if (x != null && y != null) out.points.push({ x, y, layer: lay });
        break;
      }
      case "TEXT":
      case "MTEXT": {
        const x = num(c, 10), y = num(c, 20), h = num(c, 40);
        const s = c.find(([k]) => k === 1)?.[1] ?? "";
        const justify = num(c, 72);
        const anchor = justify === 1 ? "middle" : justify === 2 ? "end" : undefined;
        const widthFactor = num(c, 41);
        if (x != null && y != null) out.texts.push({ x, y, text: cleanText(s), height: h ?? 10, layer: lay, anchor, widthFactor });
        break;
      }
      case "CIRCLE": {
        const x = num(c, 10), y = num(c, 20), r = num(c, 40);
        if (x != null && y != null && r != null) {
          const pts = [];
          for (let a = 0; a < 36; a++) {
            const ang = (a / 36) * 2 * Math.PI;
            pts.push({ x: x + r * Math.cos(ang), y: y + r * Math.sin(ang) });
          }
          out.polylines.push({ pts, closed: true, layer: lay });
        }
        break;
      }
    }
    cur = null;
  };

  for (let k = start; k < end; k++) {
    const [code, value] = pairs[k];
    if (code === 0) {
      flush();
      const t = value.trim();
      if (t === "SEQEND") {
        // `openPoly` is mutated inside the flush() closure, so outer control-flow
        // narrowing can't see it — cast to the real type before reading.
        const op = openPoly as { pts: { x: number; y: number }[]; closed: boolean; layer?: string } | null;
        if (op && op.pts.length >= 2) out.polylines.push(op);
        openPoly = null;
        continue;
      }
      cur = { type: t, codes: [] };
    } else if (cur) {
      cur.codes.push([code, value]);
    }
  }
  flush();
  const tail = openPoly as { pts: { x: number; y: number }[]; closed: boolean; layer?: string } | null;
  if (tail && tail.pts.length >= 2) out.polylines.push(tail);

  return out;
}

/** Writes a HEADER + TABLES + ENTITIES DXF, targeting the AutoCAD R12
 *  (AC1009) format (client req 2026-08-26: the AC1015-declared version
 *  with AcDb* subclass markers and LWPOLYLINE entities "refuses to open"
 *  in real-world CAD software).
 *
 *  R12 is the deliberate choice here, not just "an older version" — AC1015
 *  ("AutoCAD 2000") introduced a database-backed object model that expects
 *  a fuller TABLES section (VPORT/STYLE/BLOCK_RECORD, not just LAYER), a
 *  BLOCKS section defining *Model_Space/*Paper_Space, and often an OBJECTS
 *  section for its named-object dictionary — a file that only claims to be
 *  AC1015 while skipping all of that is exactly the kind of "structurally
 *  incomplete for its declared version" file that trips up real DXF
 *  importers (AutoCAD itself is lenient about it; plenty of other CAD/GIS
 *  tools are not). AC1015 was also emitting AcDb* subclass markers (group
 *  100) and LWPOLYLINE entities, both introduced in later versions —
 *  declaring an old version but using newer constructs is its own way to
 *  fail strict parsers. R12 has none of these traps: it doesn't need
 *  BLOCKS/OBJECTS, a LAYER-only TABLES section is completely normal for
 *  it, and every DXF-capable program ever built can read it — it's the
 *  universal lowest-common-denominator interchange format. Polylines are
 *  written the classic way (POLYLINE/VERTEX/SEQEND) since LWPOLYLINE
 *  didn't exist yet in R12; parseDxf already reads that form. */
export function writeDxf(d: ImportedDrawing): string {
  const L: string[] = [];
  const e = (code: number, val: string | number) => {
    L.push(String(code));
    L.push(String(val));
  };

  const layers = new Set<string>(["0"]);
  for (const p of d.points) {
    layers.add(dxfLayer(p.layer ?? "POINTS"));
    if (p.label) layers.add(dxfLayer(p.layer ?? "LABELS"));
  }
  for (const l of d.polylines) layers.add(dxfLayer(l.layer ?? "LINES"));
  for (const t of d.texts) layers.add(dxfLayer(t.layer ?? "TEXT"));

  // $EXTMIN/$EXTMAX: some viewers zoom-to-extents from these on open
  // rather than the raw geometry — a missing/zero range can make an
  // otherwise-valid drawing appear blank or fail to display.
  const allX = [...d.points.map((p) => p.x), ...d.polylines.flatMap((l) => l.pts.map((v) => v.x)), ...d.texts.map((t) => t.x)];
  const allY = [...d.points.map((p) => p.y), ...d.polylines.flatMap((l) => l.pts.map((v) => v.y)), ...d.texts.map((t) => t.y)];
  const minX = allX.length ? Math.min(...allX) : 0, maxX = allX.length ? Math.max(...allX) : 0;
  const minY = allY.length ? Math.min(...allY) : 0, maxY = allY.length ? Math.max(...allY) : 0;

  let handle = 0x30;
  const nextHandle = () => (handle++).toString(16).toUpperCase();

  e(0, "SECTION"); e(2, "HEADER");
  e(9, "$ACADVER"); e(1, "AC1009");
  e(9, "$INSBASE"); e(10, 0); e(20, 0); e(30, 0);
  e(9, "$EXTMIN"); e(10, minX); e(20, minY); e(30, 0);
  e(9, "$EXTMAX"); e(10, maxX); e(20, maxY); e(30, 0);
  e(0, "ENDSEC");

  e(0, "SECTION"); e(2, "TABLES");
  e(0, "TABLE"); e(2, "LAYER"); e(70, layers.size);
  for (const lay of layers) {
    e(0, "LAYER"); e(2, lay); e(70, 0); e(62, 7); e(6, "CONTINUOUS");
  }
  e(0, "ENDTAB");
  // A text STYLE explicitly naming Arial (client req 2026-08-26: "use the
  // arial font family for this DXF document") — without this, a TEXT
  // entity has no font of its own and every viewer falls back to its own
  // default text style, commonly a much WIDER technical/monospace drafting
  // font (e.g. txt.shx) than the proportional sans-serif (Calibri/Arial
  // stack) the on-screen diagram is built against. That mismatch was the
  // real root of the repeated column-overlap reports — no amount of
  // guessing at a compensating width factor fixes a font substitution the
  // DXF itself never specified. Every TEXT entity below references this
  // style by name (group 7).
  e(0, "TABLE"); e(2, "STYLE"); e(70, 1);
  e(0, "STYLE"); e(2, "Arial"); e(70, 0); e(40, 0); e(41, 1.0); e(50, 0); e(71, 0); e(42, 1.0); e(3, "arial.ttf"); e(4, "");
  e(0, "ENDTAB");
  e(0, "ENDSEC");

  e(0, "SECTION");
  e(2, "ENTITIES");
  for (const p of d.points) {
    e(0, "POINT"); e(5, nextHandle()); e(8, dxfLayer(p.layer ?? "POINTS")); e(10, p.x); e(20, p.y); e(30, 0);
    if (p.label) {
      e(0, "TEXT"); e(5, nextHandle()); e(8, dxfLayer(p.layer ?? "LABELS")); e(10, p.x); e(20, p.y); e(30, 0); e(40, 1.5); e(7, "Arial"); e(1, p.label);
    }
  }
  for (const l of d.polylines) {
    e(0, "POLYLINE"); e(5, nextHandle()); e(8, dxfLayer(l.layer ?? "LINES")); e(66, 1); e(70, l.closed ? 1 : 0);
    for (const v of l.pts) {
      e(0, "VERTEX"); e(5, nextHandle()); e(8, dxfLayer(l.layer ?? "LINES")); e(10, v.x); e(20, v.y); e(30, 0);
    }
    e(0, "SEQEND"); e(5, nextHandle());
  }
  for (const t of d.texts) {
    e(0, "TEXT"); e(5, nextHandle()); e(8, dxfLayer(t.layer ?? "TEXT")); e(10, t.x); e(20, t.y); e(30, 0); e(40, t.height); e(7, "Arial");
    if (t.widthFactor != null) e(41, t.widthFactor);
    e(1, t.text);
    // Horizontal justification (72: 1=center, 2=right) requires a second
    // alignment point (11/21/31) per the DXF spec — set equal to the first
    // since we're not using DXF's "fit"/"aligned" modes, just plain
    // centre/right anchoring to match the SVG's text-anchor (client req
    // 2026-08-26, Part 34).
    if (t.anchor === "middle" || t.anchor === "end") {
      e(72, t.anchor === "middle" ? 1 : 2);
      e(11, t.x); e(21, t.y); e(31, 0);
    }
  }
  e(0, "ENDSEC");
  e(0, "EOF");
  return L.join("\r\n") + "\r\n";
}
