// api/src/shape.ts
// A figure drawn as a character a member picked (`IDEAS/haven.md` 9.7), and
// the one rule for what character a stranger may put on another member's
// screen — chalk (9.8) asks it too. One printable ASCII character, so nothing
// is spelled with it and nothing is wider than a cell: a wide glyph pushes
// every cell after it on the row, and a control byte rewrites the terminal.
// A figure alone may also be one emoji (14.4), drawn on an overlay rather
// than in a row of art, and standing on two cells (`spanOf`).

/** How long a shapeshift lasts. */
export const SHAPE_MS = 60_000

/** `v` when it is a color a figure may be drawn in — `#rrggbb`, lowercase — else null. */
export function inkOf (v: unknown): string | null {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/.test(v) ? v : null
}

/**
 * What a figure is doing for everyone to see (`IDEAS/haven.md` 8.1): `/wave`
 * and `/dance` for `EMOTE_MS`, ended by the client's timer as a shape is,
 * since presence meta is stateless, and `/sit` until the figure steps.
 */
export const EMOTES = ['wave', 'sit', 'dance'] as const
export type Emote = typeof EMOTES[number]
export const EMOTE_MS = 4_000

/** `v` when it is one of `EMOTES`, else null. */
export function emoteOf (v: unknown): Emote | null {
  return (EMOTES as readonly unknown[]).includes(v) ? v as Emote : null
}

/** `v` when it is one printable, non-space ASCII character, else null. */
export function glyphOf (v: unknown): string | null {
  if (typeof v !== 'string' || v.length !== 1) return null
  const c = v.charCodeAt(0)
  return c > 0x20 && c < 0x7f ? v : null
}

// One code point an emoji by default, which every one of them is two cells on
// both targets. A sequence is refused: a skin tone or a ZWJ joins differently
// per terminal, and the engine hands it over a code point at a time. A
// regional indicator and a skin tone alone are emoji components, not
// pictographs, so they are out too.
const EMOJI = /^(?=\p{Emoji_Presentation})\p{Extended_Pictographic}$/u

/** `v` when a figure may be drawn as it — `glyphOf`'s character, or one emoji — else null. */
export function shapeOf (v: unknown): string | null {
  return glyphOf(v) ?? (typeof v === 'string' && EMOJI.test(v) ? v : null)
}

/**
 * The cells a figure drawn as `shape` stands on, from its own cell rightward:
 * 2 for an emoji, else 1. A step still moves one column; the second cell is
 * what the figure covers, so it must be floor, and a bolt crossing it hits.
 */
export const spanOf = (shape: string | null | undefined): 1 | 2 => (shape && EMOJI.test(shape) ? 2 : 1)
