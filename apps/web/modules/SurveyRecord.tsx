"use client";

import { useEffect, useRef, useState } from "react";
import { useStore, cogoTabLabel } from "@/lib/store";
import { Button, Card, Field, Input } from "@/components/ui";
import { displayCrs } from "@/lib/crsOptions";
import { buildConsistencyLines, buildCoordinateListLines, comparePointNames, COORD_LIST_GROUPS, downloadText } from "@/lib/reportFormats";
import type { ParsedRow, PointType } from "@/lib/types";

type DocId = "submission" | "report" | "consistency" | "coordinates" | "comparison";

const DOCS: { id: DocId; label: string; blurb: string }[] = [
  { id: "submission", label: "Submission Letter", blurb: "Formal covering letter lodging the survey with the approving authority." },
  { id: "report", label: "Report on Survey", blurb: "Narrative report describing the survey, method, closure and area." },
  { id: "consistency", label: "Data Consistency", blurb: "Per-leg bearing/distance vs. recorded-coordinate misclosure check." },
  { id: "coordinates", label: "Coordinate List", blurb: "Every project point grouped by type, with description and SR NO." },
  { id: "comparison", label: "Data Comparison", blurb: "Leg-by-leg bearing, distance and adjustment comparison with misclosure summary." },
];

interface ChecklistItem {
  text: string;
  checked: boolean;
}

const DEFAULT_CHECKLIST: ChecklistItem[] = [
  "Report on survey",
  "Fieldbook report",
  "Survey Diagrams",
  "Coordinate list",
  "Data consistency",
  "Data Comparison",
  "Working Plan",
  "Ownership documents",
  "Extract",
].map((text) => ({ text, checked: true }));

const DEFAULT_TO_BLOCK = "The Director\nDepartment of Surveys and Mapping\nP/Bag 0037\nGaborone";

// Standard survey-method narrative (client req 2026-08-27: "pre write
// everything as it is, then user can edit content") — most survey reports
// use near-identical wording, so this seeds the Method field with it fully
// written out; the surveyor only needs to swap in the bracketed specifics
// (equipment, working station, tie stations) rather than write it from
// scratch each time.
const DEFAULT_METHOD_TEXT = `The survey was carried out by the use of [equipment, e.g. Leica GS-14] system.

The survey was started on working station [WP]. This point was occupied by a HERE FIX method, observations to Stations ([tie stations]) were tied to this point (see working plan or field book). Thereafter, calibration was made using all the observed stations. The base stayed at working station [WP] for the first observation to the plot beacons. The base was then moved to Station [station], in order to carry out double polar observations to the beacons of the plots. The coordinates were computed by the use of the in-built Datum and Map software. This was obtained by matching the known local coordinates and those of WGS84.

The final Transformation parameters calculated using all Known Stations ([tie stations]) were then used to transform WGS84 coordinates to Local Grid. The transformation parameters are attached to the field book.

All double polar and checking data were within acceptable limits.`;

function formatLongDate(d: Date): string {
  return `${d.getDate()} ${d.toLocaleString("en-US", { month: "long" })} ${d.getFullYear()}`;
}

function fmt(n: number | null | undefined, dp = 3): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toFixed(dp);
}

export function SurveyRecord() {
  const { config, cogoResult, diagramFigure, diagramInput, importResult, setImportResult, recordInput, setRecordInput } = useStore();
  const fig = diagramFigure ?? cogoResult;

  // Diagrams module's own fields (client req 2026-08-26, Part 32c/32d: "pull
  // directly from the Diagram module's existing fields" for lot name, tribal
  // territory, land surveyor, and default date of survey — not re-collected
  // here).
  const dMeta = (diagramInput as { meta?: { lotName?: string; tribalArea?: string; surveyor?: string; surveyedDate?: string } } | null)?.meta;
  const lotName = dMeta?.lotName || config.name || "the surveyed property";
  const tribalArea = dMeta?.tribalArea || "";
  const surveyor = dMeta?.surveyor || config.surveyor || "Land Surveyor";

  const ri = (recordInput ?? {}) as {
    doc?: DocId;
    date?: string;
    toBlock?: string;
    checklist?: ChecklistItem[];
    lotNumber?: string;
    assistedBy?: string;
    dateOfSurvey?: string;
    purpose?: string;
    authority?: string;
    calcBasis?: string;
    method?: string;
    declaredArea?: string;
  };

  const [doc, setDoc] = useState<DocId>(ri.doc ?? "submission");
  const [date, setDate] = useState(() => ri.date ?? formatLongDate(new Date()));
  const [toBlock, setToBlock] = useState(ri.toBlock ?? DEFAULT_TO_BLOCK);
  const [checklist, setChecklist] = useState<ChecklistItem[]>(ri.checklist ?? DEFAULT_CHECKLIST);
  // Editable override for the letter's "Lot 102" — defaults to the Diagrams
  // module's lot name but, once typed here, drives both "Re: SUBMISSION OF
  // LOT ..." and the "in respect of Lot ..." sentence together (client req
  // 2026-08-27: editing it in one place must update both).
  const [lotNumber, setLotNumber] = useState(ri.lotNumber ?? lotName.replace(/^lot\s+/i, ""));
  const [assistedBy, setAssistedBy] = useState(ri.assistedBy ?? "");
  const [dateOfSurvey, setDateOfSurvey] = useState(ri.dateOfSurvey ?? dMeta?.surveyedDate ?? "");
  const [purpose, setPurpose] = useState(ri.purpose ?? "");
  const [authority, setAuthority] = useState(ri.authority ?? "");
  const [calcBasis, setCalcBasis] = useState(ri.calcBasis ?? "");
  const [method, setMethod] = useState(ri.method ?? DEFAULT_METHOD_TEXT);
  const [declaredArea, setDeclaredArea] = useState(ri.declaredArea ?? "");

  // Persist every field so the letter/report round-trips with the project
  // instead of resetting on every reopen.
  useEffect(() => {
    setRecordInput({ doc, date, toBlock, checklist, lotNumber, assistedBy, dateOfSurvey, purpose, authority, calcBasis, method, declaredArea });
  }, [doc, date, toBlock, checklist, lotNumber, assistedBy, dateOfSurvey, purpose, authority, calcBasis, method, declaredArea, setRecordInput]);

  const docRef = useRef<HTMLDivElement>(null);

  /** Print the currently-displayed document block (its rendered HTML). */
  function printDoc() {
    if (!docRef.current) return;
    const w = window.open("", "_blank", "width=900,height=1100");
    if (!w) {
      alert("Pop-up blocked. Please allow pop-ups for this site in your browser, then click Print again.");
      return;
    }
    const title = DOCS.find((d) => d.id === doc)?.label ?? "Survey Record";
    w.document.write(
      `<html><head><title>${title} — ${lotName}</title>` +
        `<style>` +
        `@page{size:A4;margin:20mm}` +
        `body{font-family:Georgia,'Times New Roman',serif;color:#1e293b;font-size:12pt;line-height:1.6;margin:0}` +
        `h1{font-size:16pt;margin:0 0 4px}h2{font-size:13pt;margin:18px 0 6px}` +
        `p{margin:0 0 10px}table{border-collapse:collapse;width:100%;font-size:10pt;margin:10px 0}` +
        `th,td{border:1px solid #cbd5e1;padding:5px 8px;text-align:left}` +
        `th{background:#f1f5f9}.muted{color:#64748b}.right{text-align:right}` +
        `.sign{margin-top:48px}.sep{margin:6px 0;border:none;border-top:1px solid #cbd5e1}` +
        `pre{white-space:pre-wrap;font-family:'Courier New',monospace;font-size:10pt}` +
        `</style></head>` +
        `<body onload="window.print()">${docRef.current.innerHTML}</body></html>`
    );
    w.document.close();
  }

  /** Optional: copy the rendered plain text of the current document to the clipboard. */
  function copyText() {
    if (!docRef.current) return;
    const text = docRef.current.innerText;
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => undefined);
  }

  // --- Data Consistency (Part 30) ---
  const consistencyLines = fig && fig.points.length >= 3 && fig.legs.length >= 3 ? buildConsistencyLines(fig.points, fig.legs) : null;
  function downloadConsistency() {
    if (!consistencyLines || !fig) return;
    const areaLine = declaredArea.trim()
      ? `The area is ${Number(declaredArea).toFixed(2)} (${fig.area_m2.toFixed(2)}) square metres.`
      : `The area is ${fig.area_m2.toFixed(2)} square metres.`;
    const lines = ["Consistency Report", "", lotName, "", ...consistencyLines, areaLine];
    downloadText(`${lotName.replace(/\s+/g, "_")}_consistency_report.txt`, lines.join("\n"), "text/plain");
  }

  // --- Coordinate List (Part 31b) ---
  // Lot reference and tribal area now come from the same shared fields as
  // the Submission Letter/Report and the Diagram module (client req
  // 2026-08-27), instead of each document re-deriving its own copy.
  const coordListTitle = `Survey of Lot ${lotNumber}`;
  const coordListSituate = tribalArea ? `Situate in ${tribalArea}` : "";
  const coordSysShort = config.coordinateSystem.replace(" Botswana", "").replace(/(\d+)/, "$1°");
  const coordListSubtitle = `Coordinate List of ${coordSysShort} (Metres)`;
  const coordListRows = importResult?.rows ?? [];
  // Sort beacons ascending/descending by name within each of the 4 sections
  // (client req 2026-08-26, Part 31c) — "none" leaves rows in their
  // original import order, matching the report's prior (unsorted) behaviour.
  const [coordSortDir, setCoordSortDir] = useState<"asc" | "desc" | null>(null);
  const coordListLines = coordListRows.some((r) => r.east != null && r.north != null)
    ? buildCoordinateListLines(coordListRows, coordListTitle, coordListSituate, coordListSubtitle, coordSortDir)
    : null;
  function setPointMeta(index: number, patch: Partial<Pick<ParsedRow, "description" | "srNo">>) {
    if (!importResult) return;
    setImportResult({ ...importResult, rows: importResult.rows.map((r) => (r.index === index ? { ...r, ...patch } : r)) });
  }
  function downloadCoordinateListReport() {
    if (!coordListLines) return;
    downloadText(`${lotName.replace(/\s+/g, "_")}_coordinate_list.txt`, coordListLines.join("\n"), "text/plain");
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-700">Survey Record</h2>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={copyText}>Copy text</Button>
          <Button onClick={printDoc}>Print / Save PDF</Button>
        </div>
      </div>

      {/* Document selector */}
      <div className="flex flex-wrap gap-2">
        {DOCS.map((d) => (
          <button
            key={d.id}
            onClick={() => setDoc(d.id)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              doc === d.id
                ? "bg-brand text-white shadow-sm"
                : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {d.label}
          </button>
        ))}
      </div>
      <p className="-mt-2 text-sm text-slate-500">{DOCS.find((d) => d.id === doc)?.blurb}</p>

      {/* Doc-specific editable fields */}
      {doc === "submission" && (
        <Card title="Submission letter details">
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Date"><Input value={date} onChange={setDate} placeholder="e.g. 26 August 2026" /></Field>
              <Field label="Lot number"><Input value={lotNumber} onChange={setLotNumber} placeholder="e.g. 102" /></Field>
            </div>
            <Field label='"To:" address block'>
              <textarea
                value={toBlock}
                onChange={(e) => setToBlock(e.target.value)}
                rows={4}
                className="w-full rounded-lg border border-slate-200 p-3 text-sm focus:border-brand focus:outline-none"
              />
            </Field>
            <div>
              <div className="mb-1 text-xs font-medium text-slate-500">Enclosed documents (untick or edit any that don't apply)</div>
              <div className="grid gap-1.5 sm:grid-cols-2 sm:gap-x-6">
                {checklist.map((item, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={item.checked}
                      onChange={(e) => setChecklist((c) => c.map((it, j) => (j === i ? { ...it, checked: e.target.checked } : it)))}
                    />
                    <input
                      value={item.text}
                      onChange={(e) => setChecklist((c) => c.map((it, j) => (j === i ? { ...it, text: e.target.value } : it)))}
                      className="flex-1 rounded border border-slate-200 px-2 py-1 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => setChecklist((c) => c.filter((_, j) => j !== i))}
                      className="text-slate-400 hover:text-red-600"
                      aria-label="Remove item"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setChecklist((c) => [...c, { text: "", checked: true }])}
                className="mt-2 text-xs font-medium text-brand underline"
              >
                + Add item
              </button>
            </div>
          </div>
        </Card>
      )}

      {doc === "report" && (
        <Card title="Report on Survey details">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Assisted by"><Input value={assistedBy} onChange={setAssistedBy} placeholder="e.g. K. Moatlhodi" /></Field>
            <Field label="Date of Survey"><Input value={dateOfSurvey} onChange={setDateOfSurvey} placeholder="e.g. February 2026" /></Field>
          </div>
          <div className="mt-3 space-y-3">
            <Field label="1. Purpose">
              <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2} placeholder={`Survey of Lot ${lotNumber}`} className="w-full rounded-lg border border-slate-200 p-3 text-sm focus:border-brand focus:outline-none" />
            </Field>
            <Field label="2. Authority">
              <textarea value={authority} onChange={(e) => setAuthority(e.target.value)} rows={2} placeholder="e.g. Land Board name" className="w-full rounded-lg border border-slate-200 p-3 text-sm focus:border-brand focus:outline-none" />
            </Field>
            <Field label="3. Calculation Basis">
              <textarea value={calcBasis} onChange={(e) => setCalcBasis(e.target.value)} rows={2} placeholder={`e.g. Based on ${displayCrs(config.coordinateSystem)} system using ${dMeta?.tribalArea || "local"} Reference Marks.`} className="w-full rounded-lg border border-slate-200 p-3 text-sm focus:border-brand focus:outline-none" />
            </Field>
            <Field label="4. Method">
              <textarea value={method} onChange={(e) => setMethod(e.target.value)} rows={10} className="w-full rounded-lg border border-slate-200 p-3 text-sm focus:border-brand focus:outline-none" />
            </Field>
          </div>
        </Card>
      )}

      {doc === "consistency" && (
        <Card title="Data consistency details">
          <div className="max-w-xs">
            <Field label="Declared area from title deed (optional)">
              <Input type="number" value={declaredArea} onChange={setDeclaredArea} placeholder={fig ? `e.g. ${fig.area_m2.toFixed(2)}` : "e.g. 981.00"} />
            </Field>
          </div>
        </Card>
      )}

      {/* Rendered, printable document block */}
      <Card>
        <div ref={docRef} className="space-y-4 text-sm text-slate-700">
          {doc === "submission" && (
            <SubmissionLetter toBlock={toBlock} date={date} lotNumber={lotNumber} tribalArea={tribalArea} checklist={checklist} surveyor={surveyor} />
          )}
          {doc === "report" && (
            <ReportOnSurvey
              surveyor={surveyor}
              assistedBy={assistedBy}
              dateOfSurvey={dateOfSurvey}
              purpose={purpose || `Survey of Lot ${lotNumber}`}
              authority={authority}
              calcBasis={calcBasis}
              method={method}
            />
          )}
          {doc === "consistency" && (
            <div className="space-y-3">
              <h1 className="text-base font-bold text-slate-800">Data Consistency</h1>
              {!consistencyLines || !fig ? (
                <p className="rounded-lg bg-amber-50 px-4 py-3 text-amber-700">
                  Run a closed traverse (at least 3 beacons) in the {cogoTabLabel(config.discipline)} first — the
                  consistency check walks each leg's bearing and distance forward from its own recorded coordinate
                  and compares the result to the next beacon's recorded coordinate.
                </p>
              ) : (
                <>
                  <pre className="overflow-x-auto rounded-lg bg-slate-50 p-4 text-xs text-slate-700">
                    {["Consistency Report", "", lotName, "", ...consistencyLines].join("\n")}
                    {"\n"}
                    {declaredArea.trim()
                      ? `The area is ${(Number(declaredArea) || 0).toFixed(2)} (${fig.area_m2.toFixed(2)}) square metres.`
                      : `The area is ${fig.area_m2.toFixed(2)} square metres.`}
                  </pre>
                  <Button variant="ghost" onClick={downloadConsistency}>⬇ Download as .txt</Button>
                </>
              )}
            </div>
          )}
          {doc === "coordinates" && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h1 className="text-base font-bold text-slate-800">{coordListTitle}</h1>
                  {coordListSituate && <div className="text-sm text-slate-600">{coordListSituate}</div>}
                  <div className="text-sm text-slate-600">{coordListSubtitle}</div>
                </div>
                {coordListLines && (
                  <div className="flex items-center gap-1 text-xs">
                    <span className="mr-1 text-slate-400">Sort beacons:</span>
                    {(
                      [
                        ["none", "Original"],
                        ["asc", "A → Z"],
                        ["desc", "Z → A"],
                      ] as const
                    ).map(([v, label]) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setCoordSortDir(v === "none" ? null : v)}
                        className={`rounded-md border px-2 py-1 font-semibold ${
                          (coordSortDir ?? "none") === v
                            ? "border-brand bg-brand text-white"
                            : "border-slate-200 text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {!coordListLines ? (
                <p className="rounded-lg bg-amber-50 px-4 py-3 text-amber-700">
                  Import points under Data Import first — this groups every point by its Type (Govt Trig Station,
                  Reference Mark, Working Station, Beacon) into one labelled coordinate schedule.
                </p>
              ) : (
                <>
                  {COORD_LIST_GROUPS.map((g) => {
                    let rows = coordListRows.filter((r) => r.east != null && r.north != null && (r.pointType ?? "beacon") === (g.key as PointType));
                    if (coordSortDir) {
                      rows = [...rows].sort((a, b) => comparePointNames(a.beaconId ?? "", b.beaconId ?? ""));
                      if (coordSortDir === "desc") rows.reverse();
                    }
                    if (!rows.length) return null;
                    return (
                      <div key={g.key}>
                        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{g.label}</div>
                        <table className="w-full border-collapse text-sm">
                          <thead>
                            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                              <th className="py-2 pr-3">Point</th>
                              <th className="py-2 pr-3">Eastings(Y)</th>
                              <th className="py-2 pr-3">Northings(X)</th>
                              <th className="py-2 pr-3">Description</th>
                              <th className="py-2">SR NO</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((r) => (
                              <tr key={r.index} className="border-b border-slate-100">
                                <td className="py-2 pr-3 font-medium text-slate-700">{r.beaconId ?? "—"}</td>
                                <td className="py-2 pr-3 tabular-nums text-slate-600">{(r.east as number).toFixed(2)}</td>
                                <td className="py-2 pr-3 tabular-nums text-slate-600">{(r.north as number).toFixed(2)}</td>
                                <td className="py-2 pr-3 text-slate-600">
                                  <input
                                    value={r.description ?? ""}
                                    onChange={(e) => setPointMeta(r.index, { description: e.target.value })}
                                    placeholder="e.g. 12mm Iron Peg"
                                    className="w-full rounded border border-slate-200 px-2 py-1 text-sm"
                                  />
                                </td>
                                <td className="py-2 text-slate-600">
                                  <input
                                    value={r.srNo ?? ""}
                                    onChange={(e) => setPointMeta(r.index, { srNo: e.target.value })}
                                    placeholder="-"
                                    className="w-20 rounded border border-slate-200 px-2 py-1 text-sm"
                                  />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })}
                  <Button variant="ghost" onClick={downloadCoordinateListReport}>⬇ Download as .txt</Button>
                </>
              )}
            </div>
          )}
          {doc === "comparison" && <DataComparison cogoResult={fig} discipline={config.discipline} />}
        </div>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 1. Submission letter                                                        */
/* -------------------------------------------------------------------------- */
function SubmissionLetter({
  toBlock,
  date,
  lotNumber,
  tribalArea,
  checklist,
  surveyor,
}: {
  toBlock: string;
  date: string;
  lotNumber: string;
  tribalArea: string;
  checklist: ChecklistItem[];
  surveyor: string;
}) {
  const toLines = toBlock.split("\n").filter(Boolean);
  return (
    <div className="space-y-4">
      <div>
        {toLines.map((line, i) => (
          <div key={i}>{i === 0 ? `To: ${line}` : line}</div>
        ))}
      </div>
      <div>Date {date}</div>
      <p>Dear Sir/Madam:</p>
      <p className="font-semibold text-slate-800">Re: SUBMISSION OF LOT {lotNumber.toUpperCase()}</p>
      <p>
        Herewith, please find enclosed, compilation Record in respect of Lot {lotNumber}
        {tribalArea ? ` in the ${tribalArea}` : ""}. The record consists of:
      </p>
      {/* Two-column checklist (client req 2026-08-27: "so many lines going
          down") — inline styles, not Tailwind classes, so the compact layout
          survives the print popup too, which doesn't load Tailwind's
          stylesheet (see printDoc() above). */}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: "32px", rowGap: "4px" }}>
        {checklist.filter((c) => c.checked && c.text.trim()).map((c, i) => (
          <li key={i}>☑ {c.text}</li>
        ))}
      </ul>
      <p>Yours Faithfully</p>
      <div className="sign space-y-1 pt-8">
        <hr className="sep w-56 border-slate-300" />
        <div className="font-semibold text-slate-800">{surveyor}</div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. Report on Survey                                                         */
/* -------------------------------------------------------------------------- */
function ReportOnSurvey({
  surveyor,
  assistedBy,
  dateOfSurvey,
  purpose,
  authority,
  calcBasis,
  method,
}: {
  surveyor: string;
  assistedBy: string;
  dateOfSurvey: string;
  purpose: string;
  authority: string;
  calcBasis: string;
  method: string;
}) {
  return (
    <div className="space-y-3">
      <h1 className="text-base font-bold text-slate-800">REPORT ON SURVEY</h1>
      {/* Inline style (not a Tailwind class) so the column alignment survives
          both on-screen rendering and the print popup, which doesn't load
          Tailwind's stylesheet — plain-text spaces otherwise collapse to one. */}
      {/* <strong>, not a Tailwind class, so the bold survives the print
          popup too (client req 2026-08-27: labels bold, values regular,
          matching the reference format). */}
      <div style={{ whiteSpace: "pre" }}><strong>Land Surveyor : </strong>{surveyor}</div>
      <div style={{ whiteSpace: "pre" }}><strong>Assisted by   : </strong>{assistedBy || "—"}</div>
      <div style={{ whiteSpace: "pre" }}><strong>Date of Survey: </strong>{dateOfSurvey || "—"}</div>

      <h2 className="text-sm font-semibold text-slate-800">Survey Report</h2>
      <p><strong>1. Purpose:</strong> {purpose}</p>
      <p><strong>2. Authority:</strong> {authority || "—"}</p>
      <p><strong>3. Calculation Basis:</strong> {calcBasis || "—"}</p>
      <div style={{ whiteSpace: "pre-wrap" }}><strong>4. Method:</strong> {method || "—"}</div>
      <p>
        <strong>5. Certificate:</strong> I certify that the checks enumerated under prescribed checks Para 3.1 have been completed
        and that the relevant check sheets are attached to the survey record.
      </p>

      <div className="sign space-y-3 pt-8">
        <div style={{ whiteSpace: "pre" }}>SIGNED: ____________________________</div>
        <div style={{ whiteSpace: "pre" }}>DATE:{" ".repeat(3)}____________________________</div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 3. Data Comparison                                                          */
/* -------------------------------------------------------------------------- */
function DataComparison({
  cogoResult,
  discipline,
}: {
  cogoResult: ReturnType<typeof useStore>["cogoResult"];
  discipline: import("@/lib/store").Discipline;
}) {
  if (!cogoResult) {
    return (
      <div className="space-y-3">
        <h1 className="text-base font-bold text-slate-800">Data Comparison</h1>
        <p className="rounded-lg bg-amber-50 px-4 py-3 text-amber-700">Run the {cogoTabLabel(discipline)} first.</p>
      </div>
    );
  }
  const hasCorrections = cogoResult.residuals.some(
    (r) => r.correction_east !== undefined || r.correction_north !== undefined || r.v_distance !== undefined
  );
  const residualByLeg = new Map(cogoResult.residuals.map((r) => [r.leg, r]));

  return (
    <div className="space-y-3">
      <h1 className="text-base font-bold text-slate-800">Data Comparison</h1>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="py-2 pr-3">Leg</th>
            <th className="py-2 pr-3">Bearing</th>
            <th className="py-2 pr-3 right">Distance</th>
            <th className="py-2 pr-3 right">&Delta;East adj</th>
            <th className="py-2 right">&Delta;North adj</th>
            {hasCorrections && <th className="py-2 right">Correction</th>}
          </tr>
        </thead>
        <tbody>
          {cogoResult.legs.map((leg) => {
            const res = residualByLeg.get(leg.index);
            const corr =
              res?.correction_east !== undefined || res?.correction_north !== undefined
                ? `E ${fmt(res?.correction_east, 4)} / N ${fmt(res?.correction_north, 4)}`
                : res?.v_distance !== undefined
                ? fmt(res.v_distance, 4)
                : "—";
            return (
              <tr key={leg.index} className="border-b border-slate-100">
                <td className="py-2 pr-3 font-medium text-slate-700">
                  {leg.from ?? "?"} &rarr; {leg.to ?? "?"}
                </td>
                <td className="py-2 pr-3 text-slate-600">{leg.bearing_dms}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-600">{fmt(leg.distance)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-600">{fmt(leg.d_east_adj)}</td>
                <td className="py-2 text-right tabular-nums text-slate-600">{fmt(leg.d_north_adj)}</td>
                {hasCorrections && (
                  <td className="py-2 text-right tabular-nums text-slate-600">{corr}</td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="rounded-lg bg-slate-50 px-4 py-3 text-xs text-slate-600">
        Misclosure (before adjustment): &Delta;E {fmt(cogoResult.closure.misclose_east)} m, &Delta;N{" "}
        {fmt(cogoResult.closure.misclose_north)} m &middot; Linear misclosure{" "}
        {fmt(cogoResult.closure.linear_misclosure)} m &middot; Total distance{" "}
        {fmt(cogoResult.closure.total_distance)} m &middot; Relative precision{" "}
        {cogoResult.closure.relative_precision_text}
      </div>
    </div>
  );
}
