"use client";

// Bottom-docked command bar for numeric-input COGO tools (client req
// 2026-08-14, Part 5) — replaces the old centered <Modal> so the canvas stays
// fully visible (and pannable/zoomable) while the user types values, the way
// a CAD command line works. Only tools NOT in a CogoDrawingToolbar's
// `interceptIds` land here — those are the click-to-draw tools, which never
// open this bar.

import { forwardRef, useEffect, useImperativeHandle, useState, type Ref } from "react";
import { Button, Field, Input, Select } from "@/components/ui";
import type { FieldDef, ToolDef, ToolResult, WLine, WPoint, WPolygon } from "@/lib/cogoTools/types";

export interface CogoCommandBarHandle {
  /** Fill whichever field the user is focused on (or the first empty field of
   *  a matching type) with a point/line/polygon picked directly on the canvas,
   *  or (kind "bearing") copy a clicked line's bearing text into a focused
   *  bearing-type field (client req 2026-08-20, Part 8a). */
  pickFromCanvas: (kind: "point" | "line" | "polygon" | "bearing", id: string) => void;
  /** The type of whichever field currently has focus, or null. Lets the canvas
   *  decide whether a click should copy a bearing vs. pick a point/line ref. */
  getFocusedFieldType: () => FieldDef["type"] | null;
}

function CogoCommandBarImpl(
  {
    tool,
    points,
    lines,
    polygons,
    onResult,
    onClose,
    onPreview,
  }: {
    tool: ToolDef | null;
    points: WPoint[];
    lines: WLine[];
    polygons: WPolygon[];
    /** Commits a computed result onto the canvas. Returns the ids assigned to
     *  any new points/lines (used by Point-by-Bearing&Distance's Radial/
     *  Consecutive chaining, Part 8c) — pass `keepOpen` to stop the bar from
     *  auto-closing after this result (chained multi-entry tools). */
    onResult: (result: ToolResult, opts?: { keepOpen?: boolean }) => { pointIds: string[]; lineIds: string[] } | void;
    onClose: () => void;
    /** Live "ghost" preview (Part 8b) — called on every field change with
     *  whatever `tool.run()` would currently produce (or null if incomplete/
     *  invalid). `run()` is pure, so speculatively calling it has no side
     *  effects; the canvas renders the result as a dashed preview. */
    onPreview?: (result: ToolResult | null) => void;
  },
  ref: Ref<CogoCommandBarHandle>
) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [livePreview, setLivePreview] = useState<ToolResult | null>(null);

  // Point by Bearing & Distance extras (Part 8c) — mode toggle + checkboxes.
  const [pbdMode, setPbdMode] = useState<"single" | "radial" | "consecutive">("single");
  const [pbdAuto, setPbdAuto] = useState(false);
  const [pbdAddLine, setPbdAddLine] = useState(false);
  const isPBD = tool?.id === "point-bearing-distance";

  // Reset the form whenever a different tool is opened.
  const [lastToolId, setLastToolId] = useState<string | null>(null);
  if (tool && tool.id !== lastToolId) {
    setLastToolId(tool.id);
    const init: Record<string, string> = {};
    for (const f of tool.fields) if (f.default) init[f.key] = f.default;
    setValues(init);
    setError(null);
    setInfo(null);
    setPbdMode("single");
    setPbdAuto(false);
    setPbdAddLine(false);
  }

  function resolveValues(vals: Record<string, string>): Record<string, any> {
    const resolved: Record<string, any> = {};
    if (!tool) return resolved;
    for (const f of tool.fields) {
      const raw = vals[f.key] ?? "";
      if (f.type === "point") resolved[f.key] = points.find((p) => p.id === raw);
      else if (f.type === "line") resolved[f.key] = lines.find((l) => l.id === raw);
      else if (f.type === "polygon") resolved[f.key] = polygons.find((p) => p.id === raw);
      else resolved[f.key] = raw;
    }
    return resolved;
  }

  // Live preview (Part 8b): re-run the tool speculatively on every keystroke
  // once all required fields look filled in. Cleared on close/tool switch.
  useEffect(() => {
    if (!tool || !onPreview) return;
    const resolved = resolveValues(values);
    const complete = tool.fields.every((f) => {
      if (f.key === "name" || f.type === "select" || f.type === "textarea") return true;
      if (f.type === "point" || f.type === "line" || f.type === "polygon") return !!resolved[f.key];
      return !!String(values[f.key] ?? "").trim();
    });
    if (!complete) { onPreview(null); setLivePreview(null); return; }
    try {
      const r = tool.run(resolved, { points, lines, polygons });
      const hit = r.points?.length || r.lines?.length || r.arcs?.length || r.polygons?.length ? r : null;
      onPreview(hit);
      setLivePreview(hit);
    } catch {
      onPreview(null);
      setLivePreview(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, values, points, lines, polygons]);

  useEffect(() => {
    if (!tool) onPreview?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  useImperativeHandle(ref, () => ({
    pickFromCanvas(kind, id) {
      if (!tool) return;
      const focused = tool.fields.find((f) => f.key === focusedField);
      if (kind === "bearing") {
        const targetKey = focused?.type === "bearing" ? focused.key : tool.fields.find((f) => f.type === "bearing" && !values[f.key])?.key;
        if (targetKey) setValues((v) => ({ ...v, [targetKey]: id })); // `id` is already the formatted bearing text here
        return;
      }
      const targetKey =
        focused?.type === kind
          ? focused.key
          : tool.fields.find((f) => f.type === kind && !values[f.key])?.key;
      if (targetKey) setValues((v) => ({ ...v, [targetKey]: id }));
    },
    getFocusedFieldType() {
      return tool?.fields.find((f) => f.key === focusedField)?.type ?? null;
    },
  }));

  if (!tool) return null;
  const set = (key: string) => (v: string) => setValues((s) => ({ ...s, [key]: v }));

  function bumpName(name: string): string {
    const m = name.match(/^(.*?)(\d+)$/);
    return m ? `${m[1]}${parseInt(m[2], 10) + 1}` : `${name || "New"}2`;
  }

  function submit() {
    if (!tool) return;
    setError(null);
    setInfo(null);
    const resolved = resolveValues(values);
    try {
      const result = tool.run(resolved, { points, lines, polygons });
      if (!(result.points?.length || result.lines?.length || result.arcs?.length || result.polygons?.length)) {
        if (result.message) setInfo(result.message); // informational read-out, not a failure
        else setError("No result.");
        return;
      }
      if (isPBD && pbdAddLine && resolved.from && result.points?.length) {
        const np = result.points[0];
        result.lines = [...(result.lines ?? []), { aE: resolved.from.east, aN: resolved.from.north, bE: np.east, bN: np.north }];
      }
      if (isPBD && pbdMode !== "single") {
        const ids = onResult(result, { keepOpen: true });
        const newPointId = ids?.pointIds?.[0];
        setValues((v) => ({
          ...v,
          bearing: "",
          distance: "",
          name: bumpName(v.name ?? "New"),
          from: pbdMode === "consecutive" && newPointId ? newPointId : v.from,
        }));
      } else {
        onResult(result);
      }
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

      {isPBD && (
        <div className="mb-2 flex flex-wrap items-center gap-3 rounded bg-slate-50 px-2 py-1.5 text-xs text-slate-600">
          <span className="font-semibold text-slate-500">Mode</span>
          {([
            ["single", "Single"],
            ["radial", "Radial — repeat from same base"],
            ["consecutive", "Consecutive — chain to new point"],
          ] as const).map(([id, label]) => (
            <label key={id} className="flex items-center gap-1">
              <input type="radio" name="pbd-mode" checked={pbdMode === id} onChange={() => setPbdMode(id)} />
              {label}
            </label>
          ))}
          <span className="mx-1 h-4 w-px bg-slate-200" />
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={pbdAuto} onChange={(e) => setPbdAuto(e.target.checked)} />
            Automatic Calc&apos;n (Enter in Distance computes)
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={pbdAddLine} onChange={(e) => setPbdAddLine(e.target.checked)} />
            Add Line
          </label>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        {tool.fields.map((f) => (
          <div key={f.key} className={f.type === "textarea" ? "w-full" : "min-w-[9rem] flex-1"}>
            <CommandField
              field={f}
              value={values[f.key] ?? ""}
              onChange={set(f.key)}
              onFocus={() => setFocusedField(f.key)}
              onEnterSubmit={isPBD && pbdAuto && f.key === "distance" ? submit : undefined}
              points={points}
              lines={lines}
              polygons={polygons}
            />
          </div>
        ))}
        <Button type="submit">Compute</Button>
      </div>
      {livePreview?.points?.[0] && (
        <p className="mt-1.5 text-xs text-slate-500">
          Preview — {livePreview.points[0].name}: E {livePreview.points[0].east.toFixed(3)}, N {livePreview.points[0].north.toFixed(3)}
        </p>
      )}
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
  onEnterSubmit,
  points,
  lines,
  polygons,
}: {
  field: FieldDef;
  value: string;
  onChange: (v: string) => void;
  onFocus: () => void;
  /** When set (Part 8c "Automatic Calc'n"), pressing Enter in this field
   *  computes immediately instead of requiring the Compute button. */
  onEnterSubmit?: () => void;
  points: WPoint[];
  lines: WLine[];
  polygons: WPolygon[];
}) {
  if (field.type === "bearing") {
    return (
      <Field label={`${field.label} — or click a line on canvas to copy its bearing`}>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onKeyDown={(e) => { if (e.key === "Enter" && onEnterSubmit) { e.preventDefault(); onEnterSubmit(); } }}
          placeholder="DDD.MMSS"
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none"
        />
      </Field>
    );
  }
  if (onEnterSubmit) {
    return (
      <Field label={field.label}>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onEnterSubmit(); } }}
          type={field.type === "number" ? "number" : "text"}
          placeholder={field.placeholder}
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none"
        />
      </Field>
    );
  }
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
