/**
 * Point-label decluttering (client req 2026-08-30) — shared by SgDiagram,
 * WorkingPlan and GeneralPlanView so all three resolve label crowding the
 * same way instead of drifting into three separate implementations.
 *
 * With a handful of points, a fixed offset from each dot reads fine. A real
 * subdivision's Working Plan/Diagram/General Plan can carry hundreds of
 * beacons close together (client's 1026-point Charleshill stress test), and
 * a fixed offset then produces a solid mass of overlapping text. This module
 * only ever adjusts where a LABEL sits (nudging it to a nearby clear spot,
 * or hiding it as a last resort) — it never touches point geometry; callers
 * must always draw every point's dot/marker regardless of what happens here.
 */

export interface LabelCandidate {
  id: string;
  /** The point's own screen position — the label anchors near this. */
  x: number;
  y: number;
  text: string;
  fontSize: number;
  /** Direction to try first (e.g. "away from the figure centroid", matching
   *  each view's previous fixed-offset placement) — a starting preference,
   *  not binding; decluttering still moves off it if that spot collides. */
  preferDx?: number;
  preferDy?: number;
  /** An offset the user placed by hand (dragging the label) — always honoured
   *  verbatim at its exact position (never moved or hidden), but still
   *  registered so other labels route around it. */
  pinnedDx?: number;
  pinnedDy?: number;
}

export interface PlacedLabel {
  id: string;
  text: string;
  fontSize: number;
  /** Anchor (dot) position, unchanged from the candidate. */
  x: number;
  y: number;
  /** Final label draw position. */
  labelX: number;
  labelY: number;
  /** True when every candidate spot collided and the label was suppressed —
   *  the caller must still draw this point's dot, just not this text. */
  hidden: boolean;
  /** True when the label sits far enough from its dot that a leader line
   *  helps tie the two back together. */
  leader: boolean;
}

interface Box { minX: number; minY: number; maxX: number; maxY: number; }

/** Text width has no cheap exact answer without a DOM measurement — this
 *  monospace-ish estimate (the app's own SVG labels are all fixed-width or
 *  bold-narrow fonts) is close enough for collision purposes; a slightly
 *  generous estimate is safer here than an optimistic one that lets real
 *  text spill past its box. */
function textBox(x: number, y: number, text: string, fontSize: number): Box {
  const w = Math.max(text.length, 1) * fontSize * 0.62;
  const h = fontSize * 1.3;
  return { minX: x - w / 2 - 1, minY: y - h, maxX: x + w / 2 + 1, maxY: y + 2 };
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

/** Grid-bucketed spatial index so collision checks for N labels stay close
 *  to O(N) instead of O(N^2) — cell size matched to a typical label's
 *  footprint so a query only touches a handful of neighbouring cells. */
class SpatialGrid {
  private cell: number;
  private buckets = new Map<string, Box[]>();
  constructor(cellSize: number) {
    this.cell = Math.max(cellSize, 1);
  }
  private keysFor(b: Box): string[] {
    const x0 = Math.floor(b.minX / this.cell), x1 = Math.floor(b.maxX / this.cell);
    const y0 = Math.floor(b.minY / this.cell), y1 = Math.floor(b.maxY / this.cell);
    const keys: string[] = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.push(`${x},${y}`);
    return keys;
  }
  insert(b: Box) {
    for (const k of this.keysFor(b)) {
      if (!this.buckets.has(k)) this.buckets.set(k, []);
      this.buckets.get(k)!.push(b);
    }
  }
  collides(b: Box): boolean {
    const seen = new Set<Box>();
    for (const k of this.keysFor(b)) {
      const list = this.buckets.get(k);
      if (!list) continue;
      for (const other of list) {
        if (seen.has(other)) continue;
        seen.add(other);
        if (boxesOverlap(b, other)) return true;
      }
    }
    return false;
  }
}

/** Candidate offsets tried for a colliding label, spiralling outward from
 *  the point: the caller's preferred direction first (matches each view's
 *  previous default placement so most labels don't visibly move at all),
 *  then a compass ring at two radii before giving up and hiding it. */
function offsetRing(fontSize: number, preferDx: number, preferDy: number): { dx: number; dy: number }[] {
  const r1 = Math.max(fontSize * 0.9, 8);
  const r2 = Math.max(fontSize * 2.2, 18);
  const dirs: [number, number][] = [
    [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1],
  ];
  return [
    { dx: preferDx, dy: preferDy },
    ...dirs.map(([dx, dy]) => ({ dx: dx * r1, dy: dy * r1 })),
    ...dirs.map(([dx, dy]) => ({ dx: dx * r2, dy: dy * r2 })),
  ];
}

/** Resolves a set of point-name labels to non-colliding positions. Pinned
 *  (user-dragged) candidates are placed first and never moved; the rest are
 *  processed in the given order (deterministic, so results don't jitter
 *  between renders of the same data) and either land on the first clear
 *  offset or are hidden if nothing in the search ring is clear. */
export function declutterLabels(candidates: LabelCandidate[]): PlacedLabel[] {
  if (!candidates.length) return [];
  const avgFont = candidates.reduce((s, c) => s + c.fontSize, 0) / candidates.length;
  const grid = new SpatialGrid(avgFont * 3);
  const placed: PlacedLabel[] = [];
  const pinned = candidates.filter((c) => c.pinnedDx != null || c.pinnedDy != null);
  const auto = candidates.filter((c) => c.pinnedDx == null && c.pinnedDy == null);

  for (const c of pinned) {
    const lx = c.x + (c.pinnedDx ?? 0), ly = c.y + (c.pinnedDy ?? 0);
    grid.insert(textBox(lx, ly, c.text, c.fontSize));
    placed.push({
      id: c.id, text: c.text, fontSize: c.fontSize, x: c.x, y: c.y,
      labelX: lx, labelY: ly, hidden: false,
      leader: Math.hypot(lx - c.x, ly - c.y) > c.fontSize * 1.4,
    });
  }

  for (const c of auto) {
    const ring = offsetRing(c.fontSize, c.preferDx ?? 0, c.preferDy ?? 0);
    let found: { x: number; y: number } | null = null;
    for (const off of ring) {
      const x = c.x + off.dx, y = c.y + off.dy;
      const box = textBox(x, y, c.text, c.fontSize);
      if (!grid.collides(box)) {
        found = { x, y };
        grid.insert(box);
        break;
      }
    }
    if (found) {
      placed.push({
        id: c.id, text: c.text, fontSize: c.fontSize, x: c.x, y: c.y,
        labelX: found.x, labelY: found.y, hidden: false,
        leader: Math.hypot(found.x - c.x, found.y - c.y) > c.fontSize * 1.4,
      });
    } else {
      const x = c.x + (c.preferDx ?? 0), y = c.y + (c.preferDy ?? 0);
      placed.push({ id: c.id, text: c.text, fontSize: c.fontSize, x: c.x, y: c.y, labelX: x, labelY: y, hidden: true, leader: false });
    }
  }

  return placed;
}
