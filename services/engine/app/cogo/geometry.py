"""Core coordinate geometry: forward, inverse (join), area, intersections, curves.

All functions use the convention documented in app.cogo.__init__:
easting/northing metres, bearings clockwise from grid north in decimal degrees.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from .angles import normalize_deg


@dataclass(frozen=True)
class Point:
    east: float
    north: float
    name: str | None = None


def forward(p: Point, bearing_deg: float, distance: float, name: str | None = None) -> Point:
    """Compute a new point from a start point, bearing and distance."""
    b = math.radians(normalize_deg(bearing_deg))
    return Point(
        east=p.east + distance * math.sin(b),
        north=p.north + distance * math.cos(b),
        name=name,
    )


def inverse(a: Point, b: Point) -> tuple[float, float]:
    """Inverse / join: return (bearing_deg, distance) from point a to point b."""
    de = b.east - a.east
    dn = b.north - a.north
    distance = math.hypot(de, dn)
    bearing = normalize_deg(math.degrees(math.atan2(de, dn)))
    return bearing, distance


def polygon_area(points: list[Point]) -> float:
    """Signed area (m^2) of a closed polygon via the shoelace formula.

    Points are the ordered vertices (do NOT repeat the first point).
    Positive result = counter-clockwise ordering. Callers usually want abs().
    """
    n = len(points)
    if n < 3:
        return 0.0
    total = 0.0
    for i in range(n):
        j = (i + 1) % n
        total += points[i].east * points[j].north - points[j].east * points[i].north
    return total / 2.0


def area_hectares(points: list[Point]) -> float:
    return abs(polygon_area(points)) / 10_000.0


def perimeter(points: list[Point], closed: bool = True) -> float:
    """Total length along the point sequence; closed=True adds last->first leg."""
    if len(points) < 2:
        return 0.0
    total = 0.0
    for i in range(len(points) - 1):
        total += inverse(points[i], points[i + 1])[1]
    if closed:
        total += inverse(points[-1], points[0])[1]
    return total


# ---------------------------------------------------------------------------
# Intersections
# ---------------------------------------------------------------------------
def intersect_bearing_bearing(a: Point, brg_a: float, b: Point, brg_b: float) -> Point:
    """Intersection of two rays (point + bearing). Raises if near-parallel."""
    ba = math.radians(normalize_deg(brg_a))
    bb = math.radians(normalize_deg(brg_b))
    # Direction vectors (east, north)
    da_e, da_n = math.sin(ba), math.cos(ba)
    db_e, db_n = math.sin(bb), math.cos(bb)
    denom = da_e * db_n - da_n * db_e
    if abs(denom) < 1e-12:
        raise ValueError("bearings are parallel; no unique intersection")
    # Solve a + t*da = b + s*db  for t
    t = ((b.east - a.east) * db_n - (b.north - a.north) * db_e) / denom
    return Point(east=a.east + t * da_e, north=a.north + t * da_n)


def intersect_distance_distance(
    a: Point, ra: float, b: Point, rb: float, prefer_right: bool = True
) -> Point:
    """Intersection of two circles (point+radius). Returns one of two solutions.

    prefer_right selects the solution to the right of the a->b vector.
    Raises if the circles do not intersect.
    """
    d = math.hypot(b.east - a.east, b.north - a.north)
    if d == 0 or d > ra + rb or d < abs(ra - rb):
        raise ValueError("circles do not intersect")
    aa = (ra * ra - rb * rb + d * d) / (2 * d)
    h_sq = ra * ra - aa * aa
    h = math.sqrt(max(h_sq, 0.0))
    # midpoint along a->b
    ux, uy = (b.east - a.east) / d, (b.north - a.north) / d
    mx, my = a.east + aa * ux, a.north + aa * uy
    # offset perpendicular; (uy,-ux) is the right-hand normal
    sign = 1.0 if prefer_right else -1.0
    return Point(east=mx + sign * h * uy, north=my - sign * h * ux)


def intersect_bearing_distance(a: Point, brg: float, b: Point, radius: float,
                               prefer_far: bool = True) -> Point:
    """Intersection of a ray from a with a circle of given radius about b."""
    ba = math.radians(normalize_deg(brg))
    de, dn = math.sin(ba), math.cos(ba)
    # Solve |a + t*dir - b|^2 = radius^2
    fx, fy = a.east - b.east, a.north - b.north
    bq = 2 * (de * fx + dn * fy)
    cq = fx * fx + fy * fy - radius * radius
    disc = bq * bq - 4 * cq
    if disc < 0:
        raise ValueError("ray does not reach the circle")
    sq = math.sqrt(disc)
    t1, t2 = (-bq + sq) / 2, (-bq - sq) / 2
    candidates = [t for t in (t1, t2) if t >= -1e-9]
    if not candidates:
        raise ValueError("intersection is behind the ray origin")
    t = max(candidates) if prefer_far else min(candidates)
    return Point(east=a.east + t * de, north=a.north + t * dn)


# ---------------------------------------------------------------------------
# Circular curves
# ---------------------------------------------------------------------------
def circular_curve(radius: float, deflection_deg: float) -> dict:
    """Elements of a circular curve given radius and deflection (central) angle."""
    delta = math.radians(deflection_deg)
    tangent = radius * math.tan(delta / 2)
    arc = radius * delta
    chord = 2 * radius * math.sin(delta / 2)
    mid_ordinate = radius * (1 - math.cos(delta / 2))
    external = radius * (1 / math.cos(delta / 2) - 1)
    return {
        "radius": radius,
        "deflection_deg": deflection_deg,
        "tangent": tangent,
        "arc_length": arc,
        "chord": chord,
        "mid_ordinate": mid_ordinate,
        "external": external,
    }
