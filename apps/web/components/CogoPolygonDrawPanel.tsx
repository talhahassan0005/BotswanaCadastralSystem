"use client";

import type { ReactNode } from "react";

// Side-docked "Draw Polygon" panel (client req 2026-09-24, full spec):
// "As I join a polygon there should be a window which shows which points
// I am joining" — "slightly similar to [the Points on Line panel]" — "in
// the other software they have something like [the reference tool's]
// Capture Consistencies [dialog]." Read-only/display-only (unlike Points
// on Line or Traverse, a polygon's vertices are placed purely by clicking
// the canvas, not typed here), so this is just a live readout: the leg
// currently being placed (from the last vertex to wherever the cursor
// is right now) plus the running list of legs already placed. The
// existing on-canvas dashed-line bearing/distance label stays exactly as
// it was — this panel is additional, persistent feedback alongside it,
// not a replacement.

interface PolygonLegRow {
  name: string;
  direction: string | null;
  distance: number | null;
}

export function CogoPolygonDrawPanel({
  fromName,
  direction,
  distance,
  rows,
  onClose,
}: {
  fromName: string | null;
  direction: string | null;
  distance: number | null;
  rows: PolygonLegRow[];
  onClose: () => void;
}) {
  return (
    <div className="flex w-80 flex-none flex-col border-l border-slate-200 bg-white text-xs">
      <div className="flex items-center justify-between border-b border-slate-200 px-2.5 py-1.5">
        <span className="font-semibold text-slate-700">Draw Polygon</span>
        <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700" title="Close (Esc)" aria-label="Close">✕</button>
      </div>

      {/* Current leg — From is the last vertex placed (or not started yet);
          To is always "click on canvas…" since the next vertex isn't
          picked until the user clicks it, same convention as Points on
          Line's From/To fields before they're set. Direction/Distance are
          live, from the last vertex to wherever the cursor is right now. */}
      <div className="grid grid-cols-2 gap-2 px-2.5 pt-2">
        <Field label="From">
          <div className="w-full truncate rounded border border-slate-200 bg-slate-50 px-1.5 py-1 text-slate-600">
            {fromName ?? "Click on canvas…"}
          </div>
        </Field>
        <Field label="To">
          <div className="w-full truncate rounded border border-slate-200 bg-slate-50 px-1.5 py-1 text-slate-400">
            Click on canvas…
          </div>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2 px-2.5 pt-2">
        <Field label="Direction">
          <input value={direction ?? ""} readOnly className="w-full rounded border border-slate-200 bg-slate-50 px-1.5 py-1 text-slate-500" />
        </Field>
        <Field label="Distance">
          <input value={distance != null ? `${distance.toFixed(3)}m` : ""} readOnly className="w-full rounded border border-slate-200 bg-slate-50 px-1.5 py-1 text-slate-500" />
        </Field>
      </div>

      {/* Points joined so far */}
      <div className="px-2.5 pt-2 text-slate-500">Points joined ({rows.length})</div>
      <div className="mx-2.5 mb-2.5 mt-1 max-h-64 overflow-y-auto rounded border border-slate-200 bg-slate-50 font-mono">
        {rows.length === 0 ? (
          <p className="px-2 py-2 text-slate-400">No vertices placed yet — click on the canvas to start.</p>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-slate-200 text-[10px] text-slate-400">
                <th className="px-2 py-1 font-normal">Point</th>
                <th className="px-2 py-1 font-normal">Direction</th>
                <th className="px-2 py-1 font-normal">Distance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="px-2 py-1">{r.name}</td>
                  <td className="px-2 py-1 text-slate-500">{r.direction ?? "—"}</td>
                  <td className="px-2 py-1 text-slate-500">{r.distance != null ? `${r.distance.toFixed(3)}m` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-slate-500">{label}</span>
      {children}
    </label>
  );
}
