/**
 * Parser/validator for Botswana DSM-style survey CSV/TXT.
 * Ported verbatim from apps/api/src/utils/csv.ts so the web app parses imports
 * in-process (no Express backend needed on Vercel).
 *
 * Tolerant of:
 *   - comma or semicolon or tab/whitespace delimiters
 *   - European decimal comma ("93 205,88") and grouped thousands
 *   - header rows in any column order (fuzzy-matched by name)
 */

export interface ParsedRow {
  index: number;
  beaconId: string | null;
  east: number | null;
  north: number | null;
  bearing: string | null;
  distance: number | null;
  status: "valid" | "check" | "error";
  issues: string[];
  pointType?: "beacon" | "wp" | "ref"; // defaults to "beacon"; user re-tags WP / Ref
}

export interface ParseResult {
  rows: ParsedRow[];
  validCount: number;
  warningCount: number;
  errorCount: number;
  detectedColumns: string[];
  /** Top-level diagnostic shown to the user when the file looks wrong. */
  notice?: string;
}

const HEADER_ALIASES: Record<string, keyof Omit<ParsedRow, "index" | "status" | "issues">> = {
  beacon: "beaconId", "beacon id": "beaconId", id: "beaconId", point: "beaconId",
  station: "beaconId", name: "beaconId",
  east: "east", easting: "east", e: "east", y: "east", "y (m)": "east",
  north: "north", northing: "north", n: "north", x: "north", "x (m)": "north",
  bearing: "bearing", direction: "bearing", azimuth: "bearing",
  distance: "distance", dist: "distance", length: "distance", side: "distance",
};

/** Does a token look like a survey bearing (decimal, dotted DDD.MMSS or DMS)?
 *  Used to tell a real bearing apart from a beacon-description column such as
 *  "75MM CFP" or "IPC12", which must NOT be shown/used as a bearing. */
function looksLikeBearing(raw: string): boolean {
  const t = (raw ?? "").trim();
  if (!t) return false;
  // Strip quadrant letters (N/S/E/W); a genuine bearing then has no other letters.
  const core = t.replace(/[NSEW]/gi, "");
  if (/[A-Za-z]/.test(core)) return false; // "75MM CFP", "IPC12", "75mm peg" -> description
  return /\d/.test(core);
}

/** Parse a European/grouped numeric token. Returns null if not numeric. */
function parseNum(raw: string): number | null {
  if (raw == null) return null;
  let s = raw.trim();
  if (s === "" || s === "—" || s === "-") return null;
  // Remove spaces used as thousands separators (e.g. "93 205,88" / "2 464 520,65").
  s = s.replace(/\s+/g, "");
  // If both comma and dot exist, assume dot=thousands, comma=decimal (EU).
  if (s.includes(",") && s.includes(".")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function splitLine(line: string): string[] {
  // Delimiter precedence: an explicit ';' or tab wins over comma, so European
  // files ("A;93205,88;2464520,65" — semicolon delimiter + decimal comma) split
  // correctly instead of breaking on the decimal comma. Comma is the fallback
  // delimiter only when no ';'/tab is present.
  if (line.includes(";")) return line.split(";").map((c) => c.trim());
  if (line.includes("\t")) return line.split("\t").map((c) => c.trim());
  if (line.includes(",") && line.split(",").length >= line.split(/\s+/).length) {
    return line.split(",").map((c) => c.trim());
  }
  return line.split(/\s{2,}|\s/).map((c) => c.trim()).filter(Boolean);
}

/** Heuristic: does this text look like a binary / non-text file?
 *  Any NUL byte, or more than 10% control / replacement characters. */
function looksBinary(text: string): boolean {
  const sample = text.slice(0, 4000);
  if (!sample) return false;
  let nulls = 0;
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0) nulls++;
    if (c === 9 || c === 10 || c === 13) continue; // tab / LF / CR are fine
    if (c < 32 || c === 0xfffd) bad++; // control chars or UTF-8 replacement char
  }
  if (nulls > 0) return true;
  return bad / sample.length > 0.1;
}

export function parseSurveyCsv(text: string): ParseResult {
  if (looksBinary(text)) {
    throw new Error(
      "This file isn't readable text — it looks like a binary or non-CSV file (e.g. DWG, DGN, an image, or a ZIP). " +
        "Please upload a CSV or TXT file with columns such as: Beacon, East, North [, Bearing, Distance]."
    );
  }

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  if (lines.length === 0) {
    return {
      rows: [], validCount: 0, warningCount: 0, errorCount: 0, detectedColumns: [],
      notice: "The file has no data rows (it is empty, or only blank/comment lines).",
    };
  }

  const firstCells = splitLine(lines[0]).map((c) => c.toLowerCase());
  // A real header row has >=2 recognised column names AND no numeric coordinates.
  // This stops a headerless data row whose first id happens to be an alias token
  // (e.g. a beacon literally named "E" or "Point") from being eaten as a header.
  const aliasHits = firstCells.filter((c) => c in HEADER_ALIASES).length;
  const firstRowHasNumbers = firstCells.some((c) => parseNum(c) != null);
  const hasHeader = aliasHits >= 2 && !firstRowHasNumbers;

  type Field = keyof Omit<ParsedRow, "index" | "status" | "issues">;
  let colMap: (Field | undefined)[] = [];
  let dataLines = lines;
  const detectedColumns: string[] = [];

  if (hasHeader) {
    // Map known headers; UNKNOWN columns (e.g. Z / elevation / code / remarks) are
    // ignored — not dumped into the beacon id (which previously corrupted X,Y,Z files).
    colMap = firstCells.map((c) => HEADER_ALIASES[c]);
    if (!colMap.includes("beaconId")) {
      const firstFree = colMap.findIndex((f) => f === undefined);
      if (firstFree >= 0) colMap[firstFree] = "beaconId";
    }
    detectedColumns.push(...firstCells);
    dataLines = lines.slice(1);
  } else {
    // Positional (no header). Decide the layout from the column count:
    //   >= 5 cols -> observation file (id, east, north, bearing, distance)
    //   3-4 cols  -> coordinate list (id, east, north[, elevation/description])
    // The 4th column of a coordinate file is Z/elevation or a beacon description —
    // NOT a bearing — so it must not be mapped to bearing (which would otherwise
    // show a Z like "994.89" under the Bearing column).
    const maxCols = Math.max(3, ...dataLines.map((l) => splitLine(l).length));
    if (maxCols >= 5) {
      colMap = ["beaconId", "east", "north", "bearing", "distance"];
      detectedColumns.push("(positional: id, east, north, bearing, distance)");
    } else {
      colMap = ["beaconId", "east", "north"];
      detectedColumns.push(
        maxCols >= 4 ? "(positional: id, east, north [+ elevation/description])" : "(positional: id, east, north)"
      );
    }
  }

  const rows: ParsedRow[] = [];
  let validCount = 0,
    warningCount = 0,
    errorCount = 0;

  dataLines.forEach((line, i) => {
    const cells = splitLine(line);
    const row: ParsedRow = {
      index: i + 1,
      beaconId: null,
      east: null,
      north: null,
      bearing: null,
      distance: null,
      status: "valid",
      issues: [],
      pointType: "beacon", // every imported point starts as a plot beacon
    };

    cells.forEach((cell, ci) => {
      const field = colMap[ci];
      if (!field) return;
      if (field === "beaconId") {
        row.beaconId = cell || null;
      } else if (field === "bearing") {
        // Only accept a real bearing here; a beacon-description column (e.g.
        // "75MM CFP", "IPC12") is ignored rather than mislabelled as a bearing.
        row.bearing = cell && looksLikeBearing(cell) ? cell : null;
      } else {
        (row[field] as number | null) = parseNum(cell);
      }
    });

    if (!row.beaconId) row.issues.push("missing beacon id");
    if (row.east == null || row.north == null) {
      if (row.distance == null || row.distance === 0) {
        row.issues.push("missing coordinates and distance");
        row.status = "error";
      } else {
        row.issues.push("coordinates not yet computed");
        if (row.status !== "error") row.status = "check";
      }
    }
    if (row.distance === 0) {
      row.issues.push("zero distance");
      row.status = "error";
    }
    if (row.bearing == null && row.east == null) {
      row.issues.push("no bearing");
      if (row.status === "valid") row.status = "check";
    }

    if (row.status === "valid") validCount++;
    else if (row.status === "check") warningCount++;
    else errorCount++;

    rows.push(row);
  });

  // Top-level diagnostic when nothing usable parsed.
  let notice: string | undefined;
  const anyCoords = rows.some((r) => r.east != null && r.north != null);
  const anyNumeric = rows.some((r) => r.east != null || r.north != null || r.distance != null);
  if (!anyNumeric) {
    const recognised = detectedColumns.some((c) => /east|north/.test(c));
    notice = recognised
      ? `Recognised the columns (${detectedColumns.join(", ")}) but couldn't read any numbers — this usually means the field delimiter or decimal format wasn't handled (e.g. a semicolon ';' file with European decimal commas like 93205,88). Check the delimiter / decimal separator and re-upload.`
      : `No numeric values were detected in any column — this doesn't look like a coordinate/observation file. Expected columns like Beacon, East, North, Bearing, Distance. Detected columns: ${detectedColumns.join(", ") || "none"}.`;
  } else if (validCount === 0 && !anyCoords) {
    notice =
      "No East/North coordinates were detected. Check that the file has Easting and Northing columns with numeric values. " +
      `Detected columns: ${detectedColumns.join(", ") || "none"}.`;
  } else if (validCount === 0) {
    notice = "No fully valid rows — see the Issues column for what each row is missing.";
  }

  return { rows, validCount, warningCount, errorCount, detectedColumns, notice };
}
