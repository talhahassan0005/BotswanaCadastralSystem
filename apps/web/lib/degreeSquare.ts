export interface DegreeSquareBounds {
  degreeFrom: number;
  minuteFrom: number;
  degreeTo: number;
  minuteTo: number;
}

export const ELO_DEGREE_MIN = 16;
export const ELO_DEGREE_MAX = 29;

export function validateDegreeSquare(value: DegreeSquareBounds): string | null {
  const values = [value.degreeFrom, value.minuteFrom, value.degreeTo, value.minuteTo];
  if (!values.every(Number.isFinite) || !values.every(Number.isInteger)) return "Degrees and minutes must be whole numbers.";
  if (value.degreeFrom < ELO_DEGREE_MIN || value.degreeFrom > ELO_DEGREE_MAX - 1 ||
      value.degreeTo < ELO_DEGREE_MIN + 1 || value.degreeTo > ELO_DEGREE_MAX) {
    return `Degree lines must be within ${ELO_DEGREE_MIN}–${ELO_DEGREE_MAX}.`;
  }
  if (value.degreeTo !== value.degreeFrom + 1) return "The ending degree must be exactly one degree after the starting degree.";
  if (value.minuteFrom < 0 || value.minuteFrom > 59 || value.minuteTo < 0 || value.minuteTo > 59) {
    return "Minute values must be between 0 and 59.";
  }
  return null;
}

export function degreeMinuteToDecimal(degrees: number, minutes: number): number {
  return degrees + minutes / 60;
}

export function degreeSquareReference(value: DegreeSquareBounds, mode: "center" | "corner" = "center"): number {
  const from = degreeMinuteToDecimal(value.degreeFrom, value.minuteFrom);
  const to = degreeMinuteToDecimal(value.degreeTo, value.minuteTo);
  return mode === "corner" ? from : (from + to) / 2;
}

export function formatDegreeSquare(value: DegreeSquareBounds): string {
  return `Deg Sq ${value.degreeFrom}°${String(value.minuteFrom).padStart(2, "0")}' – ${value.degreeTo}°${String(value.minuteTo).padStart(2, "0")}'`;
}
