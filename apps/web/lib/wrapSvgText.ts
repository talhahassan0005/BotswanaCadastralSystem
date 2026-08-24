/**
 * SVG <text> never wraps on its own — long strings (e.g. a "THE FIGURE A1 A2
 * A3… REPRESENTS…" legal-description line on a beacon-heavy parcel) just run
 * past the sheet border. This greedily packs words into lines that fit a
 * given width, using an average-character-width estimate (no DOM measurement
 * available when these diagrams render to a static SVG/print context). A
 * single word longer than the line itself (e.g. a pasted number/id with no
 * spaces) is hard-split into forced chunks rather than left to overflow on
 * its own line — client req 2026-08-24, found via stress-test data made of
 * long unbroken digit runs.
 */
export function wrapSvgWords(words: string[], maxWidth: number, fontSize: number, avgCharWidthFactor = 0.62): string[] {
  const charW = fontSize * avgCharWidthFactor;
  const maxChars = Math.max(1, Math.floor(maxWidth / charW));
  const lines: string[] = [];
  let cur = "";
  for (const raw of words) {
    const pieces = raw.length > maxChars ? raw.match(new RegExp(`.{1,${maxChars}}`, "g")) ?? [raw] : [raw];
    for (const w of pieces) {
      const test = cur ? `${cur} ${w}` : w;
      if (cur && test.length * charW > maxWidth) {
        lines.push(cur);
        cur = w;
      } else {
        cur = test;
      }
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * For single-line label/value fields (a table cell, a form field printed
 * next to its label) there's no spare vertical room to wrap into. Rather
 * than shrinking the font to fit — which the client explicitly asked to
 * drop ("font chota karne ki zarorat nahi thi") — this keeps the font size
 * fixed and instead clamps the text to at most `maxWords` words, adding "…"
 * when it truncates. A character-width fallback (still at the fixed font
 * size) then covers the case even that clamped word count doesn't fit the
 * column — e.g. five very long words, or a single unbroken run with no
 * spaces at all — so the field never overflows regardless of what's typed
 * into it (client req 2026-08-24).
 */
export function clampWords(text: string, maxWidth: number, fontSize: number, maxWords = 5, avgCharWidthFactor = 0.62): string {
  if (!text) return text;
  const words = text.trim().split(/\s+/);
  const wordTruncated = words.length > maxWords;
  let out = wordTruncated ? words.slice(0, maxWords).join(" ") : text;
  const charW = fontSize * avgCharWidthFactor;
  const maxChars = Math.max(1, Math.floor(maxWidth / charW));
  let charTruncated = false;
  if (out.length > maxChars) {
    out = out.slice(0, Math.max(1, maxChars - 1));
    charTruncated = true;
  }
  if (!wordTruncated && !charTruncated) return out;
  return `${out.replace(/[.,;:\s]+$/, "")}…`;
}

/**
 * Like wrapSvgWords, but caps the result at `maxLines` — for a block that
 * genuinely has a couple of lines' worth of room (unlike the single-line
 * fields clampWords covers) but not unlimited room: past the cap, the
 * overflow folds into the last line and gets ellipsized there instead of
 * pushing a 3rd/4th line into whatever sits below the block (client req
 * 2026-08-24, found via stress-test data that turned a "name" field into
 * several lines of unbroken characters).
 */
export function clampToLines(text: string, maxWidth: number, fontSize: number, maxLines: number, avgCharWidthFactor = 0.62): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = wrapSvgWords(words, maxWidth, fontSize, avgCharWidthFactor);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines - 1);
  const remainder = lines.slice(maxLines - 1).join(" ");
  kept.push(clampWords(remainder, maxWidth, fontSize, Infinity, avgCharWidthFactor));
  return kept;
}
