"use client";

import type { ReactNode } from "react";

// Side-docked traverse leg-entry panel (client req 2026-08-17, Part 6b) —
// mirrors the reference legacy desktop software's "Capture Consistencies"
// dialog. Unlike CogoCommandBar (bottom-docked, one Compute click) this is a
// persistent panel beside the canvas: type a direction/distance, see a live
// dashed preview on the canvas while typing, click Add Leg to commit it as a
// solid line + label and chain straight into the next leg — no modal, no
// close/reopen between legs. All the actual state and canvas drawing lives in
// CogoWorkspace; this component is the form/log UI only.

interface TravLegView {
  point: { id: string; name: string; east: number; north: number };
  direction: string;
  distance: string;
  fromName: string;
}

export function CogoTraversePanel({
  legs,
  startName,
  fromName,
  toName,
  direction,
  distance,
  pickingStart,
  pointSource,
  editIndex,
  hasMemory,
  onToName,
  onDirection,
  onDistance,
  onPointSource,
  onStartPt,
  onChooseTo,
  onAddLeg,
  onSwapDir,
  onUndo,
  onClear,
  onEditLeg,
  onEditDirDist,
  onMemorize,
  onRecall,
  onCalculate,
  onZoom,
  onClose,
}: {
  legs: TravLegView[];
  startName: string | null;
  fromName: string | null;
  toName: string;
  direction: string;
  distance: string;
  pickingStart: boolean;
  pointSource: "table" | "background-point" | "background-line";
  editIndex: number | null;
  hasMemory: boolean;
  onToName: (v: string) => void;
  onDirection: (v: string) => void;
  onDistance: (v: string) => void;
  onPointSource: (v: "table" | "background-point" | "background-line") => void;
  onStartPt: () => void;
  onChooseTo: () => void;
  onAddLeg: () => void;
  onSwapDir: () => void;
  onUndo: () => void;
  onClear: () => void;
  onEditLeg: (i: number) => void;
  onEditDirDist: () => void;
  onMemorize: () => void;
  onRecall: () => void;
  onCalculate: () => void;
  onZoom: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex w-72 flex-none flex-col border-l border-slate-200 bg-white text-xs">
      <div className="flex items-center justify-between border-b border-slate-200 px-2.5 py-1.5">
        <span className="font-semibold text-slate-700">Traverse — Capture Legs</span>
        <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700" title="Close (Esc)" aria-label="Close">✕</button>
      </div>

      {/* Leg log */}
      <div className="max-h-32 overflow-y-auto border-b border-slate-200 bg-slate-50 font-mono">
        {legs.length === 0 ? (
          <p className="px-2.5 py-2 text-slate-400">No legs yet — set Start Pt, then Direction/Distance, then Add Leg.</p>
        ) : (
          legs.map((l, i) => (
            <button
              key={l.point.id}
              type="button"
              onClick={() => onEditLeg(i)}
              className={`grid w-full grid-cols-[1fr_auto] gap-x-2 px-2.5 py-1 text-left hover:bg-white ${editIndex === i ? "bg-brand-light/40" : ""}`}
              title="Click to edit this leg"
            >
              <span>{l.direction}</span>
              <span className="text-slate-500">{l.distance}</span>
              <span className="col-span-2 truncate text-[10px] text-slate-400">{l.fromName} → {l.point.name}</span>
            </button>
          ))
        )}
      </div>

      {/* Live from -> to indicator (client req 2026-08-21, Part 16a) — always
          shows which two points the current leg connects, in the client's
          exact "Name: d -> To Name: e" format, updating with every leg. */}
      <div className="mx-2.5 mt-2 rounded bg-brand-light/30 px-2 py-1.5 text-center font-mono font-semibold text-brand-dark">
        Name: {fromName ?? "—"} &rarr; To Name: {toName.trim() || "—"}
      </div>

      {/* From / To */}
      <div className="grid grid-cols-2 gap-2 px-2.5 pt-2">
        <Field label="Name (from)">
          <input value={fromName ?? ""} readOnly className="w-full rounded border border-slate-200 bg-slate-50 px-1.5 py-1 text-slate-500" />
        </Field>
        <Field label="To Name">
          <input value={toName} onChange={(e) => onToName(e.target.value)} placeholder="auto" className="w-full rounded border border-slate-200 px-1.5 py-1 focus:border-brand focus:outline-none" />
        </Field>
      </div>

      {/* Direction / Distance */}
      <div className="grid grid-cols-2 gap-2 px-2.5 pt-2">
        <Field label="Direction">
          <input value={direction} onChange={(e) => onDirection(e.target.value)} placeholder="DDD.MMSS" className="w-full rounded border border-slate-200 px-1.5 py-1 focus:border-brand focus:outline-none" />
        </Field>
        <Field label="Distance">
          <input value={distance} onChange={(e) => onDistance(e.target.value)} placeholder="m" className="w-full rounded border border-slate-200 px-1.5 py-1 focus:border-brand focus:outline-none" />
        </Field>
      </div>

      {/* Point Source */}
      <div className="px-2.5 pt-2">
        <span className="mb-1 block font-semibold text-slate-600">Point Source</span>
        {([
          ["table", "Point Table"],
          ["background-point", "Background Point"],
          ["background-line", "Background Line End-point"],
        ] as const).map(([id, label]) => (
          <label key={id} className="flex items-center gap-1.5 py-0.5 text-slate-600">
            <input type="radio" name="trav-point-source" checked={pointSource === id} onChange={() => onPointSource(id)} />
            {label}
          </label>
        ))}
      </div>

      {/* Buttons */}
      <div className="grid grid-cols-2 gap-1.5 px-2.5 py-2">
        <PBtn active={pickingStart} onClick={onStartPt}>Start Pt</PBtn>
        <PBtn onClick={onUndo} title="Undoes the last leg — or, before any leg is added, the last point pick">Undo</PBtn>
        <PBtn onClick={onEditDirDist}>Edit Dir/Dist</PBtn>
        <PBtn onClick={onSwapDir} disabled={!direction}>Swap Dir</PBtn>
        <PBtn onClick={onAddLeg} primary disabled={!fromName || !direction || !distance}>Add Leg</PBtn>
        <PBtn onClick={onChooseTo} disabled={!fromName}>Choose To</PBtn>
        <PBtn onClick={onRecall} disabled={!hasMemory}>Recall</PBtn>
        <PBtn onClick={onMemorize} disabled={!direction && !distance}>Memorize</PBtn>
        <PBtn onClick={onCalculate} disabled={legs.length === 0}>Calculate</PBtn>
        <PBtn onClick={onClear} disabled={legs.length === 0}>Clear</PBtn>
        <PBtn onClick={onZoom}>Draw</PBtn>
        <PBtn onClick={onZoom}>Zoom</PBtn>
      </div>
      <div className="border-t border-slate-200 px-2.5 py-1.5 text-[10px] text-slate-400">
        {startName ? `Start: ${startName}` : "Pick a start point to begin"}
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
  active,
  primary,
  disabled,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-md border px-1.5 py-1 text-center font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
        primary
          ? "border-brand bg-brand text-white hover:bg-brand-dark"
          : active
          ? "border-brand bg-brand-light/40 text-brand-dark"
          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
      }`}
    >
      {children}
    </button>
  );
}
