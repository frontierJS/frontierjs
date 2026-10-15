// api/src/shape.ts
// A figure drawn as a character a member picked (`IDEAS/haven.md` 9.7), and
// the one rule for what character a stranger may put on another member's
// screen — chalk (9.8) asks it too. One printable ASCII character, so nothing
// is spelled with it and nothing is wider than a cell: a wide glyph pushes
// every cell after it on the row, and a control byte rewrites the terminal.

/** How long a shapeshift lasts. */
export const SHAPE_MS = 60_000

/** `v` when it is a color a figure may be drawn in — `#rrggbb`, lowercase — else null. */
export function inkOf (v: unknown): string | null {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/.test(v) ? v : null
}

/** `v` when it is one printable, non-space ASCII character, else null. */
export function glyphOf (v: unknown): string | null {
  if (typeof v !== 'string' || v.length !== 1) return null
  const c = v.charCodeAt(0)
  return c > 0x20 && c < 0x7f ? v : null
}
