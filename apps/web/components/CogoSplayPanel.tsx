"use client";

import { useEffect, useState, type ReactNode } from "react";

// Side-docked "Splay Calculation" panel (client req 2026-09-19) — mirrors
// the reference legacy tool's own "Splay Calculation" dialog: cut a sharp
// corner (the Terminal point) with a chamfer between two new points placed
// along its two boundary edges (toward the Left and Right points), each at
// its own distance from the corner. Same split as CogoTraversePanel/
// CogoPointsOnLinePanel — all state and canvas drawing lives in
// CogoWorkspace, this component is form/UI only.

export function CogoSplayPanel({
  terminalName,
  leftName,
  rightName,
  pickingTerminal,
  pickingLeft,
  pickingRight,
  leftDist,
  rightDist,
  newLeftName,
  newRightName,
  splayType,
  addDiagonalLine,
  adjustLines,
  canDraw,
  onPickTerminal,
  onPickLeft,
  onPickRight,
  onTerminalName,
  onLeftName,
  onRightName,
  onLeftDist,
  onRightDist,
  onNewLeftName,
  onNewRightName,
  onSplayType,
  onAddDiagonalLine,
  onAdjustLines,
  onCalc,
  onClear,
  onUndo,
  onDraw,
  onZoom,
  onClose,
}: {
  terminalName: string | null;
  leftName: string | null;
  rightName: string | null;
  pickingTerminal: boolean;
  pickingLeft: boolean;
  pickingRight: boolean;
  leftDist: string;
  rightDist: string;
  newLeftName: string;
  newRightName: string;
  splayType: "splay" | "diagonal";
  addDiagonalLine: boolean;
  adjustLines: boolean;
  canDraw: boolean;
  onPickTerminal: () => void;
  onPickLeft: () => void;
  onPickRight: () => void;
  onTerminalName: (v: string) => void;
  onLeftName: (v: string) => void;
  onRightName: (v: string) => void;
  onLeftDist: (v: string) => void;
  onRightDist: (v: string) => void;
  onNewLeftName: (v: string) => void;
  onNewRightName: (v: string) => void;
  onSplayType: (v: "splay" | "diagonal") => void;
  onAddDiagonalLine: (v: boolean) => void;
  onAdjustLines: (v: boolean) => void;
  onCalc: () => void;
  onClear: () => void;
  onUndo: () => void;
  onDraw: () => void;
  onZoom: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex w-80 flex-none flex-col border-l border-slate-200 bg-white text-xs">
      <div className="flex items-center justify-between border-b border-slate-200 px-2.5 py-1.5">
        <span className="font-semibold text-slate-700">Splay Calculation</span>
        <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700" title="Close (Esc)" aria-label="Close">✕</button>
      </div>

      <div className="space-y-2 px-2.5 pt-2">
        <PickField label="Terminal" color="#0891b2" picking={pickingTerminal} name={terminalName} onPick={onPickTerminal} onName={onTerminalName} />
        <PickField label="Left" color="#059669" picking={pickingLeft} name={leftName} onPick={onPickLeft} onName={onLeftName} />
        <PickField label="Right" color="#7c3aed" picking={pickingRight} name={rightName} onPick={onPickRight} onName={onRightName} />
      </div>

      {/* "Splay Type" (client req: infer "Diagonal"'s distinct behaviour)
          — Diagonal is a single symmetric cut, so its own Right Distance
          field is locked to mirror Left Distance instead of being
          independently editable. */}
      <div className="px-2.5 pt-3">
        {([
          ["splay", "Splay"],
          ["diagonal", "Diagonal"],
        ] as const).map(([id, label]) => (
          <label key={id} className="flex items-center gap-1.5 py-0.5 text-slate-600">
            <input type="radio" name="splay-type" checked={splayType === id} onChange={() => onSplayType(id)} />
            {label}
          </label>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 px-2.5 pt-2">
        <Field label="Left Distance">
          <input value={leftDist} onChange={(e) => onLeftDist(e.target.value)} placeholder="m" className="w-full rounded border border-slate-200 px-1.5 py-1 focus:border-brand focus:outline-none" />
        </Field>
        <Field label="Right Distance">
          <input
            value={splayType === "diagonal" ? leftDist : rightDist}
            onChange={(e) => onRightDist(e.target.value)}
            disabled={splayType === "diagonal"}
            placeholder="m"
            className="w-full rounded border border-slate-200 px-1.5 py-1 focus:border-brand focus:outline-none disabled:bg-slate-50 disabled:text-slate-400"
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2 px-2.5 pt-2">
        <Field label="New Left Name">
          <input value={newLeftName} onChange={(e) => onNewLeftName(e.target.value)} placeholder="auto" className="w-full rounded border border-slate-200 px-1.5 py-1 focus:border-brand focus:outline-none" />
        </Field>
        <Field label="New Right Name">
          <input value={newRightName} onChange={(e) => onNewRightName(e.target.value)} placeholder="auto" className="w-full rounded border border-slate-200 px-1.5 py-1 focus:border-brand focus:outline-none" />
        </Field>
      </div>

      <div className="px-2.5 pt-3">
        <label className="flex items-center gap-1.5 py-0.5 text-slate-600">
          <input type="checkbox" checked={addDiagonalLine} onChange={(e) => onAddDiagonalLine(e.target.checked)} />
          Add Diagonal Line
        </label>
        <label className="flex items-center gap-1.5 py-0.5 text-slate-600">
          <input type="checkbox" checked={adjustLines} onChange={(e) => onAdjustLines(e.target.checked)} />
          Adjust Lines and Delete
        </label>
      </div>

      <div className="grid grid-cols-2 gap-1.5 px-2.5 py-2">
        <PBtn onClick={onCalc}>Calc</PBtn>
        <PBtn onClick={onClear}>Clear</PBtn>
        <PBtn onClick={onUndo}>Undo</PBtn>
        <PBtn onClick={onZoom}>Zoom</PBtn>
        <PBtn onClick={onDraw} primary disabled={!canDraw}>Draw</PBtn>
      </div>
    </div>
  );
}

function PickField({
  label,
  color,
  picking,
  name,
  onPick,
  onName,
}: {
  label: string;
  color: string;
  picking: boolean;
  name: string | null;
  onPick: () => void;
  onName: (v: string) => void;
}) {
  // Local draft text so mid-typing keystrokes don't each try to resolve
  // (and alert on) a not-yet-finished point name — only commits on blur
  // or Enter. Resyncs from the prop whenever the point is set another way
  // (a canvas pick, or Draw resetting the fields for the next corner).
  const [draft, setDraft] = useState(name ?? "");
  useEffect(() => setDraft(name ?? ""), [name]);
  const commit = () => {
    if (draft.trim() && draft.trim() !== (name ?? "")) onName(draft);
  };
  return (
    <div>
      <span className="mb-0.5 flex items-center gap-1 text-slate-500">
        <span className="inline-block h-2 w-2 flex-none rounded-full" style={{ background: picking ? color : "#cbd5e1" }} />
        {label}
      </span>
      <div className="flex gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
          placeholder="type a point name…"
          className="w-full rounded border border-slate-200 px-1.5 py-1 focus:border-brand focus:outline-none"
        />
        <button
          type="button"
          onClick={onPick}
          title="Pick from canvas"
          className={`flex-none rounded border px-2 py-1 ${picking ? "border-brand bg-brand-light/40 text-brand-dark" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
        >
          ⌖
        </button>
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
