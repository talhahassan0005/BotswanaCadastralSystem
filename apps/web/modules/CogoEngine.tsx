"use client";

import { useMemo, useState } from "react";
import { apiJson } from "@/lib/api";
import { useStore } from "@/lib/store";
import type { CogoResult } from "@/lib/types";
import { Button, Card, Field, Input, Select } from "@/components/ui";
import { CogoTools, type ToolId } from "@/components/CogoTools";
import { CogoWorkspace } from "@/components/CogoWorkspace";
import { COORDINATE_SYSTEM_OPTIONS } from "@/lib/crsOptions";

export function CogoEngine() {
  const { config, setConfig, importResult, cogoResult, setCogoResult, setActiveTab } = useStore();
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [tool, setTool] = useState<ToolId | null>(null);
  // Points a COGO tool (Forward / Intersection) computed and the user chose to
  // plot — shown on the work station canvas alongside the imported points.
  const [toolPoints, setToolPoints] = useState<{ name: string; east: number; north: number }[]>([]);
  const [endE, setEndE] = useState(""); // known end-station coords (link traverse)
  const [endN, setEndN] = useState("");

  // Build traverse legs from the imported rows (each row carries the leg leaving it).
  const legs = useMemo(() => {
    if (!importResult) return [];
    const rows = importResult.rows;
    // Beacons that carry a usable leg (have bearing + non-zero distance).
    const valid = rows.filter((r) => r.bearing && r.distance && r.distance > 0);
    // The closing leg returns to the beacon that actually anchors the geometry
    // (the first row WITH coordinates) — not necessarily rows[0].
    const startName = rows.find((x) => x.east != null && x.north != null)?.beaconId ?? rows[0]?.beaconId ?? "start";
    const out: { bearing: string; distance: number; from_name: string; to_name: string }[] = [];
    for (let i = 0; i < valid.length; i++) {
      const r = valid[i];
      const next = valid[i + 1];
      // For a closed loop the final leg returns to the start beacon; for an
      // open/link traverse it ends at the last station (no wrap-around).
      const toName =
        next?.beaconId ??
        (config.traverseType === "closed" ? startName : "end");
      out.push({
        bearing: r.bearing!,
        distance: r.distance!,
        from_name: r.beaconId ?? `P${i + 1}`,
        to_name: toName,
      });
    }
    return out;
  }, [importResult, config.traverseType]);

  const startPoint = useMemo(() => {
    const r = importResult?.rows.find((x) => x.east != null && x.north != null);
    return r ? { east: r.east!, north: r.north!, name: r.beaconId } : null;
  }, [importResult]);

  // Points that already have coordinates (for coordinate-only imports, e.g. an X,Y(,Z) list).
  // Only PLOT BEACONS form the figure — working points and reference marks are
  // control, not part of the parcel boundary, so they are excluded here.
  const coordPoints = useMemo(
    () =>
      (importResult?.rows ?? [])
        .filter((r) => r.east != null && r.north != null && (r.pointType ?? "beacon") === "beacon")
        .map((r) => ({ east: r.east as number, north: r.north as number, name: r.beaconId })),
    [importResult]
  );
  // Only plot beacons on the Cadastral work station (client req 2026-08-21,
  // revising Part 12b): working points and reference marks are both control
  // data, not the boundary being surveyed, and clutter the drawing — neither
  // should appear here. They stay in importResult (nothing is deleted), just
  // excluded from this view; working points still anchor the legs/startPoint
  // computation below, which is unaffected by this display-only filter.
  const workspacePoints = useMemo(
    () =>
      (importResult?.rows ?? [])
        .filter((r) => r.east != null && r.north != null && (r.pointType ?? "beacon") === "beacon")
        .map((r) => ({ east: r.east as number, north: r.north as number, name: r.beaconId })),
    [importResult]
  );
  // Working points / reference marks that were excluded from the figure.
  const excludedControl = useMemo(
    () => (importResult?.rows ?? []).filter((r) => r.east != null && r.north != null && (r.pointType ?? "beacon") !== "beacon").length,
    [importResult]
  );

  // A coordinate list (points, no bearing/distance legs) is a Parcels job, not a
  // COGO traverse — guide the user there with a friendly notice instead of a red
  // error or a wrong polygon built from every point.
  const coordinateOnly = legs.length < 2 && coordPoints.length >= 3;

  // The computed boundary, handed to the work station canvas so "Run COGO
  // Computation" actually draws it there — not just in the results tables
  // below (client req 2026-08-21, Part 13a). Memoized so CogoWorkspace's
  // injection effect only fires when the result itself changes, not on
  // every unrelated re-render.
  const resultBoundary = useMemo(
    () => (cogoResult ? { points: cogoResult.points, legs: cogoResult.legs, closed: cogoResult.type !== "open" } : null),
    [cogoResult]
  );

  async function run() {
    setError(null);
    setRunning(true);
    try {
      let result: CogoResult;
      if (startPoint && legs.length >= 2) {
        // Observation traverse: compute coordinates from bearing + distance.
        const endEastNum = Number(endE);
        const endNorthNum = Number(endN);
        const endKnown =
          config.traverseType === "link" &&
          endE.trim() !== "" &&
          endN.trim() !== "" &&
          Number.isFinite(endEastNum) &&
          Number.isFinite(endNorthNum)
            ? { east: endEastNum, north: endNorthNum }
            : undefined;
        if (config.traverseType === "link" && !endKnown) {
          setError("Link traverse needs valid numeric END station coordinates (East and North) — enter them in the 'Known end station' fields below.");
          setRunning(false);
          return;
        }
        result = await apiJson<CogoResult>("/cogo/traverse", {
          start: startPoint,
          legs,
          type: config.traverseType,
          adjustment: config.adjustment,
          end_known: endKnown,
        });
      } else if (coordPoints.length >= 3) {
        // Coordinate-only import (X,Y[,Z]) — no bearings/distances needed. Build the
        // figure directly from the points (sides via inverse, exact closure).
        result = await apiJson<CogoResult>("/cogo/coordinates", {
          points: coordPoints,
          type: config.traverseType,
        });
      } else {
        setError(
          "Import survey data first — either bearing + distance observations (a traverse) or at least 3 point coordinates (East, North)."
        );
        setRunning(false);
        return;
      }
      setCogoResult(result);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  }

  const c = cogoResult?.closure;
  const limit = config.dsmLimit;
  // Closure tolerance as an absolute distance instead of a 1:N ratio (client
  // req 2026-08-21, Part 13c) — e.g. "0.03" meaning 0.03 m allowable misclosure.
  const absoluteMode = config.dsmLimitMode === "absolute";
  const absoluteTolerance = config.dsmLimitAbsolute ?? 0.03;
  const isOpen = cogoResult?.type === "open";
  const precision = c?.relative_precision ?? null;
  const linear = c?.linear_misclosure ?? 0;
  // Largest correction any leg received. When this is below display resolution
  // (~5 mm), every adjustment method lands on the same coordinates — the reason
  // a near-perfect traverse looks unchanged when the method is switched.
  const maxResidual = Math.max(0, ...(cogoResult?.residuals.map((r) => r.magnitude) ?? [0]));
  const adjustmentNegligible = !isOpen && cogoResult?.adjustment !== "none" && maxResidual < 0.005;

  // Closure status:
  //  - open traverse has no closure concept              -> "na"
  //  - ~zero misclosure                                   -> "exact" (best case, either mode)
  //  - absolute mode: linear misclosure <= tolerance       -> "pass"
  //  - ratio mode: precision >= DSM limit                  -> "pass"
  //  - otherwise                                           -> "fail"
  const closureStatus: "na" | "exact" | "pass" | "fail" = isOpen
    ? "na"
    : linear < 1e-6
    ? "exact"
    : absoluteMode
    ? linear <= absoluteTolerance
      ? "pass"
      : "fail"
    : precision == null
    ? "fail"
    : precision >= limit
    ? "pass"
    : "fail";
  const closureGood = closureStatus === "pass" || closureStatus === "exact";
  const pct =
    closureStatus === "na"
      ? 0
      : closureStatus === "fail" && absoluteMode
      ? Math.min(100, Math.round((absoluteTolerance / Math.max(linear, 1e-9)) * 100))
      : closureStatus === "fail" && precision
      ? Math.min(100, Math.round((precision / limit) * 100))
      : 100;
  const closureMessage =
    closureStatus === "na"
      ? "Not applicable — open traverse"
      : closureStatus === "exact"
      ? "Exact closure (no misclosure)"
      : closureStatus === "pass"
      ? "Within DSM allowable closure"
      : "Exceeds DSM allowable closure";

  return (
    <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
      {/* Left control panel */}
      <div className="space-y-4">
        <Card title="Project Details">
          <div className="space-y-3">
            <Field label="Survey / project name">
              <Input value={config.name} onChange={(v) => setConfig({ name: v })} placeholder="e.g. Subdivision of Lot 14182" />
            </Field>
            <Field label="Land surveyor">
              <Input value={config.surveyor} onChange={(v) => setConfig({ surveyor: v })} placeholder="e.g. G. G. Sesinyi" />
            </Field>
            <Field label="Closure tolerance">
              <div className="mb-1.5 flex gap-3 text-xs text-slate-600">
                <label className="flex items-center gap-1">
                  <input type="radio" name="dsm-mode" checked={!absoluteMode} onChange={() => setConfig({ dsmLimitMode: "ratio" })} />
                  Ratio (1:N)
                </label>
                <label className="flex items-center gap-1">
                  <input type="radio" name="dsm-mode" checked={absoluteMode} onChange={() => setConfig({ dsmLimitMode: "absolute" })} />
                  Absolute (m)
                </label>
              </div>
              {absoluteMode ? (
                <Input
                  type="number"
                  value={config.dsmLimitAbsolute ?? 0.03}
                  onChange={(v) => setConfig({ dsmLimitAbsolute: Number(v) || 0 })}
                  placeholder="0.03"
                />
              ) : (
                <Input
                  type="number"
                  value={config.dsmLimit}
                  onChange={(v) => setConfig({ dsmLimit: Number(v) || 0 })}
                  placeholder="3000"
                />
              )}
              <p className="mt-1 text-xs text-slate-400">
                {absoluteMode
                  ? "Allowable linear misclosure, in metres — e.g. 0.03."
                  : "Allowable closure denominator — e.g. 3000 means 1:3000."}
              </p>
            </Field>
          </div>
        </Card>

        <Card title="Computation Type">
          <div className="space-y-3">
            <Field label="Traverse type">
              <Select
                value={config.traverseType}
                onChange={(v) => setConfig({ traverseType: v as any })}
                options={[
                  { value: "closed", label: "Closed Traverse" },
                  { value: "link", label: "Link Traverse" },
                  { value: "open", label: "Open Traverse" },
                ]}
              />
            </Field>
            {config.traverseType === "link" && (
              <div className="grid grid-cols-2 gap-2">
                <Field label="Known end East"><Input type="number" value={endE} onChange={setEndE} placeholder="end Y" /></Field>
                <Field label="Known end North"><Input type="number" value={endN} onChange={setEndN} placeholder="end X" /></Field>
              </div>
            )}
            <Field label="Adjustment method">
              <Select
                value={config.adjustment}
                onChange={(v) => setConfig({ adjustment: v as any })}
                options={[
                  { value: "bowditch", label: "Bowditch Rule" },
                  { value: "transit", label: "Transit Rule" },
                  { value: "lsq", label: "Least Squares" },
                  { value: "none", label: "No adjustment" },
                ]}
              />
            </Field>
            <Field label="Coordinate system">
              <Select
                value={config.coordinateSystem}
                onChange={(v) => setConfig({ coordinateSystem: v })}
                options={COORDINATE_SYSTEM_OPTIONS}
              />
              <p className="mt-1 text-xs text-slate-400">
                Labels the survey documents (diagram, general plan). The planar traverse
                arithmetic — bearings, distances and area — is identical across systems.
              </p>
            </Field>
            <Field label="Starting beacon">
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                {startPoint?.name ?? "— import data —"}
              </div>
            </Field>
          </div>
          <div className="mt-4">
            <Button onClick={run} disabled={running} loading={running}>
              {running ? "Computing…" : "Run COGO Computation"}
            </Button>
          </div>
          {coordinateOnly && (
            <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
              The figure is built from the <strong>plot beacons</strong> only
              {excludedControl > 0
                ? ` — ${excludedControl} working point(s) / reference mark(s) are excluded (control, not part of the boundary).`
                : ". Tag any working points or reference marks in Data Import to keep them out of the figure."}
              {" "}To set boundary order or subdivide, use the{" "}
              <button type="button" onClick={() => setActiveTab("parcels")} className="font-medium text-brand underline">
                Parcels
              </button>{" "}
              tab.
            </div>
          )}
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </Card>

        <Card title="Quick Calculators">
          {/* Clarifying the "Other Tools" section (client req 2026-08-21,
              Part 13d) — each opens a stand-alone popup calculator for a
              one-off computation, separate from the Cadastral work
              station's own COGO Calculators tab (which plots its results
              directly onto the canvas below instead). */}
          <p className="mb-2 text-xs text-slate-400">
            Stand-alone one-off calculators — results shown here, not plotted on the canvas.
            To compute and draw directly on the work station, use its own COGO Calculators tab instead.
          </p>
          <div className="space-y-1.5 text-sm">
            {([
              ["inverse", "Forward / Inverse calc", "Bearing+distance from two points, or a new point from a bearing+distance"],
              ["intersection", "Intersection methods", "Where two rays/circles from known points cross"],
              ["curve", "Curve computations", "Circular curve arc, chord, tangent from radius + angle"],
              ["area", "Area calculations", "Area of a polygon, or a strip (length × width)"],
              ["transform", "Coordinate transform", "Convert coordinates between Lo/Arc1950/WGS84/UTM"],
            ] as [ToolId, string, string][]).map(([id, label, desc]) => (
              <button
                key={id}
                onClick={() => setTool(id)}
                title={desc}
                className="block w-full rounded-md px-2 py-1.5 text-left text-slate-600 hover:bg-brand-light/40 hover:text-brand-dark"
              >
                <span className="block font-medium">{label}</span>
                <span className="block text-xs text-slate-400">{desc}</span>
              </button>
            ))}
          </div>
        </Card>
      </div>

      <CogoTools tool={tool} onClose={() => setTool(null)} onAddPoint={(p) => setToolPoints((arr) => [...arr, p])} />

      {/* Right results */}
      <div className="space-y-5">
        <CogoWorkspace points={[...workspacePoints, ...toolPoints]} onTool={setTool} resultBoundary={resultBoundary} />

        {!cogoResult ? (
          <Card>
            <div className="py-12 text-center text-slate-400">
              <p className="text-lg">No computation yet</p>
              <p className="mt-1 text-sm">
                Import observations, then run the COGO computation to see closure results and the
                adjusted traverse table.
              </p>
            </div>
          </Card>
        ) : (
          <>
            {/* Clear/Delete auto result (client req 2026-08-21, Part 13b) — the
                automatic point-ordering can be wrong (e.g. producing a
                self-intersecting boundary); this discards both the result
                tables and whatever it drew on the canvas, so the user can
                rebuild the boundary manually with the Polygon tool or the
                Parcels tab's boundary-order tool instead. */}
            <div className="flex justify-end">
              <Button variant="ghost" onClick={() => setCogoResult(null)}>
                Clear Result
              </Button>
            </div>
            <div className="grid gap-5 md:grid-cols-2">
              <Card title="Closure Results">
                <dl className="space-y-2 text-sm">
                  <Row label="Linear misclosure" value={isOpen ? "—" : `${c!.linear_misclosure.toFixed(3)} m`} />
                  <Row label="ΔE / ΔN misclose" value={isOpen ? "—" : `${c!.misclose_east.toFixed(3)} / ${c!.misclose_north.toFixed(3)} m`} />
                  <Row
                    label="Relative precision"
                    value={isOpen ? "N/A (open)" : c!.relative_precision_text}
                    tone={closureStatus === "na" ? undefined : closureGood ? "good" : "bad"}
                  />
                  <Row label="Closure tolerance" value={absoluteMode ? `${absoluteTolerance.toFixed(3)} m` : `1:${limit.toLocaleString()}`} />
                </dl>
                <div className="mt-3">
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full ${closureStatus === "na" ? "bg-slate-300" : closureGood ? "bg-brand" : "bg-red-500"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <p className={`mt-1 text-xs ${closureStatus === "na" ? "text-slate-400" : closureGood ? "text-brand-dark" : "text-red-600"}`}>
                    {closureMessage}
                  </p>
                </div>
              </Card>

              <Card title="Adjustment Summary">
                <dl className="space-y-2 text-sm">
                  <Row label="Method applied" value={cogoResult.adjustment === "lsq" ? "Least Squares" : cap(cogoResult.adjustment)} />
                  <Row label="Legs adjusted" value={String(cogoResult.legs.length)} />
                  <Row label="Max residual" value={`${maxResidual.toFixed(3)} m`} />
                  {cogoResult.adjustment === "lsq" && (
                    <Row label="Reference σ₀" value={cogoResult.sigma0.toFixed(3)} />
                  )}
                  <Row label="Total perimeter" value={`${c!.total_distance.toFixed(2)} m`} />
                  <Row label="Computed area" value={`${cogoResult.area_ha.toFixed(4)} ha`} />
                </dl>
                {adjustmentNegligible && (
                  <p className="mt-3 text-xs text-slate-400">
                    Misclosure is negligible ({linear.toFixed(3)} m) — Bowditch, Transit and
                    Least-Squares all land on the same coordinates here. The method choice only
                    changes the result on traverses with larger misclosure.
                  </p>
                )}
              </Card>
            </div>

            <Card title="Adjusted Traverse Table">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase text-slate-500">
                    <tr>
                      <th className="py-2 pr-4">Leg</th>
                      <th className="py-2 pr-4">From → To</th>
                      <th className="py-2 pr-4">Bearing</th>
                      <th className="py-2 pr-4">Dist (m)</th>
                      <th className="py-2 pr-4">ΔE adj (m)</th>
                      <th className="py-2 pr-4">ΔN adj (m)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cogoResult.legs.map((lg) => (
                      <tr key={lg.index} className="border-t border-slate-100">
                        <td className="py-2 pr-4">{lg.index}</td>
                        <td className="py-2 pr-4 font-medium">
                          {lg.from} → {lg.to}
                        </td>
                        <td className="py-2 pr-4">{lg.bearing_dms}</td>
                        <td className="py-2 pr-4">{lg.distance.toFixed(2)}</td>
                        <td className="py-2 pr-4">{lg.d_east_adj >= 0 ? "+" : ""}{lg.d_east_adj.toFixed(2)}</td>
                        <td className="py-2 pr-4">{lg.d_north_adj >= 0 ? "+" : ""}{lg.d_north_adj.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 flex justify-end">
                <Button variant="ghost" onClick={() => setActiveTab("validate")}>
                  Run AI Validation →
                </Button>
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  const color = tone === "good" ? "text-brand-dark font-semibold" : tone === "bad" ? "text-red-600 font-semibold" : "text-slate-800";
  return (
    <div className="flex items-center justify-between">
      <dt className="text-slate-500">{label}</dt>
      <dd className={color}>{value}</dd>
    </div>
  );
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
