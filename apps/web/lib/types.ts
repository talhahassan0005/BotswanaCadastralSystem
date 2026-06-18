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

export interface ImportResult {
  filename: string;
  rows: ParsedRow[];
  validCount: number;
  warningCount: number;
  errorCount: number;
  detectedColumns: string[];
  notice?: string;
}

export interface CogoLeg {
  index: number;
  from: string | null;
  to: string | null;
  bearing: number;
  bearing_dms: string;
  distance: number;
  d_east_adj: number;
  d_north_adj: number;
}

export interface CogoResult {
  type: string;
  adjustment: string;
  closure: {
    misclose_east: number;
    misclose_north: number;
    linear_misclosure: number;
    total_distance: number;
    relative_precision: number | null;
    relative_precision_text: string;
  };
  area_m2: number;
  area_ha: number;
  sigma0: number;
  points: { name: string | null; east: number; north: number }[];
  legs: CogoLeg[];
  residuals: {
    leg: number;
    from: string | null;
    to: string | null;
    magnitude: number;
    correction_east?: number;
    correction_north?: number;
    v_distance?: number;
    v_direction_sec?: number;
  }[];
}

export interface ValidationResult {
  checks: { rule: string; severity: "pass" | "warning" | "error"; message: string }[];
  passed: number;
  warnings: number;
  errors: number;
  overallScore: number;
  dsmCompliant: boolean;
  narrative: string;
  aiSource: "groq" | "fallback";
  aiEngine: boolean;
}

// --- Cadastral parcel construction (Module D) -----------------------------
export interface Beacon {
  id: string; // beacon / station label, unique
  east: number;
  north: number;
  computed?: boolean; // true for COGO-computed subdivision points (shown highlighted)
}

export interface Parcel {
  id: string; // internal id
  number: string; // Erf / Lot / parcel number (cadastral label)
  name: string; // optional description
  beaconIds: string[]; // ordered ring of beacon ids (do NOT repeat first)
}

export interface ParcelDoc {
  beacons: Beacon[];
  parcels: Parcel[];
}

export interface ParcelSide {
  from: string;
  to: string;
  bearing: number;
  bearing_dms: string;
  distance: number;
}

export interface ParcelMetrics {
  area_m2: number;
  area_ha: number;
  perimeter: number;
  sides: ParcelSide[];
  closed: boolean; // ring has >= 3 distinct beacons
}

// --- Topographic survey processing ---------------------------------------
export interface TopoPoint {
  name: string | null;
  x: number; // Easting
  y: number; // Northing
  z: number; // Reduced level (elevation)
}

export interface ContourLevel {
  level: number;
  segments: [[number, number], [number, number]][];
}

export interface TopoStats {
  count: number;
  triangles: number;
  minZ: number;
  maxZ: number;
  meanZ: number;
  relief: number;
  planArea: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface TopoResult {
  points: TopoPoint[];
  triangles: { a: number; b: number; c: number }[];
  contours: ContourLevel[];
  interval: number;
  stats: TopoStats;
}

// --- Volume computations --------------------------------------------------
export type VolumeMethod = "surface" | "section" | "grid" | "contour";

export interface VolumeResult {
  method: VolumeMethod;
  cut: number;
  fill: number;
  net: number;
  prismoidalCut?: number | null;
  prismoidalFill?: number | null;
  breakdown: { label: string; value: number }[];
  notes: string[];
  faces?: { a: number; b: number; c: number; d: number }[];
  points?: TopoPoint[];
  datum?: number;
}
