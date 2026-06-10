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
  texts: { x: number; y: number; text: string; height: number; layer?: string }[];
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
        if (x != null && y != null) out.texts.push({ x, y, text: cleanText(s), height: h ?? 10, layer: lay });
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

export function writeDxf(d: ImportedDrawing): string {
  const L: string[] = [];
  const e = (code: number, val: string | number) => {
    L.push(String(code));
    L.push(String(val));
  };
  e(0, "SECTION");
  e(2, "ENTITIES");
  for (const p of d.points) {
    e(0, "POINT"); e(8, dxfLayer(p.layer ?? "POINTS")); e(10, p.x); e(20, p.y); e(30, 0);
    if (p.label) {
      e(0, "TEXT"); e(8, dxfLayer(p.layer ?? "LABELS")); e(10, p.x); e(20, p.y); e(40, 1.5); e(1, p.label);
    }
  }
  for (const l of d.polylines) {
    e(0, "LWPOLYLINE"); e(8, dxfLayer(l.layer ?? "LINES")); e(90, l.pts.length); e(70, l.closed ? 1 : 0);
    for (const v of l.pts) {
      e(10, v.x); e(20, v.y);
    }
  }
  for (const t of d.texts) {
    e(0, "TEXT"); e(8, dxfLayer(t.layer ?? "TEXT")); e(10, t.x); e(20, t.y); e(40, t.height); e(1, t.text);
  }
  e(0, "ENDSEC");
  e(0, "EOF");
  return L.join("\r\n") + "\r\n";
}
