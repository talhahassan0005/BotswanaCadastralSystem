/**
 * Single source of truth for the project coordinate-system dropdown, so the
 * Stage-2 New Project form and the COGO Engine panel always offer the SAME
 * options (previously the COGO panel was missing Lo 29 / WGS84, which made a
 * Lo-29 project display as "Lo 21").
 *
 * `value` is what is stored in config.coordinateSystem; crs.transformPoint
 * normalises it ("Lo 29 Botswana" → "Lo29").
 */
export const COORDINATE_SYSTEM_OPTIONS: { value: string; label: string }[] = [
  { value: "Lo 21 Botswana", label: "Lo 21° Botswana" },
  { value: "Lo 23 Botswana", label: "Lo 23° Botswana" },
  { value: "Lo 25 Botswana", label: "Lo 25° Botswana" },
  { value: "Lo 27 Botswana", label: "Lo 27° Botswana" },
  { value: "Lo 29 Botswana", label: "Lo 29° Botswana" },
  { value: "UTM 34S", label: "UTM 34S" },
  { value: "UTM 35S", label: "UTM 35S" },
  { value: "WGS84", label: "WGS84 (lat/lon)" },
];

/** CRS label for official documents — strips the " Botswana" suffix
 *  (no-op for UTM / WGS84 which carry no suffix), so every deliverable
 *  prints the coordinate system the same way (e.g. "Lo 25"). */
export const displayCrs = (c: string): string => (c || "").replace(" Botswana", "");
