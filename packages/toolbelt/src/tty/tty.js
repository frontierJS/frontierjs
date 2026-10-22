/*
 * tty.js — `@frontierjs/css`'s tones as a terminal says them (`FJS-D37` §1,
 * `FJS-D1423`).
 *
 * A tone is an ANSI palette INDEX, never an RGB value: the terminal's own
 * theme decides the shade, so a light terminal and a dark one both stay
 * legible and nothing here restates a hex the css themes already own.
 * `muted` has no hue on a terminal and is the dim bit instead.
 *
 * The tone names are a copy of `tones.css`'s, held to it by mesa's
 * `test/terminal-tags.test.js`.
 */

/** Each tone → `{ color }`, an ANSI palette index 0–15, or `{ dim: true }`. */
export const TONES = Object.freeze({
  primary:   Object.freeze({ color: 4 }),
  secondary: Object.freeze({ color: 5 }),
  muted:     Object.freeze({ dim: true }),
  info:      Object.freeze({ color: 6 }),
  success:   Object.freeze({ color: 2 }),
  warning:   Object.freeze({ color: 3 }),
  danger:    Object.freeze({ color: 1 }),
})

/** The tone a `class` attribute carries — its first tone name — or null. */
export function toneOf(cls) {
  if (typeof cls !== 'string') return null
  for (const name of cls.split(/\s+/)) if (Object.hasOwn(TONES, name)) return name
  return null
}
