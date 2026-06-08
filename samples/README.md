# Sample survey data

Import any of these via **Data Import → Browse file** (or drag-and-drop).

Column format (Botswana DSM style): `Beacon ID, Easting/Y, Northing/X, Bearing, Distance`
- Coordinates in metres (dot decimal — comma is the CSV delimiter).
- Bearing in `DDD.MM.SS` dotted notation (e.g. `272.36.20`) — the same notation as the
  "DIRECTIONS" column on a Botswana SG diagram. Decimal degrees and `45°12'30"` also work.
- Each row carries the beacon's coordinates **and the side leaving it** (to the next beacon).
  The closing side returns to the first beacon.

## Files

### `lot-14182-charleshill.csv`  ← REAL client data
Transcribed directly from **DG-Model.pdf** (Lot 14182 Charleshill, a portion of Cadastre 243,
Ghanzi Tribal Area, System Lo 21°). 6 beacons (A–F), all 12 mm iron pegs.

This is the acceptance test for the COGO engine. Running it as a **Closed Traverse**:
- Relative precision: **1:334,976** (well within the 1:3 000 DSM limit)
- Computed area: **35.9793 ha** vs the published **35.9794 ha** (≈ 1 m² difference)
- Adjusted coordinates reproduce the published Y/X values to **≤ 1 cm** (rounding only)

> Use coordinate system **Lo 21° Botswana** for this parcel.

### `sample-parcel-5beacon.csv`
A clean synthetic 5-beacon parcel (closes ~1:144 000, area 4.2486 ha) for quick demos.

## Quick start
1. Data Import → **Browse file** → choose a CSV above (or click **Load sample**).
2. **Proceed to COGO** → Closed Traverse → Bowditch (or Least Squares) → **Run COGO Computation**.
3. **Traverse** tab → closure / adjustment / residuals / consistency reports.
4. **Diagrams** tab → generated SG diagram.
