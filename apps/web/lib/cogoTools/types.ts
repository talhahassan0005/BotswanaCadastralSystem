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

/** A straight segment, stored as resolved endpoint coordinates (a snapshot, not
 *  a live link to the points it was built from — moving/deleting those points
 *  does not move the line, matching how the reference COGO software behaves). */
export interface WLine {
  id: string;
  name?: string;
  aE: number;
  aN: number;
  bE: number;
  bN: number;
}

/** A circular arc, stored pre-resolved for rendering: centre + radius, the
 *  bearings (from centre) to its start/end points, and the two SVG path
 *  flags computed once at creation time so the renderer never has to re-derive
 *  sweep direction. */
export interface WArc {
  id: string;
  name?: string;
  cE: number;
  cN: number;
  radius: number;
  startBearing: number;
  endBearing: number;
  /** SVG large-arc-flag (0|1). */
  largeArc: 0 | 1;
  /** SVG sweep-flag (0|1) — 1 means the bearing increases (visually clockwise) from start to end. */
  sweep: 0 | 1;
}

/** A closed polygon — an ordered, self-contained snapshot of its vertices
 *  (not live-linked to the points it was built from). */
export interface WPolygon {
  id: string;
  name?: string;
  points: { name: string; east: number; north: number }[];
}

/** A text annotation placed at a world coordinate. */
export interface WText {
  id: string;
  text: string;
  east: number;
  north: number;
  size: number;
  /** "seglabel" = an auto-generated bearing/distance label on a drawn
   *  segment (client req 2026-08-21, Part 15a) — these have their own
   *  visibility toggle, separate from user-placed annotations (undefined). */
  kind?: "seglabel";
  /** On-screen rotation in degrees for a seglabel (client req 2026-08-26:
   *  "those bearings and distances should be in the same line" — a tilted
   *  side's label used to sit flat/horizontal regardless of the side's own
   *  angle, drifting off it and colliding with neighbouring lines/labels on
   *  anything but a near-horizontal side). Computed once from the segment's
   *  east/north endpoints at creation time and clamped to ±90° so the text
   *  reads upright either way the segment runs — screen angle depends only
   *  on that direction vector, not on pan/zoom, so it never needs
   *  recomputing after the fact. */
  angle?: number;
}

export type FieldType = "number" | "text" | "textarea" | "point" | "line" | "polygon" | "select" | "bearing";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  /** For type "select": the choices. For "point"/"line": ignored (populated from ctx). */
  options?: { value: string; label: string }[];
  default?: string;
  placeholder?: string;
}

export interface ToolContext {
  /** Points currently plotted on the work station canvas (imports + prior tool results). */
  points: WPoint[];
  /** Lines currently drawn on the work station canvas. */
  lines: WLine[];
  /** Polygons currently drawn on the work station canvas. */
  polygons: WPolygon[];
}

export type NewArc = Omit<WArc, "id">;

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
  lines?: { name?: string; aE: number; aN: number; bE: number; bN: number }[];
  arcs?: NewArc[];
  polygons?: { name?: string; points: { name: string; east: number; north: number }[] }[];
  texts?: { text: string; east: number; north: number; size?: number; kind?: "seglabel"; angle?: number }[];
  /** Existing line ids this result replaces (e.g. Fillet trims the two source
   *  lines back to their new tangent points) — removed before the new lines/
   *  arcs above are added. */
  replaceLineIds?: string[];
  /** Existing polygon ids this result replaces (e.g. Split/Merge Polygon). */
  replacePolygonIds?: string[];
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
