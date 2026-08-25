/** Exact-format generators for the Survey Record's "Data Consistency" and
 *  "Coordinate List" documents (client req 2026-08-26, Parts 30/31b) —
 *  shared here (not local to one module) so Survey Record stays the single
 *  home for both per Part 32a without a second, independently-drifting copy.
 */
import { toDotted } from "@/components/SgDiagram";
import type { ParsedRow, PointType } from "./types";

/** One point's coordinate row, and (for every point after the first) the
 *  misclosure of the leg that arrived at it — matching the client's supplied
 *  sample byte-for-byte: from each point's own RECORDED coordinate, walk the
 *  leg's bearing/distance forward and compare the result to the NEXT
 *  point's own recorded coordinate. Deliberately per-leg (always anchored on
 *  recorded coordinates at both ends), not a cumulative dead-reckoning
 *  chain — that's what actually catches a single bad bearing/distance entry
 *  without it being masked or amplified by errors on other legs, and it's
 *  what reproduces the sample's exact residuals (verified point-for-point
 *  against their Lot 702 Metsimotlhabe sample before this format was
 *  finalized). */
export function buildConsistencyLines(
  points: { name: string | null; east: number; north: number }[],
  legs: { from: string | null; to: string | null; bearing: number; bearing_dms: string; distance: number }[]
): string[] {
  const byName = new Map(points.map((p) => [p.name, p]));
  const lines: string[] = [];
  const nameRow = (name: string, e: number, n: number) =>
    `                ${(name || "").padEnd(21)}${e.toFixed(2)} ${n.toFixed(2)}`;
  const misRow = (de: number, dn: number) => `${" ".repeat(40)}${de.toFixed(3)}${" ".repeat(7)}${dn.toFixed(3)}`;
  legs.forEach((leg, i) => {
    const from = leg.from ? byName.get(leg.from) : null;
    const to = leg.to ? byName.get(leg.to) : null;
    if (!from || !to) return;
    if (i === 0) lines.push(nameRow(from.name ?? "", from.east, from.north));
    lines.push(`${toDotted(leg.bearing_dms)}    ${leg.distance.toFixed(2)}`);
    const rad = (leg.bearing * Math.PI) / 180;
    const computedE = from.east + leg.distance * Math.sin(rad);
    const computedN = from.north + leg.distance * Math.cos(rad);
    lines.push(nameRow(to.name ?? "", to.east, to.north));
    lines.push(misRow(computedE - to.east, computedN - to.north));
  });
  return lines;
}

export const COORD_LIST_GROUPS: { key: PointType; label: string }[] = [
  { key: "trig", label: "Govt Trig Stations" },
  { key: "ref", label: "Reference Marks" },
  { key: "wp", label: "Working Station" },
  { key: "beacon", label: "Beacons" },
];

/** "Coordinate List" report (Part 31b) — every project point grouped into 4
 *  labelled sections by its Part 31a Type, in a fixed order (Trig, Ref, WP,
 *  Beacons); a type with no points omits its section entirely. Column
 *  widths are computed from the actual data so names/descriptions of any
 *  length still line up. */
export function buildCoordinateListLines(rows: ParsedRow[], titleLine: string, subtitleLine: string): string[] {
  const valid = rows.filter((r) => r.east != null && r.north != null);
  const byType = (t: PointType) => valid.filter((r) => (r.pointType ?? "beacon") === t);
  const cell = (r: ParsedRow) => ({
    point: r.beaconId ?? "",
    e: (r.east as number).toFixed(2),
    n: (r.north as number).toFixed(2),
    desc: r.description || "",
    sr: r.srNo || "-",
  });
  const headers = { point: "Point", e: "Eastings(Y)", n: "Northings(X)", desc: "Description", sr: "SR NO" };
  const allCells = valid.map(cell);
  const w = (key: keyof typeof headers) => Math.max(headers[key].length, ...allCells.map((c) => c[key].length));
  const pointW = w("point"), eW = w("e"), nW = w("n"), descW = w("desc"), srW = w("sr");
  const gap = "   ";
  const row = (point: string, e: string, n: string, desc: string, sr: string, page = "") =>
    [point.padEnd(pointW), e.padEnd(eW), n.padEnd(nW), desc.padEnd(descW), sr.padEnd(srW), page].join(gap).trimEnd();

  const lines = [titleLine, "", subtitleLine, "", row(headers.point, headers.e, headers.n, headers.desc, headers.sr, "Page"), ""];
  for (const g of COORD_LIST_GROUPS) {
    const grows = byType(g.key);
    if (!grows.length) continue;
    lines.push(g.label, "");
    for (const r of grows) {
      const c = cell(r);
      lines.push(row(c.point, c.e, c.n, c.desc, c.sr));
    }
    lines.push("");
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function downloadText(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
