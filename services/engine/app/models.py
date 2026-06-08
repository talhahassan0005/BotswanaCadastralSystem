"""Pydantic request/response schemas for the compute engine API."""
from __future__ import annotations

from pydantic import BaseModel, Field


class PointIn(BaseModel):
    east: float
    north: float
    name: str | None = None


class LegIn(BaseModel):
    bearing: str | float = Field(..., description="Bearing in any supported notation")
    distance: float
    from_name: str | None = None
    to_name: str | None = None


class TraverseRequest(BaseModel):
    start: PointIn
    legs: list[LegIn]
    type: str = "closed"            # closed | link | open
    adjustment: str = "bowditch"    # bowditch | transit | none
    end_known: PointIn | None = None


class InverseRequest(BaseModel):
    from_point: PointIn
    to_point: PointIn


class AreaRequest(BaseModel):
    points: list[PointIn]


class IntersectionRequest(BaseModel):
    method: str                      # bb | dd | bd
    a: PointIn
    b: PointIn
    bearing_a: str | float | None = None
    bearing_b: str | float | None = None
    radius_a: float | None = None
    radius_b: float | None = None


class CurveRequest(BaseModel):
    radius: float
    deflection_deg: float


class CoordPair(BaseModel):
    a: float                  # Y / easting / latitude (depends on CRS)
    b: float                  # X / northing / longitude
    name: str | None = None


class TransformRequest(BaseModel):
    src: str                  # e.g. "Lo21", "WGS84", "UTM34S", "Arc1950"
    dst: str
    points: list[CoordPair]
