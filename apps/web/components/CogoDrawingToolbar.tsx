"use client";

// Registry-driven COGO drawing toolbar (client req 2026-08-13, Phase 1 = POINT
// TOOLS). Every button here is generated from TOOL_REGISTRY — none are
// hardcoded — and every tool opens the same generic form (built from the
// tool's `fields`) so adding a new tool never touches this file.

import { useState } from "react";
import { Button, Field, Input, Modal, Select } from "@/components/ui";
import { TOOL_REGISTRY } from "@/lib/cogoTools/registry";
import type { FieldDef, ToolDef, WPoint } from "@/lib/cogoTools/types";

export function CogoDrawingToolbar({
  points,
  onResult,
  category = "point",
}: {
  points: WPoint[];
  onResult: (pts: { name: string; east: number; north: number }[]) => void;
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
          onClose={() => setActive(null)}
          onResult={(pts) => {
            onResult(pts);
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
  onClose,
  onResult,
}: {
  tool: ToolDef;
  points: WPoint[];
  onClose: () => void;
  onResult: (pts: { name: string; east: number; north: number }[]) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of tool.fields) if (f.default) init[f.key] = f.default;
    return init;
  });
  const [error, setError] = useState<string | null>(null);
  const set = (key: string) => (v: string) => setValues((s) => ({ ...s, [key]: v }));

  function submit() {
    setError(null);
    const resolved: Record<string, any> = {};
    for (const f of tool.fields) {
      const raw = values[f.key] ?? "";
      resolved[f.key] = f.type === "point" ? points.find((p) => p.id === raw) : raw;
    }
    try {
      const result = tool.run(resolved, { points });
      if (result.points?.length) onResult(result.points);
      else if (result.message) setError(result.message); // informational read-out, not a failure
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  }

  return (
    <Modal open onClose={onClose} title={tool.label}>
      <p className="mb-3 text-sm text-slate-500">{tool.description}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {tool.fields.map((f) => (
          <div key={f.key} className={f.type === "point" ? "sm:col-span-2" : ""}>
            <FieldInput field={f} value={values[f.key] ?? ""} onChange={set(f.key)} points={points} />
          </div>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
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
}: {
  field: FieldDef;
  value: string;
  onChange: (v: string) => void;
  points: WPoint[];
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
  if (field.type === "select") {
    return (
      <Field label={field.label}>
        <Select value={value || field.options![0].value} onChange={onChange} options={field.options!} />
      </Field>
    );
  }
  return (
    <Field label={field.label}>
      <Input value={value} onChange={onChange} type={field.type === "number" ? "number" : "text"} placeholder={field.placeholder} />
    </Field>
  );
}
