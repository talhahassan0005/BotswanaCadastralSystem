/**
 * WKT1 (.prj) coordinate-system text for the project's own configured CRS
 * (client req 2026-09-24, Shapefile export requirement 4: "use the
 * project's actual configured coordinate system... don't hardcode one
 * system"). Parameters mirror lib/server/crs.ts exactly (same ellipsoids,
 * same Arc1950<->WGS84 3-parameter shift, same false easting/northing/scale
 * factor) — that file is the one source of truth for what this app means by
 * each CRS name; this only re-expresses the same numbers as WKT text so GIS
 * software can read them.
 *
 * The Lo (Gauss-Conform) belts are Y west-positive / X south-positive — the
 * opposite sign convention from a standard Transverse Mercator's easting/
 * northing — represented here with explicit AXIS[...,WEST]/AXIS[...,SOUTH]
 * entries rather than by negating the coordinates themselves, so a GIS
 * package that honours WKT axis directions displays/reprojects them
 * correctly without the geometry needing any sign flip at write time.
 */

const CLARKE1880_A = 6378249.145;
const CLARKE1880_RF = 293.4663077;
const WGS84_A = 6378137.0;
const WGS84_RF = 298.257223563;
const ARC1950_TO_WGS84 = "-138,-105,-289,0,0,0,0"; // matches crs.ts's ARC1950_TO_WGS84

const ARC1950_GEOGCS =
  `GEOGCS["Arc 1950",DATUM["Arc_1950",SPHEROID["Clarke 1880 (Arc)",${CLARKE1880_A},${CLARKE1880_RF}],` +
  `TOWGS84[${ARC1950_TO_WGS84}]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]`;
const WGS84_GEOGCS =
  `GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",${WGS84_A},${WGS84_RF}]],` +
  `PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]`;

function loWkt(cm: number): string {
  return (
    `PROJCS["Lo${cm} / Arc 1950",${ARC1950_GEOGCS},PROJECTION["Transverse_Mercator"],` +
    `PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",${cm}],` +
    `PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],` +
    `UNIT["metre",1],AXIS["Easting",WEST],AXIS["Northing",SOUTH]]`
  );
}

function utmWkt(zone: number): string {
  const cm = zone * 6 - 183; // matches crs.ts's utmForward/utmInverse
  return (
    `PROJCS["WGS 84 / UTM zone ${zone}S",${WGS84_GEOGCS},PROJECTION["Transverse_Mercator"],` +
    `PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",${cm}],` +
    `PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],` +
    `PARAMETER["false_northing",10000000],UNIT["metre",1],AXIS["Easting",EAST],AXIS["Northing",NORTH]]`
  );
}

/** `config.coordinateSystem` -> .prj WKT text. Accepts the exact values
 *  COORDINATE_SYSTEM_OPTIONS stores ("Lo 21 Botswana", "UTM 35S", "WGS84",
 *  ...) as well as the bare `Lo21`/`UTM35S` codes lib/server/crs.ts itself
 *  normalises to, so either naming convention resolves correctly. Falls
 *  back to Lo25 (Botswana's own most-used belt) only if the value is
 *  genuinely unrecognised, so export never hard-fails on an unexpected
 *  string — same "don't invent data silently" spirit as everywhere else,
 *  just needs SOME valid .prj for the file set to open at all. */
export function crsToWkt(code: string): string {
  const norm = (code || "").replace(/\s+/g, "").replace(/Botswana/i, "").replace("°", "").trim();
  const loMatch = /^Lo(\d+)$/i.exec(norm);
  if (loMatch) return loWkt(Number(loMatch[1]));
  const utmMatch = /^UTM(\d+)S$/i.exec(norm);
  if (utmMatch) return utmWkt(Number(utmMatch[1]));
  if (/^WGS84$/i.test(norm)) return WGS84_GEOGCS;
  if (/^Arc1950$/i.test(norm)) return ARC1950_GEOGCS;
  return loWkt(25);
}
