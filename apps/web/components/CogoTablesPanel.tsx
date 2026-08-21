"use client";

// Bottom-docked data-table panel (client req 2026-08-20, Part 9). Shows every
// plotted point/line/polygon as a spreadsheet-style table with the exact
// columns the client asked for. Row click / shift-click-range / Delete /
// double-click-attributes are handled here; the actual geometry mutation and
// canvas<->table highlight sync live in CogoWorkspace, this component is
// presentational + local metadata editing only.

import { useRef } from "react";
import { inverse, polygonArea } from "@/lib/server/geometry";
import { formatDms } from "@/lib/server/angles";
import type { WLine, WPoint, WPolygon } from "@/lib/cogoTools/types";

export interface PointMeta { height?: string; sdNumber?: string; epoch?: string; klass?: string; subclass?: string; description?: string }
export interface LineMeta { type?: string }
export interface PolygonMeta {
  position?: string; erf?: string; farm?: string; township?: string; extension?: string; type?: string;
  sdNumber?: string; minNumber?: string; parent?: string; width?: string; symbol?: string;
}

type Tab = "points" | "lines" | "polygons";

export function CogoTablesPanel({
  tab,
  onTab,
  points,
  lines,
  polygons,
  pointMeta,
  lineMeta,
  polygonMeta,
  selected,
  onRowMouseDown,
  onRowMouseEnter,
  onSetPointMeta,
  onSetLineMeta,
  onSetPolygonMeta,
  onDeleteSelection,
  onOpenPolygonAttrs,
  onClose,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  points: WPoint[];
  lines: WLine[];
  polygons: WPolygon[];
  pointMeta: Record<string, PointMeta>;
  lineMeta: Record<string, LineMeta>;
  polygonMeta: Record<string, PolygonMeta>;
  selected: Set<string>;
  onRowMouseDown: (id: string, shiftKey: boolean) => void;
  onRowMouseEnter: (id: string) => void;
  onSetPointMeta: (id: string, patch: Partial<PointMeta>) => void;
  onSetLineMeta: (id: string, patch: Partial<LineMeta>) => void;
  onSetPolygonMeta: (id: string, patch: Partial<PolygonMeta>) => void;
  onDeleteSelection: () => void;
  onOpenPolygonAttrs: (id: string) => void;
  onClose: () => void;
}) {
  const draggingRef = useRef(false);

  return (
    <div
      className="flex max-h-64 flex-col border-t border-slate-200 bg-white text-xs"
      onMouseUp={() => (draggingRef.current = false)}
      onMouseLeave={() => (draggingRef.current = false)}
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-2.5 py-1.5">
        <div className="flex items-center gap-1">
          {([
            ["points", `Points (${points.length})`],
            ["lines", `Lines (${lines.length})`],
            ["polygons", `Polygons (${polygons.length})`],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => onTab(id)}
              className={`rounded px-2 py-1 font-medium transition ${tab === id ? "bg-brand text-white" : "text-slate-600 hover:bg-slate-100"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <>
              <span className="text-slate-400">{selected.size} selected</span>
              <button type="button" onClick={onDeleteSelection} className="rounded border border-red-200 px-2 py-0.5 font-medium text-red-600 hover:bg-red-50">
                Delete
              </button>
            </>
          )}
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700" title="Close" aria-label="Close">✕</button>
        </div>
      </div>

      <div className="overflow-auto">
        {tab === "points" && (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-slate-50 text-left text-[10px] uppercase text-slate-500">
              <tr>
                {["Name", "Y", "X", "Height", "SD Number", "Epoch", "Class", "Subclass", "Description"].map((h) => (
                  <th key={h} className="whitespace-nowrap border-b border-slate-200 px-2 py-1">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.length === 0 ? (
                <tr><td colSpan={9} className="px-2 py-3 text-center text-slate-400">No points yet.</td></tr>
              ) : points.map((p) => {
                const m = pointMeta[p.id] ?? {};
                const isSel = selected.has(p.id);
                return (
                  <tr
                    key={p.id}
                    onMouseDown={(e) => { draggingRef.current = true; onRowMouseDown(p.id, e.shiftKey); }}
                    onMouseEnter={() => { if (draggingRef.current) onRowMouseEnter(p.id); }}
                    className={`cursor-pointer select-none ${isSel ? "bg-brand-light/40" : "hover:bg-slate-50"}`}
                  >
                    <td className="whitespace-nowrap border-b border-slate-100 px-2 py-1 font-medium">{p.name}</td>
                    <td className="whitespace-nowrap border-b border-slate-100 px-2 py-1 font-mono">{p.east.toFixed(3)}</td>
                    <td className="whitespace-nowrap border-b border-slate-100 px-2 py-1 font-mono">{p.north.toFixed(3)}</td>
                    {(["height", "sdNumber", "epoch", "klass", "subclass", "description"] as const).map((k) => (
                      <td key={k} className="border-b border-slate-100 px-1 py-0.5">
                        <input
                          value={m[k] ?? ""}
                          onChange={(e) => onSetPointMeta(p.id, { [k]: e.target.value })}
                          onMouseDown={(e) => e.stopPropagation()}
                          className="w-20 rounded border border-transparent bg-transparent px-1 py-0.5 focus:border-brand focus:bg-white focus:outline-none"
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {tab === "lines" && (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-slate-50 text-left text-[10px] uppercase text-slate-500">
              <tr>
                {["Type", "Direction", "Distance"].map((h) => (
                  <th key={h} className="whitespace-nowrap border-b border-slate-200 px-2 py-1">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 ? (
                <tr><td colSpan={3} className="px-2 py-3 text-center text-slate-400">No lines yet.</td></tr>
              ) : lines.map((l) => {
                const m = lineMeta[l.id] ?? {};
                const isSel = selected.has(l.id);
                const [brg, dist] = inverse({ east: l.aE, north: l.aN }, { east: l.bE, north: l.bN });
                return (
                  <tr
                    key={l.id}
                    onMouseDown={(e) => { draggingRef.current = true; onRowMouseDown(l.id, e.shiftKey); }}
                    onMouseEnter={() => { if (draggingRef.current) onRowMouseEnter(l.id); }}
                    className={`cursor-pointer select-none ${isSel ? "bg-brand-light/40" : "hover:bg-slate-50"}`}
                  >
                    <td className="border-b border-slate-100 px-1 py-0.5">
                      <input
                        value={m.type ?? ""}
                        onChange={(e) => onSetLineMeta(l.id, { type: e.target.value })}
                        onMouseDown={(e) => e.stopPropagation()}
                        placeholder="Boundary"
                        className="w-24 rounded border border-transparent bg-transparent px-1 py-0.5 focus:border-brand focus:bg-white focus:outline-none"
                      />
                    </td>
                    <td className="whitespace-nowrap border-b border-slate-100 px-2 py-1 font-mono">{formatDms(brg)}</td>
                    <td className="whitespace-nowrap border-b border-slate-100 px-2 py-1 font-mono">{dist.toFixed(3)}m</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {tab === "polygons" && (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-slate-50 text-left text-[10px] uppercase text-slate-500">
              <tr>
                {["", "Lot No. (Position)", "Erf", "Farm", "Township", "Extension", "Type", "Area", "SD Number", "Min Number", "Parent", "Width", "Symbol"].map((h) => (
                  <th key={h} className="whitespace-nowrap border-b border-slate-200 px-2 py-1">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {polygons.length === 0 ? (
                <tr><td colSpan={13} className="px-2 py-3 text-center text-slate-400">No polygons yet.</td></tr>
              ) : polygons.map((p) => {
                const m = polygonMeta[p.id] ?? {};
                const isSel = selected.has(p.id);
                const areaM2 = polygonArea(p.points.map((v) => ({ east: v.east, north: v.north })));
                return (
                  <tr
                    key={p.id}
                    onMouseDown={(e) => { draggingRef.current = true; onRowMouseDown(p.id, e.shiftKey); }}
                    onMouseEnter={() => { if (draggingRef.current) onRowMouseEnter(p.id); }}
                    onDoubleClick={() => onOpenPolygonAttrs(p.id)}
                    className={`cursor-pointer select-none ${isSel ? "bg-brand-light/40" : "hover:bg-slate-50"}`}
                    title="Double-click for Attributes"
                  >
                    <td className="border-b border-slate-100 px-1 py-0.5">
                      <button
                        type="button"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => onOpenPolygonAttrs(p.id)}
                        className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-50"
                      >
                        Attrs
                      </button>
                    </td>
                    {(["position", "erf", "farm", "township", "extension", "type"] as const).map((k) => (
                      <td key={k} className="border-b border-slate-100 px-1 py-0.5">
                        <input
                          value={m[k] ?? ""}
                          onChange={(e) => onSetPolygonMeta(p.id, { [k]: e.target.value })}
                          onMouseDown={(e) => e.stopPropagation()}
                          className="w-20 rounded border border-transparent bg-transparent px-1 py-0.5 focus:border-brand focus:bg-white focus:outline-none"
                        />
                      </td>
                    ))}
                    <td className="whitespace-nowrap border-b border-slate-100 px-2 py-1 font-mono">{(areaM2 / 10000).toFixed(4)} ha</td>
                    {(["sdNumber", "minNumber", "parent", "width", "symbol"] as const).map((k) => (
                      <td key={k} className="border-b border-slate-100 px-1 py-0.5">
                        <input
                          value={m[k] ?? ""}
                          onChange={(e) => onSetPolygonMeta(p.id, { [k]: e.target.value })}
                          onMouseDown={(e) => e.stopPropagation()}
                          className="w-20 rounded border border-transparent bg-transparent px-1 py-0.5 focus:border-brand focus:bg-white focus:outline-none"
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
