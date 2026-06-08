"""FastAPI compute engine — COGO, traverse adjustment, area, intersections, curves.

This service is stateless: data in, results out. The Express app is the
system-of-record and calls these endpoints over internal HTTP.
"""
from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from . import crs
from .cogo import geometry as geo
from .cogo.angles import format_dms, parse_bearing
from .cogo.geometry import Point
from .cogo.traverse import Leg, compute_traverse
from .models import (
    AreaRequest,
    CurveRequest,
    IntersectionRequest,
    InverseRequest,
    TransformRequest,
    TraverseRequest,
)

app = FastAPI(title="Botswana Cadastral Compute Engine", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "cogo-engine"}


def _pt(p) -> Point:
    return Point(east=p.east, north=p.north, name=p.name)


@app.post("/cogo/traverse")
def traverse(req: TraverseRequest) -> dict:
    try:
        legs = [
            Leg(
                bearing=parse_bearing(l.bearing),
                distance=l.distance,
                from_name=l.from_name,
                to_name=l.to_name,
            )
            for l in req.legs
        ]
        result = compute_traverse(
            start=_pt(req.start),
            legs=legs,
            traverse_type=req.type,
            adjustment=req.adjustment,
            end_known=_pt(req.end_known) if req.end_known else None,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    c = result.closure
    return {
        "type": result.type,
        "adjustment": result.adjustment,
        "closure": {
            "misclose_east": round(c.misclose_east, 4),
            "misclose_north": round(c.misclose_north, 4),
            "linear_misclosure": round(c.linear_misclosure, 4),
            "total_distance": round(c.total_distance, 3),
            "relative_precision": c.relative_precision,
            "relative_precision_text": c.relative_precision_text,
        },
        "area_m2": round(result.area_m2, 3),
        "area_ha": round(result.area_ha, 4),
        "points": [
            {"name": p.name, "east": round(p.east, 3), "north": round(p.north, 3)}
            for p in result.points
        ],
        "legs": [
            {
                "index": lg.index,
                "from": lg.from_name,
                "to": lg.to_name,
                "bearing": round(lg.bearing, 6),
                "bearing_dms": format_dms(lg.bearing),
                "distance": round(lg.distance, 3),
                "d_east_adj": round(lg.d_east_adj, 3),
                "d_north_adj": round(lg.d_north_adj, 3),
            }
            for lg in result.legs
        ],
        "sigma0": round(result.sigma0, 5),
        "residuals": [
            {k: (round(v, 5) if isinstance(v, float) else v) for k, v in r.items()}
            for r in result.residuals
        ],
    }


@app.post("/cogo/inverse")
def inverse(req: InverseRequest) -> dict:
    bearing, distance = geo.inverse(_pt(req.from_point), _pt(req.to_point))
    return {
        "bearing": round(bearing, 6),
        "bearing_dms": format_dms(bearing),
        "distance": round(distance, 4),
    }


@app.post("/cogo/area")
def area(req: AreaRequest) -> dict:
    pts = [_pt(p) for p in req.points]
    if len(pts) < 3:
        raise HTTPException(status_code=400, detail="need at least 3 points")
    return {
        "area_m2": round(abs(geo.polygon_area(pts)), 3),
        "area_ha": round(geo.area_hectares(pts), 4),
        "perimeter": round(geo.perimeter(pts), 3),
    }


@app.post("/cogo/intersection")
def intersection(req: IntersectionRequest) -> dict:
    try:
        if req.method == "bb":
            p = geo.intersect_bearing_bearing(
                _pt(req.a), parse_bearing(req.bearing_a),
                _pt(req.b), parse_bearing(req.bearing_b),
            )
        elif req.method == "dd":
            p = geo.intersect_distance_distance(
                _pt(req.a), req.radius_a, _pt(req.b), req.radius_b
            )
        elif req.method == "bd":
            p = geo.intersect_bearing_distance(
                _pt(req.a), parse_bearing(req.bearing_a), _pt(req.b), req.radius_b
            )
        else:
            raise ValueError(f"unknown intersection method: {req.method}")
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"east": round(p.east, 4), "north": round(p.north, 4)}


@app.post("/cogo/curve")
def curve(req: CurveRequest) -> dict:
    return geo.circular_curve(req.radius, req.deflection_deg)


# ---------------------------------------------------------------------------
# Module B — Botswana coordinate systems
# ---------------------------------------------------------------------------
@app.get("/crs/list")
def crs_list() -> dict:
    return {"systems": crs.CRS_LIST}


@app.post("/crs/transform")
def crs_transform(req: TransformRequest) -> dict:
    """Transform a batch of coordinate pairs from one CRS to another.

    For projected systems (Lo*, UTM*) each point is (a=Y/easting, b=X/northing);
    for geographic systems (WGS84, Arc1950) each point is (a=lat, b=lon).
    """
    try:
        out = []
        for p in req.points:
            a, b = crs.transform_point(p.a, p.b, req.src, req.dst)
            geographic = crs.is_geographic(req.dst)
            out.append({
                "name": p.name,
                "a": round(a, 8 if geographic else 3),
                "b": round(b, 8 if geographic else 3),
            })
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"src": req.src, "dst": req.dst, "points": out}
