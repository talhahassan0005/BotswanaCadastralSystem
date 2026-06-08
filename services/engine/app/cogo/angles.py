"""Angle / bearing helpers: DMS <-> decimal degrees, normalization, formatting.

Supports the bearing notations seen in Botswana survey data:
  * Decimal degrees:           "45.2083"
  * DMS with symbols:          "45°12'30\""  (UI mockup style)
  * Dotted DMS  (DDD.MMSS):    "272.36.20"  (SG diagram "DIRECTIONS" style)
"""
from __future__ import annotations

import math
import re

FULL_CIRCLE = 360.0


def normalize_deg(deg: float) -> float:
    """Wrap an angle in degrees to the range [0, 360)."""
    return deg % FULL_CIRCLE


def dms_to_deg(d: float, m: float = 0.0, s: float = 0.0) -> float:
    """Convert degrees/minutes/seconds to decimal degrees (sign-aware)."""
    sign = -1.0 if (d < 0 or m < 0 or s < 0) else 1.0
    return sign * (abs(d) + abs(m) / 60.0 + abs(s) / 3600.0)


def deg_to_dms(deg: float) -> tuple[int, int, float]:
    """Convert decimal degrees to (degrees, minutes, seconds)."""
    sign = -1 if deg < 0 else 1
    deg = abs(deg)
    d = int(deg)
    rem = (deg - d) * 60.0
    m = int(rem)
    s = round((rem - m) * 60.0, 4)
    # carry rounding (e.g. 59.9999s -> 60s)
    if s >= 60.0:
        s -= 60.0
        m += 1
    if m >= 60:
        m -= 60
        d += 1
    return sign * d, m, s


# "272.36.20"  or  "272.3620"  (dotted DDD.MMSS)
_DOTTED_RE = re.compile(r"^\s*(-?\d+)\.(\d{2})\.?(\d{2}(?:\.\d+)?)\s*$")
# "45°12'30\""  /  "45 12 30"  /  "45d12m30s"
_SYMBOL_RE = re.compile(
    r"^\s*(-?\d+(?:\.\d+)?)\s*[°dD ]\s*(?:(\d+(?:\.\d+)?)\s*['mM ]\s*)?"
    r"(?:(\d+(?:\.\d+)?)\s*[\"sS]?\s*)?$"
)


def parse_bearing(text: str | float | int) -> float:
    """Parse a bearing in any supported notation -> decimal degrees [0, 360)."""
    if isinstance(text, (int, float)):
        return normalize_deg(float(text))

    s = str(text).strip()
    if not s:
        raise ValueError("empty bearing")

    # Plain decimal degrees, e.g. "45.2083"
    try:
        return normalize_deg(float(s))
    except ValueError:
        pass

    m = _DOTTED_RE.match(s)
    if m:
        d, mm, ss = float(m.group(1)), float(m.group(2)), float(m.group(3))
        return normalize_deg(dms_to_deg(d, mm, ss))

    m = _SYMBOL_RE.match(s)
    if m:
        d = float(m.group(1))
        mm = float(m.group(2)) if m.group(2) else 0.0
        ss = float(m.group(3)) if m.group(3) else 0.0
        return normalize_deg(dms_to_deg(d, mm, ss))

    raise ValueError(f"unrecognized bearing format: {text!r}")


def format_dms(deg: float, sep: tuple[str, str, str] = ("°", "'", '"')) -> str:
    """Format decimal degrees as DMS string, e.g. 45.2083 -> 45°12'30\"."""
    d, m, s = deg_to_dms(normalize_deg(deg))
    return f"{d}{sep[0]}{m:02d}{sep[1]}{round(s):02d}{sep[2]}"


def deg_to_rad(deg: float) -> float:
    return math.radians(deg)
