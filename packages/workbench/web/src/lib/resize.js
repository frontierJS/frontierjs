// web/src/lib/resize.js -- the width a person gave a Messages column, kept per
// browser. The dragging, keys and reset are `resizeHandle` from
// `@frontierjs/ui/resize`, which stores nothing (FJS-D2259); this is the app's
// half of that line.

/**
 * The kept width, clamped on read: a width saved on a wide monitor would
 * swallow a laptop's other column.
 * @param {string} key  the localStorage key
 * @param {{ initial: number, min: number, max: number }} bounds
 */
export function keptWidth(key, { initial, min, max }) {
  try {
    const w = Number(localStorage.getItem(key))
    if (w) return Math.round(Math.min(max, Math.max(min, w)))
  } catch {}
  return initial
}

/** @param {string} key  @param {number | null} px  null forgets it */
export function keepWidth(key, px) {
  try {
    if (px == null) localStorage.removeItem(key)
    else localStorage.setItem(key, String(px))
  } catch {}
}
