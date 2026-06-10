/**
 * Botswana coordinate-system support (Module B).
 * Ported from services/engine/app/crs.py — pure TypeScript (no PROJ dependency).
 *
 * Supported systems:
 *   - Lo 13 … 29 (odd)      — Southern-African Gauss-Conform "Lo" belts, 2° wide
 *     on odd central meridians (Transverse Mercator on Clarke 1880 / Arc 1950,
 *     Y west-positive, X south-positive). Botswana's territory falls in
 *     Lo21–Lo29; the full Lo13–Lo29 span (12°E–30°E) is registered.
 *   - Arc1950 / WGS84       — geographic lat/lon.
 *   - UTM34S / UTM35S       — UTM (WGS84) zones covering Botswana.
 */

interface Ellipsoid {
  a: number; // semi-major axis (m)
  rf: number; // inverse flattening 1/f
}

const f = (e: Ellipsoid) => 1 / e.rf;
const e2 = (e: Ellipsoid) => 2 * f(e) - f(e) * f(e);
const bAxis = (e: Ellipsoid) => e.a * (1 - f(e));

// Clarke 1880 (Arc 1950 datum) and WGS84.
const CLARKE1880: Ellipsoid = { a: 6378249.145, rf: 293.4663077 };
const WGS84: Ellipsoid = { a: 6378137.0, rf: 298.257223563 };

// 3-parameter datum shift Arc1950 -> WGS84 (geocentric translation, metres).
const ARC1950_TO_WGS84: [number, number, number] = [-138.0, -105.0, -289.0];

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// ---------------------------------------------------------------------------
// Geodetic <-> geocentric (ECEF)
// ---------------------------------------------------------------------------
function geodeticToEcef(latDeg: number, lonDeg: number, ell: Ellipsoid, h = 0): [number, number, number] {
  const lat = latDeg * D2R;
  const lon = lonDeg * D2R;
  const ee = e2(ell);
  const N = ell.a / Math.sqrt(1 - ee * Math.sin(lat) ** 2);
  const x = (N + h) * Math.cos(lat) * Math.cos(lon);
  const y = (N + h) * Math.cos(lat) * Math.sin(lon);
  const z = (N * (1 - ee) + h) * Math.sin(lat);
  return [x, y, z];
}

/** Bowring's method — converges in a few iterations. */
function ecefToGeodetic(x: number, y: number, z: number, ell: Ellipsoid): [number, number, number] {
  const a = ell.a;
  const ee = e2(ell);
  const b = bAxis(ell);
  const ep2 = (a * a - b * b) / (b * b);
  const p = Math.hypot(x, y);
  if (p < 1e-9) {
    const lat = Math.sign(z) * (Math.PI / 2);
    return [lat * R2D, 0, Math.abs(z) - b];
  }
  const theta = Math.atan2(z * a, p * b);
  const lat = Math.atan2(z + ep2 * b * Math.sin(theta) ** 3, p - ee * a * Math.cos(theta) ** 3);
  const lon = Math.atan2(y, x);
  const N = a / Math.sqrt(1 - ee * Math.sin(lat) ** 2);
  const h = p / Math.cos(lat) - N;
  return [lat * R2D, lon * R2D, h];
}

function arc1950ToWgs84Geodetic(lat: number, lon: number): [number, number] {
  const [dx, dy, dz] = ARC1950_TO_WGS84;
  const [x, y, z] = geodeticToEcef(lat, lon, CLARKE1880);
  const out = ecefToGeodetic(x + dx, y + dy, z + dz, WGS84);
  return [out[0], out[1]];
}

function wgs84ToArc1950Geodetic(lat: number, lon: number): [number, number] {
  const [dx, dy, dz] = ARC1950_TO_WGS84;
  const [x, y, z] = geodeticToEcef(lat, lon, WGS84);
  const out = ecefToGeodetic(x - dx, y - dy, z - dz, CLARKE1880);
  return [out[0], out[1]];
}

// ---------------------------------------------------------------------------
// Transverse Mercator (standard easting/northing)
// ---------------------------------------------------------------------------
function tmForward(
  latDeg: number,
  lonDeg: number,
  ell: Ellipsoid,
  lon0Deg: number,
  k0: number,
  fe: number,
  fn: number
): [number, number] {
  const lat = latDeg * D2R;
  const dlon = (lonDeg - lon0Deg) * D2R;
  const ee = e2(ell);
  const ep2 = ee / (1 - ee);
  const N = ell.a / Math.sqrt(1 - ee * Math.sin(lat) ** 2);
  const T = Math.tan(lat) ** 2;
  const C = ep2 * Math.cos(lat) ** 2;
  const A = Math.cos(lat) * dlon;
  const a = ell.a;
  const M =
    a *
    ((1 - ee / 4 - (3 * ee ** 2) / 64 - (5 * ee ** 3) / 256) * lat -
      ((3 * ee) / 8 + (3 * ee ** 2) / 32 + (45 * ee ** 3) / 1024) * Math.sin(2 * lat) +
      ((15 * ee ** 2) / 256 + (45 * ee ** 3) / 1024) * Math.sin(4 * lat) -
      ((35 * ee ** 3) / 3072) * Math.sin(6 * lat));
  const easting =
    fe + k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5) / 120);
  const northing =
    fn +
    k0 *
      (M +
        N *
          Math.tan(lat) *
          (A ** 2 / 2 +
            ((5 - T + 9 * C + 4 * C ** 2) * A ** 4) / 24 +
            ((61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6) / 720));
  return [easting, northing];
}

function tmInverse(
  easting: number,
  northing: number,
  ell: Ellipsoid,
  lon0Deg: number,
  k0: number,
  fe: number,
  fn: number
): [number, number] {
  const a = ell.a;
  const ee = e2(ell);
  const ep2 = ee / (1 - ee);
  const e1 = (1 - Math.sqrt(1 - ee)) / (1 + Math.sqrt(1 - ee));
  const M = (northing - fn) / k0;
  const mu = M / (a * (1 - ee / 4 - (3 * ee ** 2) / 64 - (5 * ee ** 3) / 256));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const C1 = ep2 * Math.cos(phi1) ** 2;
  const T1 = Math.tan(phi1) ** 2;
  const N1 = a / Math.sqrt(1 - ee * Math.sin(phi1) ** 2);
  const R1 = (a * (1 - ee)) / (1 - ee * Math.sin(phi1) ** 2) ** 1.5;
  const D = (easting - fe) / (N1 * k0);
  const lat =
    phi1 -
    ((N1 * Math.tan(phi1)) / R1) *
      (D ** 2 / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep2) * D ** 4) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep2 - 3 * C1 ** 2) * D ** 6) / 720);
  const lon =
    lon0Deg * D2R +
    (D -
      ((1 + 2 * T1 + C1) * D ** 3) / 6 +
      ((5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep2 + 24 * T1 ** 2) * D ** 5) / 120) /
      Math.cos(phi1);
  return [lat * R2D, lon * R2D];
}

// ---------------------------------------------------------------------------
// Lo (Gauss-Conform) — Y west-positive, X south-positive
// ---------------------------------------------------------------------------
function loForward(lat: number, lon: number, cm: number): [number, number] {
  const [e, n] = tmForward(lat, lon, CLARKE1880, cm, 1.0, 0, 0);
  return [-e, -n];
}
function loInverse(y: number, x: number, cm: number): [number, number] {
  return tmInverse(-y, -x, CLARKE1880, cm, 1.0, 0, 0);
}

// ---------------------------------------------------------------------------
// UTM (WGS84)
// ---------------------------------------------------------------------------
function utmForward(lat: number, lon: number, zone: number, south = true): [number, number] {
  const cm = zone * 6 - 183;
  const fn = south ? 10_000_000.0 : 0;
  return tmForward(lat, lon, WGS84, cm, 0.9996, 500_000.0, fn);
}
function utmInverse(e: number, n: number, zone: number, south = true): [number, number] {
  const cm = zone * 6 - 183;
  const fn = south ? 10_000_000.0 : 0;
  return tmInverse(e, n, WGS84, cm, 0.9996, 500_000.0, fn);
}

// ---------------------------------------------------------------------------
// CRS registry + orchestrator
// ---------------------------------------------------------------------------
// Gauss-Conform "Lo" belts: 2° wide, on ODD central meridians. Lo13–Lo29 spans
// the 12°E–30°E band; Botswana's national survey uses Lo21–Lo29.
// Botswana's official Gauss-Conform "Lo" belts are 2° wide on ODD central
// meridians (Lo21–Lo29). The client's brief asks for "Lo12 to Lo29", so the
// full integer span 12–29 is offered and ANY `Lo<cm>` code is accepted by the
// transformer (the TM maths is valid for any central meridian).
const LO_MERIDIANS = Array.from({ length: 29 - 12 + 1 }, (_, i) => 12 + i); // 12..29
const BOTSWANA_LO = new Set([21, 23, 25, 27, 29]);
const UTM_ZONES: Record<string, number> = { UTM34S: 34, UTM35S: 35 };

export const CRS_LIST = [
  ...LO_MERIDIANS.map((m) => ({
    code: `Lo${m}`,
    label: `Lo ${m}° (Gauss-Conform${BOTSWANA_LO.has(m) ? ", Botswana belt" : ""})`,
  })),
  { code: "Arc1950", label: "Arc 1950 (geographic lat/lon)" },
  { code: "WGS84", label: "WGS84 (geographic lat/lon)" },
  { code: "UTM34S", label: "UTM Zone 34S (WGS84)" },
  { code: "UTM35S", label: "UTM Zone 35S (WGS84)" },
];

function normalize(code: string): string {
  return code.replace(/ /g, "").replace("Botswana", "").replace("°", "").trim();
}

/** Parse a `Lo<cm>` code to its central meridian (any value 10–36), else null. */
function loCm(code: string): number | null {
  const m = /^Lo(\d+(?:\.\d+)?)$/.exec(code);
  if (!m) return null;
  const cm = Number(m[1]);
  return cm >= 10 && cm <= 36 ? cm : null;
}

function toWgs84Geodetic(code: string, a: number, b: number): [number, number] {
  code = normalize(code);
  const cm = loCm(code);
  if (cm != null) {
    const [lat, lon] = loInverse(a, b, cm); // a=Y, b=X
    return arc1950ToWgs84Geodetic(lat, lon);
  }
  if (code in UTM_ZONES) {
    return utmInverse(a, b, UTM_ZONES[code]); // a=E, b=N
  }
  if (code === "Arc1950") return arc1950ToWgs84Geodetic(a, b);
  if (code === "WGS84") return [a, b];
  throw new Error(`unknown CRS: ${code}`);
}

function fromWgs84Geodetic(code: string, lat: number, lon: number): [number, number] {
  code = normalize(code);
  const cm = loCm(code);
  if (cm != null) {
    const [alat, alon] = wgs84ToArc1950Geodetic(lat, lon);
    return loForward(alat, alon, cm); // (Y, X)
  }
  if (code in UTM_ZONES) {
    return utmForward(lat, lon, UTM_ZONES[code]); // (E, N)
  }
  if (code === "Arc1950") return wgs84ToArc1950Geodetic(lat, lon);
  if (code === "WGS84") return [lat, lon];
  throw new Error(`unknown CRS: ${code}`);
}

export function transformPoint(a: number, b: number, src: string, dst: string): [number, number] {
  const [lat, lon] = toWgs84Geodetic(src, a, b);
  return fromWgs84Geodetic(dst, lat, lon);
}

export function isGeographic(code: string): boolean {
  return ["WGS84", "Arc1950"].includes(normalize(code));
}
