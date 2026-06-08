import math

from app.cogo.geometry import Point
from app.cogo.traverse import Leg, compute_traverse


def test_lsq_perfect_square_no_correction():
    start = Point(0, 0, "A")
    legs = [
        Leg(bearing=90, distance=100, from_name="A", to_name="B"),
        Leg(bearing=180, distance=100, from_name="B", to_name="C"),
        Leg(bearing=270, distance=100, from_name="C", to_name="D"),
        Leg(bearing=0, distance=100, from_name="D", to_name="A"),
    ]
    res = compute_traverse(start, legs, traverse_type="closed", adjustment="lsq")
    # A perfect figure needs essentially no adjustment.
    assert res.sigma0 < 1e-3
    assert abs(res.area_ha - 1.0) < 1e-6


def test_lsq_closes_misclosed_traverse():
    start = Point(0, 0, "A")
    legs = [
        Leg(bearing=90, distance=100, from_name="A", to_name="B"),
        Leg(bearing=180, distance=100, from_name="B", to_name="C"),
        Leg(bearing=270, distance=100, from_name="C", to_name="D"),
        Leg(bearing=0, distance=100.4, from_name="D", to_name="A"),
    ]
    res = compute_traverse(start, legs, traverse_type="closed", adjustment="lsq")
    # After LSQ the loop must close: adjusted deltas sum to ~0.
    sum_de = sum(lg.d_east_adj for lg in res.legs)
    sum_dn = sum(lg.d_north_adj for lg in res.legs)
    assert abs(sum_de) < 1e-6
    assert abs(sum_dn) < 1e-6
    # Residual report should be populated with direction/distance residuals.
    assert len(res.residuals) == 4
    assert "v_distance" in res.residuals[0]


def test_lsq_link_closes_onto_known():
    start = Point(0, 0, "A")
    legs = [
        Leg(bearing=90, distance=100, to_name="B"),
        Leg(bearing=90, distance=100.2, to_name="C"),
    ]
    end_known = Point(200, 0, "C")
    res = compute_traverse(start, legs, traverse_type="link",
                           adjustment="lsq", end_known=end_known)
    final = res.points[-1]
    assert abs(final.east - 200) < 1e-3
    assert abs(final.north - 0) < 1e-3
