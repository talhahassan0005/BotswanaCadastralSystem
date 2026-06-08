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
}

export interface ParseResult {
  rows: ParsedRow[];
  validCount: number;
  warningCount: number;
  errorCount: number;
  detectedColumns: string[];
}

const HEADER_ALIASES: Record<string, keyof Omit<ParsedRow, "index" | "status" | "issues">> = {
  beacon: "beaconId", "beacon id": "beaconId", id: "beaconId", point: "beaconId",
  station: "beaconId", name: "beaconId",
  east: "east", easting: "east", e: "east", y: "east", "y (m)": "east",
  north: "north", northing: "north", n: "north", x: "north", "x (m)": "north",
  bearing: "bearing", direction: "bearing", azimuth: "bearing",
  distance: "distance", dist: "distance", length: "distance", side: "distance",
};

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
  if (line.includes(",") && line.split(",").length >= line.split(/\s+/).length) {
    return line.split(",").map((c) => c.trim());
  }
  if (line.includes(";")) return line.split(";").map((c) => c.trim());
  if (line.includes("\t")) return line.split("\t").map((c) => c.trim());
  return line.split(/\s{2,}|\s/).map((c) => c.trim()).filter(Boolean);
}

export function parseSurveyCsv(text: string): ParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  if (lines.length === 0) {
    return { rows: [], validCount: 0, warningCount: 0, errorCount: 0, detectedColumns: [] };
  }

  const firstCells = splitLine(lines[0]).map((c) => c.toLowerCase());
  const hasHeader = firstCells.some((c) => c in HEADER_ALIASES);

  let colMap: (keyof Omit<ParsedRow, "index" | "status" | "issues">)[] = [];
  let dataLines = lines;
  const detectedColumns: string[] = [];

  if (hasHeader) {
    colMap = firstCells.map((c) => HEADER_ALIASES[c] ?? ("beaconId" as const));
    detectedColumns.push(...firstCells);
    dataLines = lines.slice(1);
  } else {
    colMap = ["beaconId", "east", "north", "bearing", "distance"];
    detectedColumns.push("(positional: id, east, north, bearing, distance)");
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
    };

    cells.forEach((cell, ci) => {
      const field = colMap[ci];
      if (!field) return;
      if (field === "beaconId" || field === "bearing") {
        (row[field] as string | null) = cell || null;
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

  return { rows, validCount, warningCount, errorCount, detectedColumns };
}
