import math

from app.cogo.geometry import (
    Point,
    area_hectares,
    circular_curve,
    forward,
    intersect_bearing_bearing,
    intersect_distance_distance,
    inverse,
    polygon_area,
)


def test_forward_inverse_roundtrip():
    a = Point(1000.0, 2000.0)
    b = forward(a, 73.5, 250.0)
    brg, dist = inverse(a, b)
    assert abs(brg - 73.5) < 1e-6
    assert abs(dist - 250.0) < 1e-6


def test_forward_cardinals():
    a = Point(0, 0)
    east = forward(a, 90, 100)
    assert abs(east.east - 100) < 1e-9 and abs(east.north) < 1e-9
    north = forward(a, 0, 100)
    assert abs(north.north - 100) < 1e-9 and abs(north.east) < 1e-9


def test_square_area():
    # 100 x 100 square = 10 000 m^2 = 1 ha
    sq = [Point(0, 0), Point(100, 0), Point(100, 100), Point(0, 100)]
    assert abs(abs(polygon_area(sq)) - 10_000) < 1e-6
    assert abs(area_hectares(sq) - 1.0) < 1e-9


def test_intersection_bearing_bearing():
    a = Point(0, 0)
    b = Point(100, 0)
    # ray north-east from a (45) and north-west from b (315) meet at (50,50)
    p = intersect_bearing_bearing(a, 45, b, 315)
    assert abs(p.east - 50) < 1e-6
    assert abs(p.north - 50) < 1e-6


def test_intersection_distance_distance():
    a = Point(0, 0)
    b = Point(100, 0)
    p = intersect_distance_distance(a, 50 * math.sqrt(2), b, 50 * math.sqrt(2),
                                    prefer_right=False)
    assert abs(p.east - 50) < 1e-6
    assert abs(p.north - 50) < 1e-6


def test_circular_curve():
    c = circular_curve(radius=100.0, deflection_deg=90.0)
    assert abs(c["arc_length"] - (100 * math.pi / 2)) < 1e-6
    assert abs(c["tangent"] - 100.0) < 1e-6  # tan(45)=1
