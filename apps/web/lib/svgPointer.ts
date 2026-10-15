/** Uniform scale (CSS px per viewBox unit) and letterbox offsets of an
 *  <svg viewBox="0 0 vbW vbH"> drawn with the default preserveAspectRatio
 *  (xMidYMid meet) into a box of rectW x rectH CSS px. */
export function svgFit(rectW: number, rectH: number, vbW: number, vbH: number) {
  const s = Math.min(rectW / vbW, rectH / vbH);
  return { s, offX: (rectW - vbW * s) / 2, offY: (rectH - vbH * s) / 2 };
}

/** Client (CSS px) -> viewBox coordinates. Built from getBoundingClientRect
 *  (same coordinate space as clientX/Y, so DPR, browser/CSS zoom and scroll
 *  cancel out) and inverts the meet-letterboxing a plain rect stretch ignores. */
export function clientToSvg(rect: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number, vbW: number, vbH: number): [number, number] {
  const { s, offX, offY } = svgFit(rect.width, rect.height, vbW, vbH);
  if (!(s > 0)) return [0, 0];
  return [(clientX - rect.left - offX) / s, (clientY - rect.top - offY) / s];
}
