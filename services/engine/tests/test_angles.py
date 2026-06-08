import math

from app.cogo.angles import (
    deg_to_dms,
    dms_to_deg,
    format_dms,
    normalize_deg,
    parse_bearing,
)


def test_dms_roundtrip():
    deg = dms_to_deg(45, 12, 30)
    assert abs(deg - 45.2083333) < 1e-6
    d, m, s = deg_to_dms(deg)
    assert (d, m) == (45, 12)
    assert abs(s - 30) < 1e-3


def test_parse_decimal():
    assert abs(parse_bearing("45.5") - 45.5) < 1e-9


def test_parse_dotted_ddmmss():
    # SG diagram "DIRECTIONS" style: 272.36.20 -> 272 deg 36 min 20 sec
    assert abs(parse_bearing("272.36.20") - dms_to_deg(272, 36, 20)) < 1e-6


def test_parse_symbol_style():
    assert abs(parse_bearing("45°12'30\"") - dms_to_deg(45, 12, 30)) < 1e-6


def test_normalize():
    assert normalize_deg(370) == 10
    assert normalize_deg(-10) == 350


def test_format_dms():
    assert format_dms(45.2083333) == "45°12'30\""


def test_second_carry():
    # A value whose seconds round (to 4 dp) up to 60 must carry into minutes/degrees.
    d, m, s = deg_to_dms(10 + 59 / 60 + 59.99999 / 3600)
    assert (d, m) == (11, 0)
    assert s < 1e-3
