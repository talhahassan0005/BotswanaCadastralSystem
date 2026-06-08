"use client";

import { useMemo } from "react";
import { useStore } from "@/lib/store";
import { Badge, Button, Card } from "@/components/ui";

const D2R = Math.PI / 180;

export function Traverse() {
  const { cogoResult, importResult, config, setActiveTab } = useStore();

  const consistency = useMemo(() => {
    const checks: { rule: string; ok: boolean; detail: string }[] = [];
    if (importResult) {
      const ids = importResult.rows.map((r) => r.beaconId).filter(Boolean) as string[];
      const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
      checks.push({
        rule: "Duplicate beacon numbers",
        ok: dupes.length === 0,
        detail: dupes.length ? `Duplicates: ${[...new Set(dupes)].join(", ")}` : `${new Set(ids).size} unique beacons`,
      });
      const zero = importResult.rows.filter((r) => r.distance === 0);
      checks.push({
        rule: "Zero-distance observations",
        ok: zero.length === 0,
        detail: zero.length ? `${zero.length} row(s) with 0 m` : "none",
      });
      checks.push({
        rule: "Import errors",
        ok: importResult.errorCount === 0,
        detail: `${importResult.errorCount} error(s), ${importResult.warningCount} warning(s)`,
      });
    }
    if (cogoResult) {
      const bad = cogoResult.legs.filter((l) => l.bearing < 0 || l.bearing >= 360);
      checks.push({
        rule: "Bearings within 0°–360°",
        ok: bad.length === 0,
        detail: bad.length ? `${bad.length} out of range` : "all valid",
      });
    }
    return checks;
  }, [cogoResult, importResult]);

  if (!cogoResult) {
    return (
      <Card>
        <div className="py-12 text-center text-slate-500">
          <p className="text-lg">No traverse computed yet</p>
          <p className="mt-1 text-sm">Run a traverse in the COGO Engine to generate adjustment reports.</p>
          <div className="mt-4"><Button onClick={() => setActiveTab("cogo")}>Go to COGO Engine</Button></div>
        </div>
      </Card>
    );
  }

  const c = cogoResult.closure;
  const isOpen = cogoResult.type === "open";
  const precision = c.relative_precision;
  const within = precision != null && precision >= config.dsmLimit;
  const closureGood = isOpen || within || (precision == null && c.linear_misclosure < 1e-6);
  const isLsq = cogoResult.adjustment === "lsq";

  return (
    <div className="space-y-5">
      {/* 1. Closure Report */}
      <Card title="Closure Report" icon={<span>◎</span>}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 text-sm">
          <KV label="Traverse type" value={cap(cogoResult.type)} />
          <KV label="Total distance" value={`${c.total_distance.toFixed(3)} m`} />
          <KV label="Linear misclosure" value={isOpen ? "—" : `${c.linear_misclosure.toFixed(4)} m`} />
          <KV label="ΔE / ΔN misclose" value={isOpen ? "—" : `${c.misclose_east.toFixed(4)} / ${c.misclose_north.toFixed(4)}`} />
          <KV label="Relative precision" value={isOpen ? "N/A (open)" : c.relative_precision_text} tone={isOpen ? undefined : closureGood ? "good" : "bad"} />
          <KV label="DSM allowable" value={`1:${config.dsmLimit.toLocaleString()}`} />
          <KV label="Computed area" value={isOpen ? "—" : `${cogoResult.area_ha.toFixed(4)} ha`} />
          <KV label="Status" value={isOpen ? "Open — n/a" : closureGood ? "Within limit" : "Exceeds limit"} tone={isOpen ? undefined : closureGood ? "good" : "bad"} />
        </div>
      </Card>

      {/* 2. Adjustment Report */}
      <Card title={`Adjustment Report — ${isLsq ? "Least Squares" : cap(cogoResult.adjustment)}`} icon={<span>▤</span>}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="py-2 pr-4">Leg</th>
                <th className="py-2 pr-4">From → To</th>
                <th className="py-2 pr-4">Bearing</th>
                <th className="py-2 pr-4">Dist (m)</th>
                <th className="py-2 pr-4">ΔE raw</th>
                <th className="py-2 pr-4">ΔN raw</th>
                <th className="py-2 pr-4">ΔE adj</th>
                <th className="py-2 pr-4">ΔN adj</th>
              </tr>
            </thead>
            <tbody>
              {cogoResult.legs.map((l) => {
                const deRaw = l.distance * Math.sin(l.bearing * D2R);
                const dnRaw = l.distance * Math.cos(l.bearing * D2R);
                return (
                  <tr key={l.index} className="border-t border-slate-100">
                    <td className="py-2 pr-4">{l.index}</td>
                    <td className="py-2 pr-4 font-medium">{l.from} → {l.to}</td>
                    <td className="py-2 pr-4">{l.bearing_dms}</td>
                    <td className="py-2 pr-4">{l.distance.toFixed(2)}</td>
                    <td className="py-2 pr-4 text-slate-400">{deRaw.toFixed(3)}</td>
                    <td className="py-2 pr-4 text-slate-400">{dnRaw.toFixed(3)}</td>
                    <td className="py-2 pr-4">{l.d_east_adj.toFixed(3)}</td>
                    <td className="py-2 pr-4">{l.d_north_adj.toFixed(3)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {isLsq && <p className="mt-3 text-xs text-slate-400">Reference σ₀ = {cogoResult.sigma0.toFixed(4)} (a-posteriori; ≈1 for well-fitting observations).</p>}
      </Card>

      {/* 3. Residuals Report */}
      <Card title="Residuals Report" icon={<span>≈</span>}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="py-2 pr-4">Leg</th>
                <th className="py-2 pr-4">From → To</th>
                {isLsq ? (
                  <>
                    <th className="py-2 pr-4">v distance (m)</th>
                    <th className="py-2 pr-4">v direction (″)</th>
                  </>
                ) : (
                  <>
                    <th className="py-2 pr-4">Correction ΔE (m)</th>
                    <th className="py-2 pr-4">Correction ΔN (m)</th>
                  </>
                )}
                <th className="py-2 pr-4">Magnitude (m)</th>
              </tr>
            </thead>
            <tbody>
              {cogoResult.residuals.map((r) => (
                <tr key={r.leg} className="border-t border-slate-100">
                  <td className="py-2 pr-4">{r.leg}</td>
                  <td className="py-2 pr-4 font-medium">{r.from} → {r.to}</td>
                  {isLsq ? (
                    <>
                      <td className="py-2 pr-4">{(r.v_distance ?? 0).toFixed(4)}</td>
                      <td className="py-2 pr-4">{(r.v_direction_sec ?? 0).toFixed(1)}</td>
                    </>
                  ) : (
                    <>
                      <td className="py-2 pr-4">{(r.correction_east ?? 0).toFixed(4)}</td>
                      <td className="py-2 pr-4">{(r.correction_north ?? 0).toFixed(4)}</td>
                    </>
                  )}
                  <td className="py-2 pr-4">{r.magnitude.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* 4. Data Consistency Report */}
      <Card title="Data Consistency Report" icon={<span>✓</span>}>
        <div className="space-y-2">
          {consistency.map((chk, i) => (
            <div key={i} className="flex items-center justify-between border-b border-slate-100 pb-2 text-sm last:border-0">
              <span className="text-slate-700">{chk.rule}</span>
              <span className="flex items-center gap-3">
                <span className="text-xs text-slate-400">{chk.detail}</span>
                <Badge kind={chk.ok ? "pass" : "error"}>{chk.ok ? "OK" : "Check"}</Badge>
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function KV({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  const color = tone === "good" ? "text-brand-dark" : tone === "bad" ? "text-red-600" : "text-slate-800";
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
