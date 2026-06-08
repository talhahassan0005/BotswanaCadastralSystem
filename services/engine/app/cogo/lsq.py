"""Least-squares traverse adjustment (parametric / observation-equation method).

Unknowns are the coordinates of the free stations. Each leg contributes two
observations — a distance and a direction — so a closed or link traverse has
redundancy 2 (the two closure conditions), which least squares distributes
optimally by minimising the weighted sum of squared residuals.

Open traverses have no redundancy, so least squares is not applicable there.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .geometry import Point


@dataclass
class LsqResult:
    points: list[Point]          # adjusted coordinates (station order, incl. fixed start)
    residuals: list[dict]        # per-leg distance & bearing residuals
    sigma0: float                # reference standard deviation (unitless a-posteriori)
    iterations: int


def _wrap(rad: float) -> float:
    while rad > math.pi:
        rad -= 2 * math.pi
    while rad < -math.pi:
        rad += 2 * math.pi
    return rad


def least_squares_adjust(
    start: Point,
    legs,                         # list with .bearing (deg), .distance (m)
    provisional: list[Point],    # provisional coords P0..Pk from raw traverse
    closed: bool,
    end_known: Point | None,
    sigma_dist: float = 0.01,
    sigma_dir_sec: float = 5.0,
) -> LsqResult:
    """Adjust a closed/link traverse by least squares.

    `provisional` are the unadjusted station coordinates (length = legs + 1).
    The first station is fixed; for a closed loop the last station is the start;
    for a link traverse the last station is `end_known`.
    """
    k = len(legs)
    coords = [np.array([p.east, p.north], dtype=float) for p in provisional]

    # Fixed stations: index 0 always; last index for closed/link.
    fixed = {0}
    if closed:
        coords[k] = np.array([start.east, start.north], dtype=float)
        fixed.add(k)
    elif end_known is not None:
        coords[k] = np.array([end_known.east, end_known.north], dtype=float)
        fixed.add(k)

    free = [i for i in range(k + 1) if i not in fixed]
    col = {st: j for j, st in enumerate(free)}  # station -> unknown block index
    u = 2 * len(free)
    if u == 0:
        # nothing to adjust
        pts = [Point(c[0], c[1], provisional[i].name) for i, c in enumerate(coords)]
        return LsqResult(points=pts, residuals=[], sigma0=0.0, iterations=0)

    sig_dir = math.radians(sigma_dir_sec / 3600.0)
    w_dist = 1.0 / (sigma_dist ** 2)
    w_dir = 1.0 / (sig_dir ** 2)

    iterations = 0
    last_v = np.zeros(2 * k)
    W = np.zeros(2 * k)
    for _ in range(5):
        iterations += 1
        A = np.zeros((2 * k, u))
        l = np.zeros(2 * k)
        for i, leg in enumerate(legs):
            a, b = i, i + 1
            ea, na = coords[a]
            eb, nb = coords[b]
            de, dn = eb - ea, nb - na
            d = math.hypot(de, dn)
            if d < 1e-9:
                continue
            az = math.atan2(de, dn)
            # distance observation row
            r = 2 * i
            if b in col:
                A[r, col[b] * 2] = de / d
                A[r, col[b] * 2 + 1] = dn / d
            if a in col:
                A[r, col[a] * 2] = -de / d
                A[r, col[a] * 2 + 1] = -dn / d
            l[r] = leg.distance - d
            W[r] = w_dist
            # direction observation row
            rb = 2 * i + 1
            if b in col:
                A[rb, col[b] * 2] = dn / (d * d)
                A[rb, col[b] * 2 + 1] = -de / (d * d)
            if a in col:
                A[rb, col[a] * 2] = -dn / (d * d)
                A[rb, col[a] * 2 + 1] = de / (d * d)
            l[rb] = _wrap(math.radians(leg.bearing) - az)
            W[rb] = w_dir

        Wm = np.diag(W)
        N = A.T @ Wm @ A
        rhs = A.T @ Wm @ l
        try:
            dx = np.linalg.solve(N, rhs)
        except np.linalg.LinAlgError:
            dx = np.linalg.lstsq(N, rhs, rcond=None)[0]
        # apply corrections
        for st in free:
            coords[st] = coords[st] + dx[col[st] * 2 : col[st] * 2 + 2]
        last_v = A @ dx - l
        if np.max(np.abs(dx)) < 1e-6:
            break

    m = 2 * k
    dof = max(m - u, 1)
    sigma0 = float(math.sqrt((last_v @ (W * last_v)) / dof))

    pts = [Point(float(c[0]), float(c[1]), provisional[i].name) for i, c in enumerate(coords)]
    residuals = []
    for i, leg in enumerate(legs):
        residuals.append({
            "leg": i + 1,
            "from": getattr(leg, "from_name", None),
            "to": getattr(leg, "to_name", None),
            "v_distance": float(last_v[2 * i]),
            "v_direction_sec": float(math.degrees(last_v[2 * i + 1]) * 3600.0),
            "magnitude": float(abs(last_v[2 * i])),
        })
    return LsqResult(points=pts, residuals=residuals, sigma0=sigma0, iterations=iterations)
