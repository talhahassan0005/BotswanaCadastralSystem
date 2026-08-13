import type { ReactElement } from "react";

/**
 * Shared types for the COGO drawing-tool registry. A "tool" is a self-contained
 * unit of work station functionality: a toolbar icon, an input form, and a pure
 * calculation function. New tools are added by extending a category file and
 * registering them in registry.tsx — the toolbar UI never hardcodes buttons.
 */

export interface WPoint {
  id: string;
  name: string;
  east: number;
  north: number;
}

export type FieldType = "number" | "text" | "point" | "select";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  /** For type "select": the choices. For type "point": ignored (populated from ctx.points). */
  options?: { value: string; label: string }[];
  default?: string;
  placeholder?: string;
}

export interface ToolContext {
  /** Points currently plotted on the work station canvas (imports + prior tool results). */
  points: WPoint[];
}

export type ToolCategory =
  | "point"
  | "line"
  | "curve"
  | "polygon"
  | "traverse"
  | "query"
  | "annotation"
  | "edit";

export interface ToolResult {
  points?: { name: string; east: number; north: number }[];
  /** Human-readable read-out for tools that report a value rather than geometry
   *  (e.g. a Query tool's angle or distance). Shown in the form modal on success. */
  message?: string;
}

export interface ToolDef {
  id: string;
  category: ToolCategory;
  label: string;
  /** Short line shown under the form title explaining what the tool does. */
  description: string;
  icon: (color: string) => ReactElement;
  fields: FieldDef[];
  /** Pure calculation — resolved field values in, a result out. Throws Error with
   *  a user-facing message on invalid input (e.g. parallel bearings, bad angles). */
  run: (values: Record<string, any>, ctx: ToolContext) => ToolResult;
}
