"use client";

import { useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { Button, Card, Field, Input } from "@/components/ui";
import { toDotted } from "@/components/SgDiagram";
import type { ParcelDoc, ParsedRow, PointType } from "@/lib/types";

function downloadText(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** One point's coordinate row, and (for every point after the first) the
 *  misclosure of the leg that arrived at it — client req 2026-08-26,
 *  matching their supplied sample byte-for-byte: from each point's own
 *  RECORDED coordinate, walk the leg's bearing/distance forward and
 *  compare the result to the NEXT point's own recorded coordinate.
 *  Deliberately per-leg (always anchored on recorded coordinates at both
 *  ends), not a cumulative dead-reckoning chain — that's what actually
 *  catches a single bad bearing/distance entry without it being masked or
 *  amplified by errors on other legs, and it's what reproduces the
 *  sample's exact residuals (verified point-for-point against their
 *  Lot 702 Metsimotlhabe sample before this format was finalized). */
function buildConsistencyLines(
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

const COORD_LIST_GROUPS: { key: PointType; label: string }[] = [
  { key: "trig", label: "Govt Trig Stations" },
  { key: "ref", label: "Reference Marks" },
  { key: "wp", label: "Working Station" },
  { key: "beacon", label: "Beacons" },
];

/** "Coordinate List" report (client req 2026-08-26, Part 31b) — every
 *  project point grouped into 4 labelled sections by its Part 31a Type,
 *  in a fixed order (Trig, Ref, WP, Beacons); a type with no points omits
 *  its section entirely. Column widths are computed from the actual data
 *  so names/descriptions of any length still line up. */
function buildCoordinateListLines(rows: ParsedRow[], titleLine: string, subtitleLine: string): string[] {
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

/** Reports hub (client req 2026-08-26): download the traverse data-
 *  consistency check (per-leg bearing/distance vs. recorded-coordinate
 *  misclosure), the grouped Coordinate List, and a plain CSV coordinate
 *  list. */
export function Reports() {
  const { cogoResult, diagramFigure, diagramInput, parcelDoc, importResult, setImportResult, config } = useStore();
  const fig = diagramFigure ?? cogoResult;
  const [declaredArea, setDeclaredArea] = useState("");

  const coords = useMemo(() => {
    if (cogoResult?.points?.length) return cogoResult.points.map((p) => ({ id: p.name ?? "", e: p.east, n: p.north }));
    const pd = parcelDoc as ParcelDoc | null;
    if (pd?.beacons?.length) return pd.beacons.map((b) => ({ id: b.id, e: b.east, n: b.north }));
    if (importResult?.rows?.length)
      return importResult.rows
        .filter((r) => r.east != null && r.north != null)
        .map((r) => ({ id: r.beaconId ?? "", e: r.east as number, n: r.north as number }));
    return [];
  }, [cogoResult, parcelDoc, importResult]);

  const baseName = (config.name || "survey").replace(/\s+/g, "_");
  const lotLine = ((diagramInput as { meta?: { lotName?: string } } | null)?.meta?.lotName) || config.name || "Untitled Survey";

  const consistencyLines = useMemo(() => {
    if (!fig || fig.points.length < 3 || fig.legs.length < 3) return null;
    return buildConsistencyLines(fig.points, fig.legs);
  }, [fig]);

  // "Survey of Lot 1583 PALLAROAD" / "Coordinate List of Lo 27° (Metres)"
  // (client req 2026-08-26, Part 31b) — lot name mirrors Diagrams (dropping
  // any leading "LOT " so it isn't doubled against the fixed "Lot" word
  // here), coordinate system mirrors the project's own Lo-band setting.
  const rawLotName = ((diagramInput as { meta?: { lotName?: string } } | null)?.meta?.lotName) || "";
  const coordListTitle = `Survey of Lot ${(rawLotName.replace(/^lot\s+/i, "") || rawLotName || "—")}`;
  const coordSysShort = config.coordinateSystem.replace(" Botswana", "").replace(/(\d+)/, "$1°");
  const coordListSubtitle = `Coordinate List of ${coordSysShort} (Metres)`;

  const coordListRows = importResult?.rows ?? [];
  const coordListLines = useMemo(() => {
    if (!coordListRows.some((r) => r.east != null && r.north != null)) return null;
    return buildCoordinateListLines(coordListRows, coordListTitle, coordListSubtitle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coordListRows, coordListTitle, coordListSubtitle]);

  function setPointMeta(index: number, patch: Partial<Pick<ParsedRow, "description" | "srNo">>) {
    if (!importResult) return;
    setImportResult({
      ...importResult,
      rows: importResult.rows.map((r) => (r.index === index ? { ...r, ...patch } : r)),
    });
  }

  function downloadCoordinateListReport() {
    if (!coordListLines) return;
    downloadText(`${baseName}_coordinate_list.txt`, coordListLines.join("\n"), "text/plain");
  }

  function downloadCoordinateList() {
    const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const header = "Beacon,East,North";
    const body = coords.map((c) => `${cell(String(c.id))},${c.e.toFixed(3)},${c.n.toFixed(3)}`).join("\n");
    downloadText(`${baseName}_coordinates.csv`, `${header}\n${body}\n`, "text/csv");
  }

  function downloadConsistencyReport() {
    if (!consistencyLines || !fig) return;
    const computedArea = fig.area_m2;
    const areaLine = declaredArea.trim()
      ? `The area is ${Number(declaredArea).toFixed(2)} (${computedArea.toFixed(2)}) square metres.`
      : `The area is ${computedArea.toFixed(2)} square metres.`;
    const lines = ["Consistency Report", "", lotLine, "", ...consistencyLines, areaLine];
    downloadText(`${baseName}_consistency_report.txt`, lines.join("\n"), "text/plain");
  }

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-slate-700">Reports</h2>

      <Card title="Data consistency">
        {!consistencyLines ? (
          <p className="py-8 text-center text-sm text-slate-400">
            Run a closed traverse (at least 3 beacons) first — the consistency check walks each leg's
            bearing and distance forward from its own recorded coordinate and compares the result to the
            next beacon's recorded coordinate.
          </p>
        ) : (
          <>
            <p className="mb-3 text-sm text-slate-500">
              For every leg: from {"{"}beacon{"}"}'s recorded coordinate, walk the stated bearing and
              distance forward, and compare the result to the next beacon's own recorded coordinate. A
              small residual is normal (survey tolerance); a large one flags a bad bearing, distance, or
              coordinate entry.
            </p>
            <div className="mb-3 max-w-xs">
              <Field label="Declared area from title deed (optional)">
                <Input
                  type="number"
                  value={declaredArea}
                  onChange={setDeclaredArea}
                  placeholder={`e.g. ${fig!.area_m2.toFixed(2)}`}
                />
              </Field>
            </div>
            <pre className="mb-3 overflow-x-auto rounded-lg bg-slate-50 p-4 text-xs text-slate-700">
              {["Consistency Report", "", lotLine, "", ...consistencyLines].join("\n")}
              {"\n"}
              {declaredArea.trim()
                ? `The area is ${(Number(declaredArea) || 0).toFixed(2)} (${fig!.area_m2.toFixed(2)}) square metres.`
                : `The area is ${fig!.area_m2.toFixed(2)} square metres.`}
            </pre>
            <Button onClick={downloadConsistencyReport}>⬇ Download Data Consistency Report</Button>
          </>
        )}
      </Card>

      <Card title="Coordinate List">
        {!coordListLines ? (
          <p className="py-8 text-center text-sm text-slate-400">
            Import points under Data Import first — this groups every point by its Type (Part 31a: Govt
            Trig Station, Reference Mark, Working Station, Beacon) into one labelled coordinate schedule.
          </p>
        ) : (
          <>
            <p className="mb-3 text-sm text-slate-500">
              Description and SR NO are editable per point below; they're saved with the project and feed
              the downloaded report.
            </p>
            {COORD_LIST_GROUPS.map((g) => {
              const rows = (importResult?.rows ?? []).filter(
                (r) => r.east != null && r.north != null && (r.pointType ?? "beacon") === g.key
              );
              if (!rows.length) return null;
              return (
                <div key={g.key} className="mb-4">
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{g.label}</div>
                  <div className="overflow-x-auto rounded-lg border border-slate-200">
                    <table className="w-full min-w-[560px] text-sm">
                      <thead className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                        <tr>
                          <th className="px-3 py-2">Point</th>
                          <th className="px-3 py-2">Eastings(Y)</th>
                          <th className="px-3 py-2">Northings(X)</th>
                          <th className="px-3 py-2">Description</th>
                          <th className="px-3 py-2">SR NO</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.index} className="border-b border-slate-100">
                            <td className="px-3 py-2 font-medium">{r.beaconId ?? "—"}</td>
                            <td className="px-3 py-2">{(r.east as number).toFixed(2)}</td>
                            <td className="px-3 py-2">{(r.north as number).toFixed(2)}</td>
                            <td className="px-3 py-2">
                              <input
                                value={r.description ?? ""}
                                onChange={(e) => setPointMeta(r.index, { description: e.target.value })}
                                placeholder="e.g. 12mm Iron Peg"
                                className="w-full rounded border border-slate-200 px-2 py-1 text-sm"
                              />
                            </td>
                            <td className="px-3 py-2">
                              <input
                                value={r.srNo ?? ""}
                                onChange={(e) => setPointMeta(r.index, { srNo: e.target.value })}
                                placeholder="-"
                                className="w-24 rounded border border-slate-200 px-2 py-1 text-sm"
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
            <Button onClick={downloadCoordinateListReport}>⬇ Download Coordinate List</Button>
          </>
        )}
      </Card>

      <Card title="Coordinate list (CSV)">
        <p className="mb-3 text-sm text-slate-500">
          {coords.length} coordinate(s) available
          {cogoResult ? " from the COGO figure" : parcelDoc ? " from parcels" : importResult ? " from import" : ""}.
        </p>
        <Button onClick={downloadCoordinateList} disabled={!coords.length}>
          ⬇ Download Coordinate List (CSV)
        </Button>
      </Card>
    </div>
  );
}
