"use client";

import { useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { Badge, Button, Card, Field, Input, Stat } from "@/components/ui";
import type { ParcelDoc } from "@/lib/types";

type DocId = "submission" | "report" | "consistency" | "coordinates" | "comparison";

const DOCS: { id: DocId; label: string; blurb: string }[] = [
  { id: "submission", label: "Submission Letter", blurb: "Formal covering letter lodging the survey with the approving authority." },
  { id: "report", label: "Report on Survey", blurb: "Narrative report describing the survey, method, closure and area." },
  { id: "consistency", label: "Data Consistency", blurb: "QA / DSM compliance checks confirming the data is internally consistent." },
  { id: "coordinates", label: "Coordinate List", blurb: "Numbered schedule of all computed beacon coordinates." },
  { id: "comparison", label: "Data Comparison", blurb: "Leg-by-leg bearing, distance and adjustment comparison with misclosure summary." },
];

function fmt(n: number | null | undefined, dp = 3): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toFixed(dp);
}

function severityLabel(sev: "pass" | "warning" | "error"): string {
  return sev === "pass" ? "Passed" : sev === "warning" ? "Warning" : "Error";
}

export function SurveyRecord() {
  const { config, cogoResult, validation, importResult, parcelDoc } = useStore();
  const pd = parcelDoc as ParcelDoc | null;

  const [doc, setDoc] = useState<DocId>("submission");
  const [date, setDate] = useState(() => new Date().toLocaleDateString());
  const [fileNo, setFileNo] = useState("");
  const [addressee, setAddressee] = useState("The Director, Department of Surveys and Mapping");

  const docRef = useRef<HTMLDivElement>(null);

  const lotName = config.name || "the surveyed property";
  const surveyor = config.surveyor || "Land Surveyor";

  /** Print the currently-displayed document block (its rendered HTML). */
  function printDoc() {
    if (!docRef.current) return;
    const w = window.open("", "_blank", "width=900,height=1100");
    if (!w) return;
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

  // --- Coordinate list source resolution (cogo → parcelDoc → importResult) ---
  const coordRows: { label: string; east: number; north: number }[] = (() => {
    if (cogoResult?.points?.length) {
      return cogoResult.points.map((p, i) => ({
        label: p.name ?? `P${i + 1}`,
        east: p.east,
        north: p.north,
      }));
    }
    if (pd?.beacons?.length) {
      return pd.beacons.map((b) => ({ label: b.id, east: b.east, north: b.north }));
    }
    if (importResult?.rows?.length) {
      return importResult.rows
        .filter((r) => r.east !== null && r.north !== null)
        .map((r, i) => ({ label: r.beaconId ?? `P${i + 1}`, east: r.east as number, north: r.north as number }));
    }
    return [];
  })();

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

      {/* Editable letter fields */}
      <Card title="Document details">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Date"><Input value={date} onChange={setDate} placeholder="e.g. 15 June 2026" /></Field>
          <Field label="File / Reference No."><Input value={fileNo} onChange={setFileNo} placeholder="e.g. SR 1234" /></Field>
          <Field label="Addressee"><Input value={addressee} onChange={setAddressee} /></Field>
        </div>
      </Card>

      {/* Rendered, printable document block */}
      <Card>
        <div ref={docRef} className="space-y-4 text-sm text-slate-700">
          {doc === "submission" && (
            <SubmissionLetter
              addressee={addressee}
              date={date}
              fileNo={fileNo}
              lotName={lotName}
              surveyor={surveyor}
              discipline={config.discipline}
            />
          )}
          {doc === "report" && (
            <ReportOnSurvey
              date={date}
              fileNo={fileNo}
              lotName={lotName}
              surveyor={surveyor}
              config={config}
              cogoResult={cogoResult}
              validationNarrative={validation?.narrative}
            />
          )}
          {doc === "consistency" && <DataConsistency validation={validation} />}
          {doc === "coordinates" && (
            <CoordinateList rows={coordRows} coordinateSystem={config.coordinateSystem} lotName={lotName} />
          )}
          {doc === "comparison" && <DataComparison cogoResult={cogoResult} />}
        </div>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 1. Submission letter                                                        */
/* -------------------------------------------------------------------------- */
function SubmissionLetter({
  addressee,
  date,
  fileNo,
  lotName,
  surveyor,
  discipline,
}: {
  addressee: string;
  date: string;
  fileNo: string;
  lotName: string;
  surveyor: string;
  discipline: string;
}) {
  return (
    <div className="space-y-4">
      <h1 className="text-base font-bold text-slate-800">Submission Letter</h1>
      <div className="flex justify-between text-slate-600">
        <div className="whitespace-pre-line">{addressee}</div>
        <div className="text-right">
          <div>{date}</div>
          {fileNo && <div className="muted">File No.: {fileNo}</div>}
        </div>
      </div>
      <p className="font-semibold text-slate-800">
        RE: SUBMISSION OF THE {discipline.toUpperCase()} SURVEY OF {lotName.toUpperCase()}
      </p>
      <p>Dear Sir / Madam,</p>
      <p>
        I respectfully submit for your examination and approval the records of the {discipline.toLowerCase()} survey
        of <strong>{lotName}</strong>. The survey has been carried out and computed in accordance with the
        applicable Survey Regulations and the standards of the Department of Surveys and Mapping.
      </p>
      <p>
        Enclosed for your consideration are the Report on Survey, the data-consistency (compliance) checks, the
        schedule of computed coordinates, and the data-comparison (closure and adjustment) record. I confirm that
        the survey has been examined for consistency and that the field measurements have been adjusted and reduced
        to the project coordinate system.
      </p>
      <p>I trust the submission is in order and look forward to your approval.</p>
      <p>Yours faithfully,</p>
      <div className="sign space-y-1 pt-8">
        <hr className="sep w-56 border-slate-300" />
        <div className="font-semibold text-slate-800">{surveyor}</div>
        <div className="muted text-slate-500">Land Surveyor</div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. Report on Survey                                                         */
/* -------------------------------------------------------------------------- */
function ReportOnSurvey({
  date,
  fileNo,
  lotName,
  surveyor,
  config,
  cogoResult,
  validationNarrative,
}: {
  date: string;
  fileNo: string;
  lotName: string;
  surveyor: string;
  config: { coordinateSystem: string; discipline: string; traverseType: string; adjustment: string };
  cogoResult: ReturnType<typeof useStore>["cogoResult"];
  validationNarrative?: string;
}) {
  const beaconCount = cogoResult?.points.length ?? 0;
  return (
    <div className="space-y-3">
      <h1 className="text-base font-bold text-slate-800">Report on Survey</h1>
      <div className="muted text-xs text-slate-500">
        {lotName} · {date}
        {fileNo ? ` · File No. ${fileNo}` : ""}
      </div>

      <h2 className="text-sm font-semibold text-slate-800">1. Introduction</h2>
      <p>
        This report describes the {config.discipline.toLowerCase()} survey of <strong>{lotName}</strong>. The survey
        was computed on the <strong>{config.coordinateSystem}</strong> coordinate system.
      </p>

      <h2 className="text-sm font-semibold text-slate-800">2. Method of Survey</h2>
      <p>
        The survey was observed as a <strong>{config.traverseType}</strong> traverse and reduced using the{" "}
        <strong>{config.adjustment}</strong> adjustment method.{" "}
        {beaconCount > 0
          ? `A total of ${beaconCount} beacon${beaconCount === 1 ? "" : "s"} was computed and adjusted.`
          : ""}
      </p>

      {cogoResult ? (
        <>
          <h2 className="text-sm font-semibold text-slate-800">3. Accuracy &amp; Closure</h2>
          <p>
            The traverse achieved a relative precision of{" "}
            <strong>{cogoResult.closure.relative_precision_text}</strong>, with a linear misclosure of{" "}
            <strong>{fmt(cogoResult.closure.linear_misclosure)} m</strong> over a total measured distance of{" "}
            <strong>{fmt(cogoResult.closure.total_distance)} m</strong>.
          </p>

          <h2 className="text-sm font-semibold text-slate-800">4. Area</h2>
          <p>
            The computed area of the figure is{" "}
            <strong>{fmt(cogoResult.area_ha, 4)} ha</strong>{" "}
            (<strong>{fmt(cogoResult.area_m2, 2)} m&sup2;</strong>).
          </p>

          {validationNarrative && (
            <>
              <h2 className="text-sm font-semibold text-slate-800">5. Survey QA Narrative</h2>
              <p className="whitespace-pre-wrap">{validationNarrative}</p>
            </>
          )}
        </>
      ) : (
        <p className="rounded-lg bg-amber-50 px-4 py-3 text-amber-700">
          No computed figure yet. Run the COGO Engine to populate the closure, precision and area sections of this
          report.
        </p>
      )}

      <div className="sign space-y-1 pt-8">
        <hr className="sep w-56 border-slate-300" />
        <div className="font-semibold text-slate-800">{surveyor}</div>
        <div className="muted text-slate-500">Land Surveyor</div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 3. Data Consistency                                                         */
/* -------------------------------------------------------------------------- */
function DataConsistency({ validation }: { validation: ReturnType<typeof useStore>["validation"] }) {
  if (!validation) {
    return (
      <div className="space-y-3">
        <h1 className="text-base font-bold text-slate-800">Data Consistency</h1>
        <p className="rounded-lg bg-amber-50 px-4 py-3 text-amber-700">
          Run AI Validate to populate consistency checks.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <h1 className="text-base font-bold text-slate-800">Data Consistency</h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat value={`${validation.overallScore}%`} label="Overall score" tone="brand" />
        <Stat value={validation.passed} label="Passed" tone="brand" />
        <Stat value={validation.warnings} label="Warnings" tone="warning" />
        <Stat value={validation.errors} label="Errors" tone={validation.errors ? "error" : "default"} />
        <Stat
          value={validation.dsmCompliant ? "Yes" : "No"}
          label="DSM compliant"
          tone={validation.dsmCompliant ? "brand" : "error"}
        />
      </div>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="py-2 pr-3">Rule</th>
            <th className="py-2 pr-3">Severity</th>
            <th className="py-2">Message</th>
          </tr>
        </thead>
        <tbody>
          {validation.checks.map((chk, i) => (
            <tr key={i} className="border-b border-slate-100 align-top">
              <td className="py-2 pr-3 font-medium text-slate-700">{chk.rule}</td>
              <td className="py-2 pr-3">
                <Badge kind={chk.severity}>{severityLabel(chk.severity)}</Badge>
              </td>
              <td className="py-2 text-slate-600">{chk.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 4. Coordinate list                                                          */
/* -------------------------------------------------------------------------- */
function CoordinateList({
  rows,
  coordinateSystem,
  lotName,
}: {
  rows: { label: string; east: number; north: number }[];
  coordinateSystem: string;
  lotName: string;
}) {
  return (
    <div className="space-y-3">
      <h1 className="text-base font-bold text-slate-800">Coordinate List</h1>
      <p className="muted text-xs text-slate-500">
        {lotName} · Coordinate system: {coordinateSystem}
      </p>
      {rows.length === 0 ? (
        <p className="rounded-lg bg-amber-50 px-4 py-3 text-amber-700">
          No coordinates available. Run the COGO Engine, construct parcels, or import survey data first.
        </p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="py-2 pr-3 right">#</th>
              <th className="py-2 pr-3">Beacon</th>
              <th className="py-2 pr-3 right">Y / East</th>
              <th className="py-2 right">X / North</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.label}-${i}`} className="border-b border-slate-100">
                <td className="py-2 pr-3 text-right text-slate-500">{i + 1}</td>
                <td className="py-2 pr-3 font-medium text-slate-700">{r.label}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-600">{fmt(r.east)}</td>
                <td className="py-2 text-right tabular-nums text-slate-600">{fmt(r.north)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 5. Data Comparison                                                          */
/* -------------------------------------------------------------------------- */
function DataComparison({ cogoResult }: { cogoResult: ReturnType<typeof useStore>["cogoResult"] }) {
  if (!cogoResult) {
    return (
      <div className="space-y-3">
        <h1 className="text-base font-bold text-slate-800">Data Comparison</h1>
        <p className="rounded-lg bg-amber-50 px-4 py-3 text-amber-700">Run the COGO Engine first.</p>
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
