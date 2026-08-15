"use client";

// Registry-driven COGO toolbar row (client req 2026-08-13/14). Every button
// here is generated from TOOL_REGISTRY — none are hardcoded. Clicking a tool
// either:
//  - runs `interceptIds[id]()` (click-to-draw tools — CogoWorkspace switches
//    the canvas into that drawing mode, no form at all), or
//  - calls `onOpenTool(tool)` (numeric-input tools — CogoWorkspace opens the
//    single shared bottom-docked CogoCommandBar for it, Part 5).
// This component owns no form state itself — see CogoCommandBar.tsx.

import { TOOL_REGISTRY } from "@/lib/cogoTools/registry";
import type { ToolDef } from "@/lib/cogoTools/types";

/** Human-readable heading shown above each row so a dense icon strip reads as
 *  a named group instead of one unbroken row of unlabelled buttons. */
const CATEGORY_LABELS: Record<ToolDef["category"], string> = {
  point: "Point Tools",
  line: "Line Tools",
  curve: "Curve Tools",
  polygon: "Polygon Tools",
  traverse: "Traverse & Adjustment",
  query: "Query Tools",
  annotation: "Annotation Tools",
  edit: "Edit Tools",
};

export function CogoDrawingToolbar({
  category = "point",
  interceptIds,
  activeId,
  onOpenTool,
}: {
  category?: ToolDef["category"];
  /** Tool ids in this map bypass the command bar entirely — clicking them
   *  calls the callback instead (click-to-draw canvas tools like Line/
   *  Polygon, which build up their shape from canvas clicks, not a form). */
  interceptIds?: Record<string, () => void>;
  /** Tool id to show highlighted (the click-to-draw tool currently active on the canvas). */
  activeId?: string | null;
  /** Opens the shared command bar for a non-intercepted (numeric-input) tool. */
  onOpenTool: (tool: ToolDef) => void;
}) {
  const tools = TOOL_REGISTRY.filter((t) => t.category === category);

  return (
    <div className="border-b border-slate-200 bg-slate-50">
      <div className="px-2 pt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        {CATEGORY_LABELS[category]}
      </div>
      <div className="flex flex-wrap items-center gap-1 px-2 pb-1.5">
        {tools.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => (interceptIds?.[t.id] ? interceptIds[t.id]() : onOpenTool(t))}
            title={t.label}
            aria-label={t.label}
            className={`grid h-9 w-9 place-items-center rounded-md transition ${
              activeId === t.id ? "bg-brand text-white" : "text-slate-600 hover:bg-white hover:text-brand-dark hover:shadow-sm"
            }`}
          >
            {t.icon("currentColor")}
          </button>
        ))}
      </div>
    </div>
  );
}
