/**
 * Angle / bearing helpers: DMS <-> decimal degrees, normalization, formatting.
 * Ported from services/engine/app/cogo/angles.py so the web app can compute
 * COGO entirely in-process (no Python engine needed on Vercel).
 *
 * Supports the bearing notations seen in Botswana survey data:
 *   - Decimal degrees:        "45.2083"
 *   - DMS with symbols:       "45°12'30\""
 *   - Dotted DMS (DDD.MMSS):  "272.36.20"  (SG diagram "DIRECTIONS" style)
 */

const FULL_CIRCLE = 360.0;

/** Wrap an angle in degrees to the range [0, 360). */
export function normalizeDeg(deg: number): number {
  return ((deg % FULL_CIRCLE) + FULL_CIRCLE) % FULL_CIRCLE;
}

/** Convert degrees/minutes/seconds to decimal degrees (sign-aware). */
export function dmsToDeg(d: number, m = 0, s = 0): number {
  const sign = d < 0 || m < 0 || s < 0 ? -1 : 1;
  return sign * (Math.abs(d) + Math.abs(m) / 60 + Math.abs(s) / 3600);
}

/** Convert decimal degrees to [degrees, minutes, seconds]. */
export function degToDms(deg: number): [number, number, number] {
  const sign = deg < 0 ? -1 : 1;
  deg = Math.abs(deg);
  let d = Math.floor(deg);
  const rem = (deg - d) * 60;
  let m = Math.floor(rem);
  let s = round((rem - m) * 60, 4);
  // carry rounding (e.g. 59.9999s -> 60s)
  if (s >= 60) {
    s -= 60;
    m += 1;
  }
  if (m >= 60) {
    m -= 60;
    d += 1;
  }
  return [sign * d, m, s];
}

// "272.36.20" or "272.3620" (dotted DDD.MMSS)
const DOTTED_RE = /^\s*(-?\d+)\.(\d{2})\.?(\d{2}(?:\.\d+)?)\s*$/;
// "45°12'30\"" / "45 12 30" / "45d12m30s"
const SYMBOL_RE =
  /^\s*(-?\d+(?:\.\d+)?)\s*[°dD ]\s*(?:(\d+(?:\.\d+)?)\s*['mM ]\s*)?(?:(\d+(?:\.\d+)?)\s*["sS]?\s*)?$/;

/** Parse a bearing in any supported notation -> decimal degrees [0, 360). */
export function parseBearing(text: string | number): number {
  if (typeof text === "number") return normalizeDeg(text);

  const s = String(text).trim();
  if (!s) throw new Error("empty bearing");

  // Plain decimal degrees, e.g. "45.2083". Number("") === 0, so the guard above
  // is required; reject anything that isn't a clean numeric token here.
  if (/^-?\d+(?:\.\d+)?$/.test(s)) {
    return normalizeDeg(Number(s));
  }

  const dotted = s.match(DOTTED_RE);
  if (dotted) {
    return normalizeDeg(dmsToDeg(Number(dotted[1]), Number(dotted[2]), Number(dotted[3])));
  }

  const sym = s.match(SYMBOL_RE);
  if (sym) {
    const d = Number(sym[1]);
    const m = sym[2] ? Number(sym[2]) : 0;
    const sec = sym[3] ? Number(sym[3]) : 0;
    return normalizeDeg(dmsToDeg(d, m, sec));
  }

  throw new Error(`unrecognized bearing format: ${JSON.stringify(text)}`);
}

/** Format decimal degrees as DMS string, e.g. 45.2083 -> 45°12'30". */
export function formatDms(deg: number, sep: [string, string, string] = ["°", "'", '"']): string {
  const [d, m, s] = degToDms(normalizeDeg(deg));
  return `${d}${sep[0]}${pad2(m)}${sep[1]}${pad2(Math.round(s))}${sep[2]}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Round to a fixed number of decimal places (round-half-up). */
export function round(value: number, digits = 0): number {
  const f = 10 ** digits;
  return Math.round((value + Number.EPSILON) * f) / f;
}
