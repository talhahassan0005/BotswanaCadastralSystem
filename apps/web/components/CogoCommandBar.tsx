"use client";

// Bottom-docked command bar for numeric-input COGO tools (client req
// 2026-08-14, Part 5) — replaces the old centered <Modal> so the canvas stays
// fully visible (and pannable/zoomable) while the user types values, the way
// a CAD command line works. Only tools NOT in a CogoDrawingToolbar's
// `interceptIds` land here — those are the click-to-draw tools, which never
// open this bar.

import { forwardRef, useImperativeHandle, useState, type Ref } from "react";
import { Button, Field, Input, Select } from "@/components/ui";
import type { FieldDef, ToolDef, ToolResult, WLine, WPoint, WPolygon } from "@/lib/cogoTools/types";

export interface CogoCommandBarHandle {
  /** Fill whichever field the user is focused on (or the first empty field of
   *  a matching type) with a point/line/polygon picked directly on the canvas. */
  pickFromCanvas: (kind: "point" | "line" | "polygon", id: string) => void;
}

function CogoCommandBarImpl(
  {
    tool,
    points,
    lines,
    polygons,
    onResult,
    onClose,
  }: {
    tool: ToolDef | null;
    points: WPoint[];
    lines: WLine[];
    polygons: WPolygon[];
    onResult: (result: ToolResult) => void;
    onClose: () => void;
  },
  ref: Ref<CogoCommandBarHandle>
) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Reset the form whenever a different tool is opened.
  const [lastToolId, setLastToolId] = useState<string | null>(null);
  if (tool && tool.id !== lastToolId) {
    setLastToolId(tool.id);
    const init: Record<string, string> = {};
    for (const f of tool.fields) if (f.default) init[f.key] = f.default;
    setValues(init);
    setError(null);
    setInfo(null);
  }

  useImperativeHandle(ref, () => ({
    pickFromCanvas(kind, id) {
      if (!tool) return;
      const focused = tool.fields.find((f) => f.key === focusedField);
      const targetKey =
        focused?.type === kind
          ? focused.key
          : tool.fields.find((f) => f.type === kind && !values[f.key])?.key;
      if (targetKey) setValues((v) => ({ ...v, [targetKey]: id }));
    },
  }));

  if (!tool) return null;
  const set = (key: string) => (v: string) => setValues((s) => ({ ...s, [key]: v }));

  function submit() {
    if (!tool) return;
    setError(null);
    setInfo(null);
    const resolved: Record<string, any> = {};
    for (const f of tool.fields) {
      const raw = values[f.key] ?? "";
      if (f.type === "point") resolved[f.key] = points.find((p) => p.id === raw);
      else if (f.type === "line") resolved[f.key] = lines.find((l) => l.id === raw);
      else if (f.type === "polygon") resolved[f.key] = polygons.find((p) => p.id === raw);
      else resolved[f.key] = raw;
    }
    try {
      const result = tool.run(resolved, { points, lines, polygons });
      if (result.points?.length || result.lines?.length || result.arcs?.length || result.polygons?.length) onResult(result);
      else if (result.message) setInfo(result.message); // informational read-out, not a failure
      else setError("No result.");
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  }

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }}
      className="border-t border-brand bg-white px-3 py-2 shadow-[0_-4px_10px_rgba(0,0,0,0.04)]"
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-brand-dark">{tool.label}</span>
        <button type="button" onClick={onClose} className="text-xs text-slate-400 hover:text-slate-700" aria-label="Close">Esc to close</button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        {tool.fields.map((f) => (
          <div key={f.key} className={f.type === "textarea" ? "w-full" : "min-w-[9rem] flex-1"}>
            <CommandField
              field={f}
              value={values[f.key] ?? ""}
              onChange={set(f.key)}
              onFocus={() => setFocusedField(f.key)}
              points={points}
              lines={lines}
              polygons={polygons}
            />
          </div>
        ))}
        <Button type="submit">Compute</Button>
      </div>
      {error && <p className="mt-1.5 text-xs text-red-600">{error}</p>}
      {info && <p className="mt-1.5 rounded bg-brand-light/40 px-2 py-1 text-xs text-brand-dark">{info}</p>}
    </form>
  );
}

export const CogoCommandBar = forwardRef(CogoCommandBarImpl);

function CommandField({
  field,
  value,
  onChange,
  onFocus,
  points,
  lines,
  polygons,
}: {
  field: FieldDef;
  value: string;
  onChange: (v: string) => void;
  onFocus: () => void;
  points: WPoint[];
  lines: WLine[];
  polygons: WPolygon[];
}) {
  if (field.type === "point") {
    return (
      <Field label={`${field.label} (or click it on the canvas)`}>
        <Select
          value={value}
          onChange={onChange}
          onFocus={onFocus}
          options={[
            { value: "", label: "— select or click a point —" },
            ...points.map((p) => ({ value: p.id, label: `${p.name}  (${p.east.toFixed(2)}, ${p.north.toFixed(2)})` })),
          ]}
        />
      </Field>
    );
  }
  if (field.type === "line") {
    return (
      <Field label={`${field.label} (or click it on the canvas)`}>
        <Select
          value={value}
          onChange={onChange}
          onFocus={onFocus}
          options={[
            { value: "", label: "— select or click a line —" },
            ...lines.map((l) => ({ value: l.id, label: l.name || `Line ${l.id.slice(-4)}` })),
          ]}
        />
      </Field>
    );
  }
  if (field.type === "polygon") {
    return (
      <Field label={field.label}>
        <Select
          value={value}
          onChange={onChange}
          onFocus={onFocus}
          options={[
            { value: "", label: "— select a polygon —" },
            ...polygons.map((p) => ({ value: p.id, label: p.name || `Polygon ${p.id.slice(-4)} (${p.points.length} pts)` })),
          ]}
        />
      </Field>
    );
  }
  if (field.type === "select") {
    return (
      <Field label={field.label}>
        <Select value={value || field.options![0].value} onChange={onChange} options={field.options!} />
      </Field>
    );
  }
  if (field.type === "textarea") {
    return (
      <Field label={field.label}>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          rows={2}
          className="w-full rounded-lg border border-slate-200 p-2 font-mono text-xs focus:border-brand focus:outline-none"
        />
      </Field>
    );
  }
  return (
    <Field label={field.label}>
      <Input value={value} onChange={onChange} onFocus={onFocus} type={field.type === "number" ? "number" : "text"} placeholder={field.placeholder} />
    </Field>
  );
}
