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
    <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 bg-slate-50 px-2 py-1.5">
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
  );
}
