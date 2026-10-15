// src/cells.js — how many cells a text takes on a screen, for anything laid
// out around what a member said: a bubble kept inside the view, a booth's
// bubble against the right edge, a history row cut to its pane (14.3).
//
// A string's `length` is UTF-16 units, so 中 is one and takes two cells, and
// 👩‍💻 is five and takes two; a box sized by it pokes past the view or stops
// short of the edge it is pushed against, and a `slice` by it can cut an
// emoji in half. Target-neutral: the terminal has `Bun.stringWidth`, which
// is what OpenTUI draws by; a browser has no Bun and takes `estimate`, the
// same answer for the graphemes `web/test/emoji.test.js` names.

const SEGMENTS = new Intl.Segmenter()

// East Asian Wide and Fullwidth: Hangul Jamo, the CJK blocks, Hangul
// syllables, the compatibility ideographs, the fullwidth forms, and the
// supplementary ideograph planes.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3FFFD}]/u

const graphemeCells = (g) => {
  if (/^\p{Regional_Indicator}$/u.test(g)) return 1
  if (/\p{Emoji_Presentation}|️/u.test(g) || WIDE.test(g)) return 2
  if (/^[\p{Mn}\p{Me}\p{Cf}]+$/u.test(g)) return 0
  return 1
}

/** The cells `text` takes, counted a grapheme at a time — a browser's answer. */
export function estimate(text) {
  let n = 0
  for (const { segment } of SEGMENTS.segment(text)) n += graphemeCells(segment)
  return n
}

/** The cells `text` takes on this target's screen. */
export const cells = globalThis.Bun?.stringWidth ?? estimate

/** `text` cut to at most `n` cells, never inside a grapheme. */
export function clip(text, n) {
  let out = ''
  let used = 0
  for (const { segment } of SEGMENTS.segment(text)) {
    const w = cells(segment)
    if (used + w > n) break
    out += segment
    used += w
  }
  return out
}
