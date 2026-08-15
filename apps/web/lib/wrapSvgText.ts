/**
 * SVG <text> never wraps on its own — long strings (e.g. a "THE FIGURE A1 A2
 * A3… REPRESENTS…" legal-description line on a beacon-heavy parcel) just run
 * past the sheet border. This greedily packs words into lines that fit a
 * given width, using an average-character-width estimate (no DOM measurement
 * available when these diagrams render to a static SVG/print context).
 */
export function wrapSvgWords(words: string[], maxWidth: number, fontSize: number, avgCharWidthFactor = 0.62): string[] {
  const charW = fontSize * avgCharWidthFactor;
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (cur && test.length * charW > maxWidth) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}
