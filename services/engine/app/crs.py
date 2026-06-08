"""Botswana coordinate-system support (Module B).

Pure-Python implementation (no PROJ dependency) so it is fully controllable,
testable, and matches Botswana cadastral conventions exactly.

Supported systems:
  * Lo 21 / Lo 23 / Lo 25 / Lo 27  — Botswana Gauss-Conform "Lo" belts
        (Transverse Mercator on the Clarke 1880 / Arc 1950 ellipsoid, with the
         South-African Y/X axis convention: Y positive WEST of the central
         meridian, X positive SOUTH of the equator, scale factor 1.0).
  * Arc1950   — geographic lat/lon on the Clarke 1880 (Arc 1950) datum
  * WGS84     — geographic lat/lon (WGS84 datum)
  * UTM34S / UTM35S — Universal Transverse Mercator (WGS84), the two zones
        covering Botswana (zone 34: CM 21°E, zone 35: CM 27°E).

Datum shift Arc1950 <-> WGS84 uses a 3-parameter geocentric translation.
The default parameters below are commonly-cited regional values; the official
Department of Surveys and Mapping (DSM) parameters can be substituted in
ARC1950_TO_WGS84 once provided by the client.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

# --------------------------------------------------------------------------
# Ellipsoids
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class Ellipsoid:
    a: float       # semi-major axis (m)
    rf: float      # inverse flattening 1/f

    @property
    def f(self) -> float:
        return 1.0 / self.rf

    @property
    def e2(self) -> float:
        f = self.f
        return 2 * f - f * f

    @property
    def b(self) -> float:
        return self.a * (1 - self.f)


# Clarke 1880 (Arc 1950 datum, as used in Botswana/Southern Africa)
CLARKE1880 = Ellipsoid(a=6378249.145, rf=293.4663077)
# WGS84
WGS84 = Ellipsoid(a=6378137.0, rf=298.257223563)

# 3-parameter datum shift Arc1950 -> WGS84 (geocentric translation, metres).
# NOTE: regional default — replace with official DSM Botswana parameters.
ARC1950_TO_WGS84 = (-138.0, -105.0, -289.0)


# --------------------------------------------------------------------------
# Geodetic <-> geocentric (ECEF)
# --------------------------------------------------------------------------
def geodetic_to_ecef(lat_deg: float, lon_deg: float, ell: Ellipsoid, h: float = 0.0):
    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg)
    e2 = ell.e2
    N = ell.a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
    x = (N + h) * math.cos(lat) * math.cos(lon)
    y = (N + h) * math.cos(lat) * math.sin(lon)
    z = (N * (1 - e2) + h) * math.sin(lat)
    return x, y, z


def ecef_to_geodetic(x: float, y: float, z: float, ell: Ellipsoid):
    """Bowring's method — converges in a few iterations."""
    a, e2 = ell.a, ell.e2
    b = ell.b
    ep2 = (a * a - b * b) / (b * b)
    p = math.hypot(x, y)
    if p < 1e-9:
        lat = math.copysign(math.pi / 2, z)
        return math.degrees(lat), 0.0, abs(z) - b
    theta = math.atan2(z * a, p * b)
    lat = math.atan2(z + ep2 * b * math.sin(theta) ** 3, p - e2 * a * math.cos(theta) ** 3)
    lon = math.atan2(y, x)
    N = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
    h = p / math.cos(lat) - N
    return math.degrees(lat), math.degrees(lon), h


def arc1950_to_wgs84_geodetic(lat: float, lon: float):
    dx, dy, dz = ARC1950_TO_WGS84
    x, y, z = geodetic_to_ecef(lat, lon, CLARKE1880)
    return ecef_to_geodetic(x + dx, y + dy, z + dz, WGS84)[:2]


def wgs84_to_arc1950_geodetic(lat: float, lon: float):
    dx, dy, dz = ARC1950_TO_WGS84
    x, y, z = geodetic_to_ecef(lat, lon, WGS84)
    return ecef_to_geodetic(x - dx, y - dy, z - dz, CLARKE1880)[:2]


# --------------------------------------------------------------------------
# Transverse Mercator (standard easting/northing), Karney-style series
# --------------------------------------------------------------------------
def _tm_forward(lat_deg, lon_deg, ell: Ellipsoid, lon0_deg, k0, fe, fn):
    lat = math.radians(lat_deg)
    dlon = math.radians(lon_deg - lon0_deg)
    e2 = ell.e2
    ep2 = e2 / (1 - e2)
    N = ell.a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
    T = math.tan(lat) ** 2
    C = ep2 * math.cos(lat) ** 2
    A = math.cos(lat) * dlon
    # Meridional arc
    a = ell.a
    M = a * (
        (1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256) * lat
        - (3 * e2 / 8 + 3 * e2**2 / 32 + 45 * e2**3 / 1024) * math.sin(2 * lat)
        + (15 * e2**2 / 256 + 45 * e2**3 / 1024) * math.sin(4 * lat)
        - (35 * e2**3 / 3072) * math.sin(6 * lat)
    )
    easting = fe + k0 * N * (
        A + (1 - T + C) * A**3 / 6 + (5 - 18 * T + T**2 + 72 * C - 58 * ep2) * A**5 / 120
    )
    northing = fn + k0 * (
        M
        + N * math.tan(lat) * (
            A**2 / 2
            + (5 - T + 9 * C + 4 * C**2) * A**4 / 24
            + (61 - 58 * T + T**2 + 600 * C - 330 * ep2) * A**6 / 720
        )
    )
    return easting, northing


def _tm_inverse(easting, northing, ell: Ellipsoid, lon0_deg, k0, fe, fn):
    a, e2 = ell.a, ell.e2
    ep2 = e2 / (1 - e2)
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    M = (northing - fn) / k0
    mu = M / (a * (1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256))
    phi1 = (
        mu
        + (3 * e1 / 2 - 27 * e1**3 / 32) * math.sin(2 * mu)
        + (21 * e1**2 / 16 - 55 * e1**4 / 32) * math.sin(4 * mu)
        + (151 * e1**3 / 96) * math.sin(6 * mu)
        + (1097 * e1**4 / 512) * math.sin(8 * mu)
    )
    C1 = ep2 * math.cos(phi1) ** 2
    T1 = math.tan(phi1) ** 2
    N1 = a / math.sqrt(1 - e2 * math.sin(phi1) ** 2)
    R1 = a * (1 - e2) / (1 - e2 * math.sin(phi1) ** 2) ** 1.5
    D = (easting - fe) / (N1 * k0)
    lat = phi1 - (N1 * math.tan(phi1) / R1) * (
        D**2 / 2
        - (5 + 3 * T1 + 10 * C1 - 4 * C1**2 - 9 * ep2) * D**4 / 24
        + (61 + 90 * T1 + 298 * C1 + 45 * T1**2 - 252 * ep2 - 3 * C1**2) * D**6 / 720
    )
    lon = math.radians(lon0_deg) + (
        D
        - (1 + 2 * T1 + C1) * D**3 / 6
        + (5 - 2 * C1 + 28 * T1 - 3 * C1**2 + 8 * ep2 + 24 * T1**2) * D**5 / 120
    ) / math.cos(phi1)
    return math.degrees(lat), math.degrees(lon)


# --------------------------------------------------------------------------
# Lo (Gauss-Conform) — Y west-positive, X south-positive
# --------------------------------------------------------------------------
def lo_forward(lat, lon, cm):
    """Arc1950 geodetic -> Lo (Y, X)."""
    e, n = _tm_forward(lat, lon, CLARKE1880, cm, 1.0, 0.0, 0.0)
    return -e, -n  # Y west-positive, X south-positive


def lo_inverse(y, x, cm):
    """Lo (Y, X) -> Arc1950 geodetic (lat, lon)."""
    return _tm_inverse(-y, -x, CLARKE1880, cm, 1.0, 0.0, 0.0)


# --------------------------------------------------------------------------
# UTM (WGS84)
# --------------------------------------------------------------------------
def utm_forward(lat, lon, zone, south=True):
    cm = zone * 6 - 183
    fn = 10_000_000.0 if south else 0.0
    return _tm_forward(lat, lon, WGS84, cm, 0.9996, 500_000.0, fn)


def utm_inverse(e, n, zone, south=True):
    cm = zone * 6 - 183
    fn = 10_000_000.0 if south else 0.0
    return _tm_inverse(e, n, WGS84, cm, 0.9996, 500_000.0, fn)


# --------------------------------------------------------------------------
# CRS registry + orchestrator
# --------------------------------------------------------------------------
LO_ZONES = {"Lo21": 21, "Lo23": 23, "Lo25": 25, "Lo27": 27}
UTM_ZONES = {"UTM34S": 34, "UTM35S": 35}

CRS_LIST = [
    {"code": "Lo21", "label": "Lo 21° (Botswana Gauss-Conform)"},
    {"code": "Lo23", "label": "Lo 23° (Botswana Gauss-Conform)"},
    {"code": "Lo25", "label": "Lo 25° (Botswana Gauss-Conform)"},
    {"code": "Lo27", "label": "Lo 27° (Botswana Gauss-Conform)"},
    {"code": "Arc1950", "label": "Arc 1950 (geographic lat/lon)"},
    {"code": "WGS84", "label": "WGS84 (geographic lat/lon)"},
    {"code": "UTM34S", "label": "UTM Zone 34S (WGS84)"},
    {"code": "UTM35S", "label": "UTM Zone 35S (WGS84)"},
]


def _normalize(code: str) -> str:
    return code.replace(" ", "").replace("Botswana", "").replace("°", "").strip()


def to_wgs84_geodetic(code: str, a: float, b: float):
    """Convert a coordinate pair in `code` to WGS84 (lat, lon).

    For projected/Lo/UTM systems, (a,b) are the plane coords; for geographic
    systems (a,b) are (lat, lon).
    """
    code = _normalize(code)
    if code in LO_ZONES:
        lat, lon = lo_inverse(a, b, LO_ZONES[code])  # a=Y, b=X
        return arc1950_to_wgs84_geodetic(lat, lon)
    if code in UTM_ZONES:
        lat, lon = utm_inverse(a, b, UTM_ZONES[code])  # a=E, b=N
        return lat, lon
    if code == "Arc1950":
        return arc1950_to_wgs84_geodetic(a, b)  # a=lat, b=lon
    if code == "WGS84":
        return a, b
    raise ValueError(f"unknown CRS: {code}")


def from_wgs84_geodetic(code: str, lat: float, lon: float):
    """Convert WGS84 (lat, lon) into `code`. Returns the pair in that system."""
    code = _normalize(code)
    if code in LO_ZONES:
        alat, alon = wgs84_to_arc1950_geodetic(lat, lon)
        return lo_forward(alat, alon, LO_ZONES[code])  # (Y, X)
    if code in UTM_ZONES:
        return utm_forward(lat, lon, UTM_ZONES[code])  # (E, N)
    if code == "Arc1950":
        return wgs84_to_arc1950_geodetic(lat, lon)  # (lat, lon)
    if code == "WGS84":
        return lat, lon
    raise ValueError(f"unknown CRS: {code}")


def transform_point(a: float, b: float, src: str, dst: str):
    """Transform a single coordinate pair from src CRS to dst CRS."""
    lat, lon = to_wgs84_geodetic(src, a, b)
    return from_wgs84_geodetic(dst, lat, lon)


def is_geographic(code: str) -> bool:
    return _normalize(code) in ("WGS84", "Arc1950")
