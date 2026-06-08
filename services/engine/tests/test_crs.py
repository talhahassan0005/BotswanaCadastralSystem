import math

from app import crs


def test_utm_roundtrip():
    # A point in Botswana (~Gaborone area): lat -24.65, lon 25.91 -> UTM 35S
    lat, lon = -24.6541, 25.9087
    e, n = crs.utm_forward(lat, lon, 35)
    blat, blon = crs.utm_inverse(e, n, 35)
    assert abs(blat - lat) < 1e-7
    assert abs(blon - lon) < 1e-7
    # Easting should be within the valid UTM band, northing positive (south hemi).
    assert 100_000 < e < 900_000
    assert 7_000_000 < n < 7_400_000


def test_lo_roundtrip():
    # Arc1950 geodetic near Charleshill (Ghanzi), CM 21
    lat, lon = -22.14, 21.85
    y, x = crs.lo_forward(lat, lon, 21)
    blat, blon = crs.lo_inverse(y, x, 21)
    assert abs(blat - lat) < 1e-7
    assert abs(blon - lon) < 1e-7
    # X (southing) ~ 2.45M m for ~22°S; Y east of CM => negative (west-positive axis)
    assert 2_400_000 < x < 2_500_000


def test_datum_shift_roundtrip():
    lat, lon = -22.0, 24.0
    wlat, wlon = crs.arc1950_to_wgs84_geodetic(lat, lon)
    alat, alon = crs.wgs84_to_arc1950_geodetic(wlat, wlon)
    assert abs(alat - lat) < 1e-7
    assert abs(alon - lon) < 1e-7
    # Datum shift moves the point on the order of ~100 m (sub-arcsecond in deg)
    assert abs(wlat - lat) < 0.01
    assert abs(wlon - lon) < 0.01


def test_transform_lo_to_wgs84_roundtrip():
    # Lo21 plane -> WGS84 -> back to Lo21 returns the same plane coords.
    y, x = 93205.88, 2464520.65
    lat, lon = crs.transform_point(y, x, "Lo21", "WGS84")
    assert -90 < lat < 0 and 0 < lon < 90
    by, bx = crs.transform_point(lat, lon, "WGS84", "Lo21")
    assert abs(by - y) < 1e-3
    assert abs(bx - x) < 1e-3


def test_transform_lo_to_utm():
    # Round-trip Lo21 -> UTM34S -> Lo21
    y, x = 50000.0, 2450000.0
    e, n = crs.transform_point(y, x, "Lo21", "UTM34S")
    by, bx = crs.transform_point(e, n, "UTM34S", "Lo21")
    assert abs(by - y) < 1e-2
    assert abs(bx - x) < 1e-2
