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

/**
 * For single-line label/value fields (a table cell, a form field printed
 * next to its label) there's no spare vertical room to wrap into — a
 * surveyor typing an unusually long D.S.M No., location, or name would
 * otherwise just run the text past the printed box into whatever sits next
 * to it. Shrinks the font to fit first (down to a floor), then truncates
 * with an ellipsis if it still doesn't fit even at the floor size, so a
 * single-line field can never overflow its column no matter what's typed
 * into it.
 */
export function fitSvgText(
  text: string,
  maxWidth: number,
  fontSize: number,
  minFontSize = Math.max(10, Math.round(fontSize * 0.55)),
  avgCharWidthFactor = 0.62
): { text: string; fontSize: number } {
  if (!text) return { text, fontSize };
  const widthAt = (s: string, fs: number) => s.length * fs * avgCharWidthFactor;
  let fs = fontSize;
  if (widthAt(text, fs) > maxWidth) {
    fs = Math.max(minFontSize, maxWidth / (text.length * avgCharWidthFactor));
  }
  if (widthAt(text, fs) <= maxWidth) return { text, fontSize: fs };
  const maxChars = Math.max(1, Math.floor(maxWidth / (fs * avgCharWidthFactor)) - 1);
  const truncated = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  return { text: truncated, fontSize: fs };
}
