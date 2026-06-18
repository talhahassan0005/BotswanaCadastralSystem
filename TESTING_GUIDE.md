# Botswana Cadastral System — Manual Testing Guide

A practical checklist for testing every part of the app by hand, the way a client
would. Work top to bottom. Each module has three things to check:

- **Do this** — the normal (happy-path) steps.
- **Should see** — what a correct result looks like.
- **Try to break it** — the odd inputs a real user throws at it; the app should
  stay calm (clear message or disabled button), never a blank screen or a raw
  error / stack trace.

> Rule of thumb: a *clear message* (red text, amber notice, or a short pop-up) is
> a PASS. A *crash, blank panel, "NaN", "undefined", "Failed to fetch", or
> "Unexpected token <"* is a FAIL — write it down.

---

## 0. Before you start

1. App is running (dev: `npm --workspace apps/web run dev`, opens on
   `http://localhost:3001`; or the deployed Vercel URL).
2. Use Chrome or Edge (latest). Open the browser **Console** (F12) — if any test
   turns the console red, note it.
3. Sign in (or sign up) so cloud Save/Open works. If Supabase is not configured,
   the app runs without login — that is expected, Save/Open just won't appear.

---

## 1. Golden path — 10-minute end-to-end smoke test

This proves the whole pipeline works. Do it first; if it passes, the core is healthy.

1. **Log in** → land on "Start a project".
2. **New Project** → name "Test Lot 14182", pick Coordinate system **Lo 21 Botswana**,
   pick discipline **Cadastral** → **Create project →**.
3. **Data Import** → **Load sample** → table shows 6 rows A–F, all green/valid.
4. **Proceed to COGO →**.
5. **COGO Engine** → **Run COGO Computation** → closure ≈ **1:334,976**, area ≈
   **35.9793 ha**, adjusted traverse table A→B→…→A.
6. **Parcels** → **From COGO** (or From Import) to load beacons → click 3+ beacons
   in order → **Create parcel →** → a parcel appears with area.
7. **Diagrams** → a Surveyed Diagram preview is shown → **Download SVG** → file saves.
8. **Working Plan** / **General Plan** → drawing renders → **Print / Save PDF** →
   print window opens (allow pop-ups if asked).
9. **AI Validate** → **Run AI Validation** → score + check cards appear.
10. **Export** → **Download CSV**, **Download DXF**, **Download JSON** → all save.
11. **File ▾ → Save** → "Saved …". Then **File ▾ → Open…** → reopen it → data is back.

If all 11 steps pass, do the per-module detail below.

---

## 2. Module-by-module

### Data Import
- **Do this:** Load sample; then Browse / drag a real CSV; click "Remove / unload file".
- **Should see:** filename + row count in header; valid rows green, problems
  amber/red with a reason in the Issues column; CRS chip matches your project.
- **Try to break it:**
  - Upload a `.dwg` / `.dxf` / `.pdf` / image → clear red message ("not observation
    data" / "export as CSV"), no crash.
  - Upload a binary file renamed `.csv` → "isn't readable text" message.
  - Empty file or only blank lines → amber "no data rows" notice, 0 rows.
  - European file (`A;93205,88;2464520,65`) → parses correctly.

### COGO Engine
- **Do this:** With data imported, set Traverse type = Closed, Adjustment = Bowditch,
  Run.
- **Should see:** Closure (linear, ΔE/ΔN, relative precision), Adjustment Summary
  (method, max residual, area), and the Adjusted Traverse Table.
- **Try to break it:**
  - Run with **no data** → friendly message to import first; no crash.
  - **Link** traverse with empty / non-numeric "Known end" → message asks for valid
    numeric End coordinates (must NOT show "NaN m").
  - Change Traverse type to **Open** → area becomes 0, precision "N/A (open)".
  - Switch Adjustment (Transit / Least Squares) on the sample → numbers look the
    same and a note explains *why* (misclosure is negligible). This is correct.
  - Disconnect network mid-run → after a few auto-retries, friendly "Could not
    reach the computation server…" (no "Failed to fetch").

### Traverse Adjustment (read-only)
- **Do this:** After COGO, open this tab.
- **Should see:** Closure / Adjustment / Residuals / Data-consistency reports.
- **Try to break it:** Open it before running COGO → "No traverse computed yet" +
  a working "Go to COGO Engine" button.

### Topo Survey
- **Do this:** Load sample (or paste `Name,E,N,RL` lines) → Build surface.
- **Should see:** stat tiles, shaded TIN map with brown contours, contour table.
- **Try to break it:** empty box → "paste or load points"; under 3 points → "need
  at least 3"; all points in a line → "collinear/degenerate" message.

### Volume
- **Do this:** Each method tab (Surface / Cross-section / Grid / Contour) has a
  pre-filled sample — Compute volume on each.
- **Should see:** Cut / Fill / Net cards; Surface method also shows a cut/fill map.
- **Try to break it:** under-minimum points, decreasing chainages, unequal grid
  rows, zero cell size, letters in the grid → each gives a specific red message.

### Editor (drafting)
- **Do this:** Load sample; draw Point / Line / Rect / Circle / Text; Measure;
  add a layer; Undo/Redo; Export SVG/DXF/CSV; Save/Open JSON.
- **Should see:** entities draw on the current layer and select with green handles;
  Measure shows distance + bearing.
- **Try to break it:**
  - Import a corrupt / wrong-format DXF, SHP or JSON → a clear pop-up now says it
    could not be read (it used to do nothing silently).
  - Scale × 0 / empty rotation → nothing happens, no crash.
  - Try to delete the last layer → blocked.

### Parcels / Subdivision
- **Do this:** Add beacons (or From COGO/Import/Topo); select 3+ in order →
  Create parcel; open Parcel detail; Compute subdivision point (Polar / On-line /
  Intersection); Subdivide.
- **Should see:** plot redraws, computed points show as pink dots, area/perimeter
  + side bearings table, validation badges.
- **Try to break it:**
  - Distance / radius = 0 or blank → "Enter a distance greater than 0".
  - New point name blank or duplicate → clear message.
  - Parallel bearings in Bearing-Bearing intersection → "no unique intersection".
  - Pick beacons in zig-zag order → parcel still forms but validation flags
    "boundary self-intersects".

### Diagrams
- **Do this:** After COGO, switch type (Surveyed / Framed / Compiled / Borehole /
  Tribal Lease); edit title-block fields; Download SVG; Print / Save PDF.
- **Should see:** live SVG with figure, beacons, bearings, coordinate table, legal
  block; Botswana number format (+93 205,88) and dotted bearings (272.36.20).
- **Try to break it:** open before COGO → "No computed figure yet"; block pop-ups
  then Print → now a clear "Pop-up blocked" message (used to do nothing).

### Working Plan / General Plan / Sectional Title / Survey Record
- **Do this:** Fill the title-block / detail fields; watch the drawing update;
  Download SVG; Print / Save PDF. (General Plan: page through sheets. Sectional
  Title: add sections with floor areas → quotas auto-compute. Survey Record: switch
  the 5 document tabs, Copy text.)
- **Should see:** live updates; quotas sum to 1.0000; documents show amber "run X
  first" notices when a prerequisite is missing (not blank).
- **Try to break it:** open before building a figure/parcel → graceful empty state
  with a "Go to …" button; Print with pop-ups blocked → clear message.

### GIS Map
- **Do this:** With a parcel / closed traverse, open the map; switch Satellite/Streets;
  Export KML; Open in Google Earth.
- **Should see:** beacons (cyan) and parcel (yellow) overlaid, view zooms to fit.
- **Try to break it:** no data → centred on Botswana, KML button disabled; offline
  → "map library failed to load (check internet connection)"; wrong CRS for the
  coordinates → "doesn't match the stored coordinates. Check the project CRS."

### Surveyors (Collaborate)
- **Do this:** Use my location → Check in → see yourself + others on the list/map →
  Check out.
- **Try to break it:** deny location → grey message, can't check in; signed out →
  "Sign in to check in"; uncheck "share contact" → your number is not shown to others.

### Reference Marks
- **Do this:** Search a town/number; click a mark → detail (Lat/Lon, Lo Y/X);
  "Nearest to me"; Directions / View on map.
- **Try to break it:** search nonsense → "No marks match"; deny location → message,
  list reverts; offline → falls back to the built-in seed list.

### Export
- **Do this:** Download CSV / DXF / JSON; check the source line ("from COGO / parcels
  / import"); open the files.
- **Should see:** CSV header `Beacon,East,North`; DXF has a closed boundary only
  when COGO produced 3+ points; a beacon id with a comma is now quoted (no broken
  columns).
- **Not a bug:** no SHP export (planned), no PDF here (use Print on the document tabs).

### AI Validate
- **Do this:** After importing + COGO, Run AI Validation.
- **Should see:** 5 stat tiles, per-rule check cards, and a written report (Source:
  "Groq AI" or "offline fallback").
- **Not a bug:** "offline fallback" when no GROQ key is set — the checks still run.

### Auth + Save / Open / Delete
- **Do this:** Sign up, log in, Save, Open, Save as…, sign out, log back in, reopen.
- **Try to break it:** wrong password → Supabase message in red; blank Save name →
  falls back to "Untitled Survey"; Open with none saved → "No saved projects yet".
- **Note:** Delete has **no confirmation** — it removes instantly. Opening another
  project **replaces** the current one — Save first.

---

## 3. Expected behaviour — do NOT report these as bugs

These are by design, confirmed against the code:

- **Adjustment method shows no visible change** on a near-perfect traverse (like the
  sample) — the misclosure is sub-millimetre, so all methods give the same numbers.
- **Coordinate system** only labels the documents; it does **not** change the
  traverse maths (bearings/distances/area are the same in any belt).
- **Scale 1:N** on diagrams/plans is a printed label only; the drawing always
  auto-fits the panel (it does not rescale the figure).
- **No file-size limit** anywhere — a huge CSV/DXF can lag the browser; that is a
  performance limit, not a crash.
- **No duplicate-ID rejection at import** — duplicates are caught later by COGO /
  Parcels / AI-Validate, not by the import screen.
- **General Plan** shows the first 30 parcels in the schedule and 48 beacons per
  coordinate sheet (the rest are noted / paginated).
- **Sectional Title** plan draws the first 30 sections / 12 bars (the table lists all).
- **GIS Map / Reference-mark map** need internet (tiles + map library load from a CDN).
- **No SHP export** and **no in-app PDF generator** — PDF is via the browser's
  Print → Save as PDF on the document tabs.
- **Print** opens a new window — if the browser blocks pop-ups you now get a clear
  "Pop-up blocked" message; allow pop-ups and retry.

---

## 4. Cross-cutting checks (do these once)

- **Refresh mid-work:** unsaved in-memory work resets to the empty state (Save first).
  Saved projects reopen fully via File → Open.
- **Offline:** computation calls auto-retry then show a friendly message; SVG export,
  printing and the Editor work offline; GIS map and reference-mark directions need
  internet.
- **No emojis:** the UI should use plain monochrome icons and arrows only — flag any
  colourful emoji.
- **Mobile / narrow window:** tabs scroll horizontally; tables scroll; nothing should
  overflow off-screen.
- **Every "Run / Compute / Build" button:** disables itself while busy (shows
  "Computing…/Validating…/Processing…") so a double-click can't fire two requests.

---

## 5. Sign-off checklist

- [ ] Golden path (Part 1) passes end to end.
- [ ] Every tab opens without a blank panel or console error.
- [ ] Every "break it" test gives a clear message, not a crash.
- [ ] Save → reopen restores the project.
- [ ] Print / Download works on every document tab (pop-ups allowed).
- [ ] No emojis; no raw error text ("NaN", "undefined", "Failed to fetch") anywhere.
