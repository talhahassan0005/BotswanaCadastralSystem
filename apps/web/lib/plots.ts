/**
 * Shared utilities for anything that draws MULTIPLE numbered plots on one
 * sheet (General Plan, Working Plan) — kept here so both modules operate on
 * the exact same logic instead of two independently-drifting copies.
 */

export interface PlotPoint {
  name: string | null;
  east: number;
  north: number;
}

export interface Plot {
  number: string;
  points: PlotPoint[];
}

/** Points that appear in more than one plot (same name = a shared boundary
 *  beacon between adjoining subdivisions) are kept once — first plot to use
 *  the name wins (client req 2026-08-26, Part 33a; promoted out of
 *  WorkingPlan.tsx 2026-08-27 so the General Plan module can reuse it
 *  verbatim rather than forking a second copy). */
export function dedupePoints(plots: Plot[]): PlotPoint[] {
  const named = new Map<string, PlotPoint>();
  const anon: PlotPoint[] = [];
  for (const plot of plots) {
    for (const p of plot.points) {
      if (p.name) {
        if (!named.has(p.name)) named.set(p.name, p);
      } else {
        anon.push(p);
      }
    }
  }
  return [...named.values(), ...anon];
}
