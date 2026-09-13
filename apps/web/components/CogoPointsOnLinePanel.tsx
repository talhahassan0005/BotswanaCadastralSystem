"use client";

import type { ReactNode } from "react";

// Side-docked "Points on Line" panel (client req 2026-09-10/13) — mirrors
// the reference legacy desktop tool's "Points on Line Calculation" dialog:
// pick a From/To line (Direction/Distance auto-compute), queue multiple new
// points along it at chosen distances — each one previewed live on canvas
// before anything is committed — then Draw commits the whole queued batch
// at once and resets the dialog so the next line's batch can start right
// away. All state and canvas drawing lives in CogoWorkspace; this component
// is the form/list UI only, same split as CogoTraversePanel.

interface PolRowView {
  name: string;
  segDist: number;
  cumulative: number;
}

export function CogoPointsOnLinePanel({
  fromName,
  toName,
  direction,
  distance,
  residual,
  rows,
  selected,
  newName,
  newDistance,
  mode,
  autoCalc,
  addLines,
  pickingFrom,
  pickingTo,
  onPickFrom,
  onPickTo,
  onNewName,
  onNewDistance,
  onMode,
  onAutoCalc,
  onAddLines,
  onAdd,
  onInsert,
  onUpdate,
  onRemove,
  onUndo,
  onClear,
  onCalc,
  onSelectRow,
  onDraw,
  onClose,
}: {
  fromName: string | null;
  toName: string | null;
  direction: string;
  distance: number | null;
  residual: number | null;
  rows: PolRowView[];
  selected: number | null;
  newName: string;
  newDistance: string;
  mode: "individual" | "accumulative";
  autoCalc: boolean;
  addLines: boolean;
  pickingFrom: boolean;
  pickingTo: boolean;
  onPickFrom: () => void;
  onPickTo: () => void;
  onNewName: (v: string) => void;
  onNewDistance: (v: string) => void;
  onMode: (v: "individual" | "accumulative") => void;
  onAutoCalc: (v: boolean) => void;
  onAddLines: (v: boolean) => void;
  onAdd: () => void;
  onInsert: () => void;
  onUpdate: () => void;
  onRemove: () => void;
  onUndo: () => void;
  onClear: () => void;
  onCalc: () => void;
  onSelectRow: (i: number) => void;
  onDraw: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex w-80 flex-none flex-col border-l border-slate-200 bg-white text-xs">
      <div className="flex items-center justify-between border-b border-slate-200 px-2.5 py-1.5">
        <span className="font-semibold text-slate-700">Points on Line</span>
        <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700" title="Close (Esc)" aria-label="Close">✕</button>
      </div>

      {/* From / To + auto Direction/Distance */}
      <div className="grid grid-cols-2 gap-2 px-2.5 pt-2">
        <Field label="From">
          <button type="button" onClick={onPickFrom} className={`w-full truncate rounded border px-1.5 py-1 text-left ${pickingFrom ? "border-brand bg-brand-light/40 text-brand-dark" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
            {fromName ?? "Click on canvas…"}
          </button>
        </Field>
        <Field label="To">
          <button type="button" onClick={onPickTo} className={`w-full truncate rounded border px-1.5 py-1 text-left ${pickingTo ? "border-brand bg-brand-light/40 text-brand-dark" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
            {toName ?? "Click on canvas…"}
          </button>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2 px-2.5 pt-2">
        <Field label="Direction">
          <input value={direction} readOnly className="w-full rounded border border-slate-200 bg-slate-50 px-1.5 py-1 text-slate-500" />
        </Field>
        <Field label="Distance">
          <input value={distance != null ? distance.toFixed(3) : ""} readOnly className="w-full rounded border border-slate-200 bg-slate-50 px-1.5 py-1 text-slate-500" />
        </Field>
      </div>

      {/* Residual */}
      <div className="mx-2.5 mt-2 flex items-center justify-between rounded bg-brand-light/30 px-2 py-1.5 font-mono font-semibold text-brand-dark">
        <span>Residual</span>
        <span className={residual != null && residual < 0 ? "text-red-600" : undefined}>{residual != null ? residual.toFixed(3) : "—"}</span>
      </div>

      {/* Distance mode */}
      <div className="px-2.5 pt-2">
        {([
          ["individual", "Individual Distances"],
          ["accumulative", "Accumulative Dists."],
        ] as const).map(([id, label]) => (
          <label key={id} className="flex items-center gap-1.5 py-0.5 text-slate-600">
            <input type="radio" name="pol-mode" checked={mode === id} onChange={() => onMode(id)} />
            {label}
          </label>
        ))}
      </div>

      {/* New Name / Distance + Add */}
      <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2 px-2.5 pt-2">
        <Field label="New Name">
          <input value={newName} onChange={(e) => onNewName(e.target.value)} placeholder="auto" className="w-full rounded border border-slate-200 px-1.5 py-1 focus:border-brand focus:outline-none" />
        </Field>
        <Field label="Distance">
          <input value={newDistance} onChange={(e) => onNewDistance(e.target.value)} placeholder="m" className="w-full rounded border border-slate-200 px-1.5 py-1 focus:border-brand focus:outline-none" />
        </Field>
        <PBtn onClick={onAdd} primary disabled={!fromName || !toName || !newDistance.trim()}>Add</PBtn>
      </div>

      {/* Line Points list */}
      <div className="mx-2.5 mt-2 max-h-40 overflow-y-auto rounded border border-slate-200 bg-slate-50 font-mono">
        {rows.length === 0 ? (
          <p className="px-2 py-2 text-slate-400">No points queued yet — set From/To, then Distance, then Add.</p>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-slate-200 text-[10px] text-slate-400">
                <th className="px-2 py-1 font-normal">Name</th>
                <th className="px-2 py-1 font-normal">Dist</th>
                <th className="px-2 py-1 font-normal">Cum.</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={i}
                  onClick={() => onSelectRow(i)}
                  className={`cursor-pointer border-b border-slate-100 hover:bg-white ${selected === i ? "bg-brand-light/40" : ""}`}
                >
                  <td className="px-2 py-1">{r.name}</td>
                  <td className="px-2 py-1 text-slate-500">{r.segDist.toFixed(3)}</td>
                  <td className="px-2 py-1 text-slate-500">{r.cumulative.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Row edit buttons */}
      <div className="grid grid-cols-4 gap-1.5 px-2.5 py-2">
        <PBtn onClick={onInsert} disabled={selected == null}>Insert</PBtn>
        <PBtn onClick={onUpdate} disabled={selected == null}>Update</PBtn>
        <PBtn onClick={onRemove} disabled={selected == null}>Remove</PBtn>
        <PBtn onClick={onUndo} disabled={rows.length === 0}>Undo</PBtn>
      </div>

      {/* Automatic Calculation / Add Lines */}
      <div className="px-2.5 pb-1">
        <label className="flex items-center gap-1.5 py-0.5 text-slate-600">
          <input type="checkbox" checked={autoCalc} onChange={(e) => onAutoCalc(e.target.checked)} />
          Automatic Calculation
        </label>
        <label className="flex items-center gap-1.5 py-0.5 text-slate-600">
          <input type="checkbox" checked={addLines} onChange={(e) => onAddLines(e.target.checked)} />
          Add Lines
        </label>
      </div>

      {/* Calc / Clear / Draw */}
      <div className="grid grid-cols-3 gap-1.5 px-2.5 pb-2.5">
        <PBtn onClick={onCalc} disabled={autoCalc}>Calc</PBtn>
        <PBtn onClick={onClear} disabled={rows.length === 0}>Clear</PBtn>
        <PBtn onClick={onDraw} primary disabled={rows.length === 0}>Draw</PBtn>
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

function PBtn({
  children,
  onClick,
  primary,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border px-1.5 py-1 text-center font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
        primary
          ? "border-brand bg-brand text-white hover:bg-brand-dark"
          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
      }`}
    >
      {children}
    </button>
  );
}
