import math

from app.cogo.geometry import Point
from app.cogo.traverse import Leg, compute_traverse


def test_perfect_square_closes():
    # A 100m square traverse closes exactly; misclosure ~ 0, area = 1 ha.
    start = Point(0, 0, "A")
    legs = [
        Leg(bearing=90, distance=100, from_name="A", to_name="B"),   # east
        Leg(bearing=180, distance=100, from_name="B", to_name="C"),  # south
        Leg(bearing=270, distance=100, from_name="C", to_name="D"),  # west
        Leg(bearing=0, distance=100, from_name="D", to_name="A"),    # north
    ]
    res = compute_traverse(start, legs, traverse_type="closed", adjustment="bowditch")
    assert res.closure.linear_misclosure < 1e-9
    assert abs(res.area_ha - 1.0) < 1e-6
    assert len(res.points) == 4  # duplicate closing point dropped


def test_bowditch_distributes_misclosure():
    # Introduce a deliberate misclosure by lengthening the last leg, then confirm
    # Bowditch removes it and corrections are weighted by leg length.
    start = Point(0, 0, "A")
    legs = [
        Leg(bearing=90, distance=100, from_name="A", to_name="B"),
        Leg(bearing=180, distance=100, from_name="B", to_name="C"),
        Leg(bearing=270, distance=100, from_name="C", to_name="D"),
        Leg(bearing=0, distance=100.4, from_name="D", to_name="A"),  # 0.4 m long
    ]
    res = compute_traverse(start, legs, traverse_type="closed", adjustment="bowditch")
    # Raw northing misclosure should be +0.4 (overshoot north).
    assert abs(res.closure.misclose_north - 0.4) < 1e-6
    assert abs(res.closure.linear_misclosure - 0.4) < 1e-6

    # After adjustment the loop must close: sum of adjusted deltas == 0.
    sum_de = sum(lg.d_east_adj for lg in res.legs)
    sum_dn = sum(lg.d_north_adj for lg in res.legs)
    assert abs(sum_de) < 1e-9
    assert abs(sum_dn) < 1e-9

    # Relative precision = total length / misclosure ≈ 400.4 / 0.4 ≈ 1001.
    assert res.closure.relative_precision is not None
    assert abs(res.closure.relative_precision - (res.closure.total_distance / 0.4)) < 1e-3


def test_transit_also_closes():
    start = Point(0, 0, "A")
    legs = [
        Leg(bearing=90, distance=100),
        Leg(bearing=180, distance=100),
        Leg(bearing=270, distance=100),
        Leg(bearing=0, distance=100.4),
    ]
    res = compute_traverse(start, legs, traverse_type="closed", adjustment="transit")
    sum_de = sum(lg.d_east_adj for lg in res.legs)
    sum_dn = sum(lg.d_north_adj for lg in res.legs)
    assert abs(sum_de) < 1e-9
    assert abs(sum_dn) < 1e-9


def test_link_traverse_closes_onto_known():
    start = Point(0, 0, "A")
    legs = [
        Leg(bearing=90, distance=100, to_name="B"),
        Leg(bearing=90, distance=100.2, to_name="C"),  # slight overshoot
    ]
    end_known = Point(200, 0, "C")
    res = compute_traverse(start, legs, traverse_type="link",
                           adjustment="bowditch", end_known=end_known)
    # Adjusted final coordinate must equal the known end point.
    final = res.points[-1]
    assert abs(final.east - 200) < 1e-6
    assert abs(final.north - 0) < 1e-6
