"""COGO (Coordinate Geometry) computation library.

Internal convention for all geometry:
  * Coordinates are planar (easting, northing) in metres.
  * Bearings are measured clockwise from grid north, in decimal degrees [0, 360).
  * Forward:  d_east = dist * sin(bearing);  d_north = dist * cos(bearing).

Botswana Lo (Y/X) <-> Easting/Northing conversion is handled by the
coordinate-systems layer (see app.crs), not here.
"""
