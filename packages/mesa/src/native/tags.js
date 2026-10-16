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
 * so `keydown` is refused rather than never fired.
 */
export const NATIVE_EVENTS = {
  click:     { bubbles: true },
  mousedown: { bubbles: true },
  mouseup:   { bubbles: true },
  mousemove: { bubbles: true },
  input:     { bubbles: true },
  change:    { bubbles: true },
  submit:    { bubbles: true },
  focus:     { bubbles: false },
  blur:      { bubbles: false },
  load:      { bubbles: false },
  error:     { bubbles: false },
}
