/**
 * The native target's lowering table — which HTML tags and DOM event names a
 * phone backend builds, and what each becomes (`FJS-D1074`). The terminal's
 * twin: the compiler refuses a tag or event missing here, by file and line,
 * and `runtime-native.js` builds the view the role names. Pure data, no
 * engine names — what each event is called on the engine is the runtime's.
 *
 * `role` is what the runtime constructs: a `box` holds children and paints
 * no characters of its own; `text` holds characters, and a box inside one
 * has no native layout, since the engine lays text out as one run; `button`
 * is a box that fires `click` on a tap and submits its `<form>` unless its
 * `type` says otherwise; `input` is the one-line field its `type` names
 * (`INPUT_TYPES`); `textarea` is a field of many lines; `image` is a picture
 * from its `src`, and never builds its children.
 *
 * What a phone has no element for is absent and therefore refused: `<select>`,
 * `<datalist>`, `<progress>`, `<svg>`, `<dialog>` and `<details>`, and the
 * checkbox, radio, date and file inputs (`IDEAS/mesa-ir.md` § 9). Each is
 * a lowering still to build, not a tag to approximate.
 *
 * `inline` marks a tag a browser lays out inside a line, so the white space
 * between two of them is one space rather than none (the emitter's
 * `spacesIn`).
 */

const box  = { role: 'box' }
const text = { role: 'text' }
const run  = { role: 'text', inline: true }

export const NATIVE_TAGS = {
  div: box, section: box, main: box, header: box, footer: box, nav: box,
  article: box, aside: box, form: box, fieldset: box, ul: box, ol: box,
  li: box, dl: box, table: box, thead: box, tbody: box, tfoot: box, tr: box,
  figure: box, blockquote: box, hr: box, menu: box, search: box,
  hgroup: box, address: box,
  p: text, h1: text, h2: text, h3: text, h4: text, h5: text, h6: text,
  pre: text, legend: text, dt: text, dd: text, th: text, td: text,
  figcaption: text, caption: text,
  span: run, label: run, strong: run, b: run, em: run, i: run, code: run,
  kbd: run, sup: run, sub: run, small: run, a: run, mark: run, del: run,
  ins: run, dfn: run, abbr: run, cite: run, q: run, s: run, u: run,
  samp: run, time: run, var: run, output: run,
  button:   { role: 'button' },
  input:    { role: 'input' },
  textarea: { role: 'textarea' },
  img:      { role: 'image' },
}

/**
 * The class every element carries for the tag it was written with, since the
 * engine's elements are all `view` or `text` and a type selector matches none
 * (`FJS-D1139`). `css.js` lowers `p` to `._p`, in a component's `<style>` and
 * a whole sheet alike. The underscore is the kit's mark for private, so no
 * class an author writes is taken.
 */
export const tagClass = (tag) => `_${tag}`

/**
 * The browser's own stylesheet for the tags it styles, since a phone has none
 * and `@frontierjs/css` leaves `strong`, `p` and the headings to it (4.8). The
 * rules are what Chrome paints on each tag over a bare `div` or `span`, in the
 * `em` the HTML standard's rendering section writes them in, and already in
 * the form `lowerSheet` produces: physical sides, literal colors.
 *
 * It goes FIRST in a bundle's CSS. A browser keeps it in an origin below every
 * author rule; here only order and specificity do that, so a later author
 * rule of one class beats it and an author `*` does not.
 *
 * `html` is the page, which the runtime gives `._html`. Its `font-size` is
 * CSS's `medium`, 16px, where the engine's root is 14px. `rem` is read off it,
 * and so is every `em` and every text size an author leaves unset; without it
 * the kit paints 12.5% small (4.9).
 *
 * Left out, each because the device has no answer or the answer would hurt:
 * `a`, whose underline the kit takes off with `a:where([class])`, an
 * attribute selector a phone never matches, so every component link would be
 * underlined; the controls, which the engine draws; table layout and its
 * cell padding, list markers and `cursor`; and the rule that zeroes a nested
 * list's margins.
 */
const USER_AGENT = [
  ['html', 'font-size: 16px'],
  ['p, dl, pre', 'margin-top: 1em; margin-bottom: 1em'],
  ['ul, ol, menu', 'margin-top: 1em; margin-bottom: 1em; padding-left: 40px'],
  ['blockquote, figure', 'margin: 1em 40px'],
  ['dd', 'margin-left: 40px'],
  ['fieldset', 'margin-left: 2px; margin-right: 2px; padding: .35em .75em .625em; border-width: 2px; border-style: groove; border-color: rgb(239, 239, 239)'],
  ['legend', 'padding-left: 2px; padding-right: 2px'],
  ['h1', 'font-size: 2em; margin-top: .67em; margin-bottom: .67em'],
  ['h2', 'font-size: 1.5em; margin-top: .83em; margin-bottom: .83em'],
  ['h3', 'font-size: 1.17em; margin-top: 1em; margin-bottom: 1em'],
  ['h4', 'margin-top: 1.33em; margin-bottom: 1.33em'],
  ['h5', 'font-size: .83em; margin-top: 1.67em; margin-bottom: 1.67em'],
  ['h6', 'font-size: .67em; margin-top: 2.33em; margin-bottom: 2.33em'],
  ['h1, h2, h3, h4, h5, h6, th, strong, b', 'font-weight: 700'],
  ['th', 'text-align: center'],
  ['em, i, cite, dfn, var, address', 'font-style: italic'],
  ['code, kbd, samp, pre', 'font-family: monospace'],
  ['pre', 'white-space: pre'],
  ['small, sup, sub', 'font-size: .83333em'],
  ['sup', 'vertical-align: super'],
  ['sub', 'vertical-align: sub'],
  ['del, s', 'text-decoration: line-through'],
  ['ins, u', 'text-decoration: underline'],
  ['mark', 'background-color: rgb(255, 255, 0); color: rgb(0, 0, 0)'],
  ['hr', 'margin-top: .5em; margin-bottom: .5em; border-width: 1px; border-style: inset; border-color: rgb(128, 128, 128)'],
]

export const userAgentSheet = USER_AGENT
  .map(([tags, decls]) => `${tags.split(', ').map((t) => `.${tagClass(t)}`).join(', ')} { ${decls} }`)
  .join('\n')

/** The `<input>` types the engine's one field covers; the rest have no element. */
export const INPUT_TYPES = {
  text: 'field', search: 'field', email: 'field', tel: 'field',
  url: 'field', number: 'field', password: 'field',
}

/** What an `<input>` of `type` is, or undefined for one a phone refuses. */
export const inputKind = (type) => INPUT_TYPES[type && type !== true ? String(type).toLowerCase() : 'text']

const INLINE_ROLES = new Set(['button', 'input', 'image'])

/** Whether `tag` sits inside a line; an unknown tag answers no. */
export const isInline = (tag) => {
  const spec = NATIVE_TAGS[tag]
  return !!spec && (!!spec.inline || INLINE_ROLES.has(spec.role))
}

/**
 * The DOM events a phone delivers. `change` and `submit` the runtime makes
 * from others, as a browser does: `change` from a field's blur after an
 * edit, `submit` from a tap on a submit button. A phone sends no key events,
 * so `keydown` is refused rather than never fired. The pointer events are a
 * touch's, one finger, as a browser reports a touchscreen.
 */
export const NATIVE_EVENTS = {
  click:              { bubbles: true },
  mousedown:          { bubbles: true },
  mouseup:            { bubbles: true },
  mousemove:          { bubbles: true },
  pointerdown:        { bubbles: true },
  pointermove:        { bubbles: true },
  pointerup:          { bubbles: true },
  pointercancel:      { bubbles: true },
  lostpointercapture: { bubbles: true },
  input:              { bubbles: true },
  change:             { bubbles: true },
  submit:             { bubbles: true },
  focus:              { bubbles: false },
  blur:               { bubbles: false },
  load:               { bubbles: false },
  error:              { bubbles: false },
}
