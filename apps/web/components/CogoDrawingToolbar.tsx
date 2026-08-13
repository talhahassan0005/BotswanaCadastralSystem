"use client";

// Registry-driven COGO drawing toolbar (client req 2026-08-13). Every button
// here is generated from TOOL_REGISTRY — none are hardcoded — and every tool
// opens the same generic form (built from the tool's `fields`) so adding a
// new tool never touches this file.

import { useState } from "react";
import { Button, Field, Input, Modal, Select } from "@/components/ui";
import { TOOL_REGISTRY } from "@/lib/cogoTools/registry";
import type { FieldDef, ToolDef, ToolResult, WLine, WPoint, WPolygon } from "@/lib/cogoTools/types";

export function CogoDrawingToolbar({
  points,
  lines,
  polygons,
  onResult,
  category = "point",
}: {
  points: WPoint[];
  lines: WLine[];
  polygons: WPolygon[];
  onResult: (result: ToolResult) => void;
  category?: ToolDef["category"];
}) {
  const [active, setActive] = useState<ToolDef | null>(null);
  const tools = TOOL_REGISTRY.filter((t) => t.category === category);

  return (
    <>
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 bg-slate-50 px-2 py-1.5">
        {tools.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActive(t)}
            title={t.label}
            aria-label={t.label}
            className="grid h-9 w-9 place-items-center rounded-md text-slate-600 hover:bg-white hover:text-brand-dark hover:shadow-sm"
          >
            {t.icon("currentColor")}
          </button>
        ))}
      </div>
      {active && (
        <ToolFormModal
          tool={active}
          points={points}
          lines={lines}
          polygons={polygons}
          onClose={() => setActive(null)}
          onResult={(result) => {
            onResult(result);
            setActive(null);
          }}
        />
      )}
    </>
  );
}

function ToolFormModal({
  tool,
  points,
  lines,
  polygons,
  onClose,
  onResult,
}: {
  tool: ToolDef;
  points: WPoint[];
  lines: WLine[];
  polygons: WPolygon[];
  onClose: () => void;
  onResult: (result: ToolResult) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of tool.fields) if (f.default) init[f.key] = f.default;
    return init;
  });
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const set = (key: string) => (v: string) => setValues((s) => ({ ...s, [key]: v }));

  function submit() {
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
    <Modal open onClose={onClose} title={tool.label}>
      <p className="mb-3 text-sm text-slate-500">{tool.description}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {tool.fields.map((f) => (
          <div key={f.key} className={f.type === "point" || f.type === "line" || f.type === "polygon" || f.type === "textarea" ? "sm:col-span-2" : ""}>
            <FieldInput field={f} value={values[f.key] ?? ""} onChange={set(f.key)} points={points} lines={lines} polygons={polygons} />
          </div>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {info && <p className="mt-3 rounded-lg bg-brand-light/40 px-3 py-2 text-sm text-brand-dark">{info}</p>}
      <div className="mt-4">
        <Button onClick={submit}>Compute</Button>
      </div>
    </Modal>
  );
}

function FieldInput({
  field,
  value,
  onChange,
  points,
  lines,
  polygons,
}: {
  field: FieldDef;
  value: string;
  onChange: (v: string) => void;
  points: WPoint[];
  lines: WLine[];
  polygons: WPolygon[];
}) {
  if (field.type === "point") {
    return (
      <Field label={field.label}>
        <Select
          value={value}
          onChange={onChange}
          options={[
            { value: "", label: "— select a point —" },
            ...points.map((p) => ({ value: p.id, label: `${p.name}  (${p.east.toFixed(2)}, ${p.north.toFixed(2)})` })),
          ]}
        />
      </Field>
    );
  }
  if (field.type === "line") {
    return (
      <Field label={field.label}>
        <Select
          value={value}
          onChange={onChange}
          options={[
            { value: "", label: "— select a line —" },
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
          rows={4}
          className="w-full rounded-lg border border-slate-200 p-3 font-mono text-sm focus:border-brand focus:outline-none"
        />
      </Field>
    );
  }
  return (
    <Field label={field.label}>
      <Input value={value} onChange={onChange} type={field.type === "number" ? "number" : "text"} placeholder={field.placeholder} />
    </Field>
  );
}
