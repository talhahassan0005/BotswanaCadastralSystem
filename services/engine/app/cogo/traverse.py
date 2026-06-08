"""Traverse computation and adjustment (Bowditch / Transit rules).

A traverse is an ordered list of legs, each {bearing, distance}, starting from a
fixed station. Supports:
  * closed-loop traverse  (returns to the start station)
  * closed-link traverse  (closes onto a second known station)
  * open traverse         (no closure, no adjustment)
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from .angles import normalize_deg
from .geometry import Point


@dataclass
class Leg:
    bearing: float          # decimal degrees, clockwise from grid north
    distance: float         # metres
    from_name: str | None = None
    to_name: str | None = None

    @property
    def d_east(self) -> float:
        return self.distance * math.sin(math.radians(normalize_deg(self.bearing)))

    @property
    def d_north(self) -> float:
        return self.distance * math.cos(math.radians(normalize_deg(self.bearing)))


@dataclass
class AdjustedLeg:
    index: int
    from_name: str | None
    to_name: str | None
    bearing: float
    distance: float
    d_east_raw: float
    d_north_raw: float
    d_east_adj: float
    d_north_adj: float


@dataclass
class Closure:
    misclose_east: float
    misclose_north: float
    linear_misclosure: float       # metres
    angular_misclosure: float | None  # degrees (None for link/open)
    total_distance: float
    relative_precision: float | None  # 1:N (None if perfect closure)
    relative_precision_text: str

    @property
    def precision_denominator(self) -> float | None:
        return self.relative_precision


@dataclass
class TraverseResult:
    type: str
    adjustment: str
    points: list[Point]
    legs: list[AdjustedLeg]
    closure: Closure
    area_m2: float = 0.0
    area_ha: float = 0.0
    residuals: list[dict] = field(default_factory=list)
    sigma0: float = 0.0


def _raw_coords(start: Point, legs: list[Leg]) -> list[Point]:
    pts = [start]
    cur = start
    for leg in legs:
        cur = Point(
            east=cur.east + leg.d_east,
            north=cur.north + leg.d_north,
            name=leg.to_name,
        )
        pts.append(cur)
    return pts


def _relative_precision(linear: float, total: float) -> tuple[float | None, str]:
    if linear < 1e-9 or total <= 0:
        return None, "1:∞ (exact)"
    denom = total / linear
    return denom, f"1:{round(denom):,}"


def compute_traverse(
    start: Point,
    legs: list[Leg],
    traverse_type: str = "closed",
    adjustment: str = "bowditch",
    end_known: Point | None = None,
) -> TraverseResult:
    """Compute and (for closed/link traverses) adjust a traverse.

    traverse_type: "closed" (loop), "link" (onto end_known), or "open".
    adjustment:    "bowditch", "transit", or "none".
    """
    raw = _raw_coords(start, legs)
    total_distance = sum(leg.distance for leg in legs)

    # Determine the closing target.
    if traverse_type == "open":
        misclose_e = misclose_n = 0.0
    elif traverse_type == "link":
        if end_known is None:
            raise ValueError("link traverse requires end_known")
        misclose_e = raw[-1].east - end_known.east
        misclose_n = raw[-1].north - end_known.north
    else:  # closed loop
        misclose_e = raw[-1].east - start.east
        misclose_n = raw[-1].north - start.north

    linear = math.hypot(misclose_e, misclose_n)
    denom, denom_text = _relative_precision(linear, total_distance)

    n = len(legs)
    residuals: list[dict] = []
    sigma0 = 0.0

    use_lsq = adjustment == "lsq" and traverse_type in ("closed", "link")
    if use_lsq:
        # Parametric least-squares adjustment (numpy). Open traverses have no
        # redundancy, so LSQ silently falls back to no adjustment for them.
        from .lsq import least_squares_adjust
        lsq = least_squares_adjust(
            start, legs, raw, closed=(traverse_type == "closed"), end_known=end_known
        )
        adj_points = lsq.points
        residuals = lsq.residuals
        sigma0 = lsq.sigma0
    else:
        # Distribute the misclosure (corrections are subtracted from raw deltas).
        corr_e = [0.0] * n
        corr_n = [0.0] * n
        if traverse_type != "open" and adjustment in ("bowditch", "transit") and linear > 0:
            if adjustment == "bowditch":
                for i, leg in enumerate(legs):
                    w = leg.distance / total_distance if total_distance else 0.0
                    corr_e[i] = -misclose_e * w
                    corr_n[i] = -misclose_n * w
            else:  # transit
                sum_abs_de = sum(abs(leg.d_east) for leg in legs) or 1.0
                sum_abs_dn = sum(abs(leg.d_north) for leg in legs) or 1.0
                for i, leg in enumerate(legs):
                    corr_e[i] = -misclose_e * (abs(leg.d_east) / sum_abs_de)
                    corr_n[i] = -misclose_n * (abs(leg.d_north) / sum_abs_dn)
        adj_points = [start]
        cur = start
        for i, leg in enumerate(legs):
            cur = Point(
                east=cur.east + leg.d_east + corr_e[i],
                north=cur.north + leg.d_north + corr_n[i],
                name=leg.to_name,
            )
            adj_points.append(cur)
            residuals.append({
                "leg": i + 1,
                "from": leg.from_name,
                "to": leg.to_name,
                "correction_east": corr_e[i],
                "correction_north": corr_n[i],
                "magnitude": math.hypot(corr_e[i], corr_n[i]),
            })

    # Build adjusted leg records from the adjusted station coordinates.
    adj_legs: list[AdjustedLeg] = []
    for i, leg in enumerate(legs):
        a, b = adj_points[i], adj_points[i + 1]
        adj_legs.append(AdjustedLeg(
            index=i + 1,
            from_name=leg.from_name,
            to_name=leg.to_name,
            bearing=normalize_deg(leg.bearing),
            distance=leg.distance,
            d_east_raw=leg.d_east,
            d_north_raw=leg.d_north,
            d_east_adj=b.east - a.east,
            d_north_adj=b.north - a.north,
        ))

    points = adj_points
    # For a closed loop, the adjusted final point coincides with start; drop the
    # duplicate so `points` holds unique vertices.
    closed_loop = traverse_type == "closed"
    vertices = points[:-1] if closed_loop else points

    closure = Closure(
        misclose_east=misclose_e,
        misclose_north=misclose_n,
        linear_misclosure=linear,
        angular_misclosure=None,
        total_distance=total_distance,
        relative_precision=denom,
        relative_precision_text=denom_text,
    )

    from .geometry import area_hectares, polygon_area  # local import avoids cycle
    area_m2 = abs(polygon_area(vertices)) if closed_loop else 0.0
    area_ha = area_hectares(vertices) if closed_loop else 0.0

    return TraverseResult(
        type=traverse_type,
        adjustment=adjustment,
        points=vertices,
        legs=adj_legs,
        closure=closure,
        area_m2=area_m2,
        area_ha=area_ha,
        residuals=residuals,
        sigma0=sigma0,
    )
