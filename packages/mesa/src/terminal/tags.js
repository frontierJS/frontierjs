/**
 * The terminal target's lowering table — which HTML tags and which DOM event
 * names a terminal backend knows how to paint, and what each becomes.
 *
 * The IR carries raw tag names and DOM event names (`IDEAS/mesa-ir.md`,
 * `FJS-D692`); a target translates them through a table of its own, and this
 * is the terminal's. Two readers: the compiler, which refuses a tag or an
 * event missing here at compile time, naming the file and line, so a component
 * that cannot reach a terminal is said rather than painted wrong; and
 * `runtime-terminal.js`, which builds the renderable the role names. Pure
 * data, no engine import — the compiler must load it without the engine
 * installed.
 *
 * `role` is what the runtime constructs: a `box` holds children, `text` is a
 * run of characters, `button` is a focusable box that fires `click` on
 * activation and submits its `<form>` unless its `type` says otherwise,
 * `input` is the control its `type` names (`INPUT_TYPES`), `textarea` is a field
 * of many lines where Enter types a new line, `select` is one row showing its
 * chosen option where Up and Down choose another, `rule` is a line across the
 * parent's width, `image` is the text its `text` attribute names, as a
 * browser shows an `<img>` it cannot load by its `alt` and a screen reader
 * reads an `<svg>` by its `aria-label`, takes no room while that text is
 * empty, and never builds its children, which are drawing, and `progress` is
 * a bar across its parent's width filled by `value` over `max`, as a browser
 * draws one, or the words `in progress` with no `value`, where a browser
 * animates, and `dialog` is a bordered box laid out only while it is open:
 * where it sits when opened by `show()` or the `open` attribute, and centered
 * over the screen by `showModal()`, the rest of the screen dimmed and
 * unreachable until it closes, as a browser's backdrop makes it. `details`
 * shows its first `summary` and lays out the rest only while it is `open`;
 * that `summary` is focusable, toggles `open` on Enter, Space or a press
 * unless its `click` is prevented, and paints the disclosure triangle a
 * browser draws, `▸` closed and `▾` open. A progress's children are the fallback a browser shows only when
 * it cannot draw the bar, so the terminal never builds them. The optional
 * style hints are terminal cell attributes, never colors (Invariant 13), each
 * the one a browser's default stylesheet gives the tag: `<del>` struck
 * through, `<ins>` underlined, `<dfn>` in italics.
 *
 * A box with a `tabindex` of 0 or more is a Tab stop that hears `keydown`,
 * as a browser's is, since a `<div role="slider">` is only reachable that way.
 * One whose `role` is in `WIDGET_ROLES` and holds no content of its own
 * paints what a screen reader announces for it: its `aria-label`, then its
 * `aria-valuetext`, else its `aria-valuenow`.
 *
 * A `<pre>` is a plain box: the compiler keeps the whitespace in its text,
 * and the emitter drops the two newlines a browser drops. A line too long
 * for the screen wraps, where a browser scrolls the block, because only the
 * page scrolls on a terminal and clipping would hide the end of the line.
 *
 * Layout hints: `inline` marks a tag a browser lays out inside a line, so
 * its text joins its neighbors' as one run of words (the runtime's `flow`);
 * `row` lays a box's children side by side whatever they are, which is a
 * table row's cells; `indent` is
 * columns of left padding; `cell` takes an equal share of its row, which is
 * what lines a table's columns up — a terminal has no auto table layout, so
 * columns are equal widths rather than sized to their content. `refuses`
 * names attributes the compiler refuses on that tag: a spanning cell would
 * sit its row's later values under the wrong header, with nothing to say so.
 * A `colspan` on the only cell in its row is let through, since that cell
 * fills the row already (`hostOffenses`). `hidden` builds a box that is
 * never laid out, as a browser never paints it: a `<datalist>`, whose
 * suggestions a terminal does not offer, and an `<option>`, which its
 * `<select>` reads rather than shows. The compiler refuses an `image` tag
 * WITHOUT its `text` attribute: an `<img>` with no `alt` or an `<svg>` with
 * no `aria-label` has nothing a terminal can show, and nothing a screen
 * reader can say either. One inside a static `aria-hidden="true"` is left
 * out instead (`hostDropped`).
 */

import { TONES } from '@frontierjs/toolbelt/tty'

export const TERMINAL_TAGS = {
  div:      { role: 'box' },
  section:  { role: 'box' },
  main:     { role: 'box' },
  header:   { role: 'box' },
  footer:   { role: 'box' },
  nav:      { role: 'box' },
  article:  { role: 'box' },
  aside:    { role: 'box' },
  form:     { role: 'box' },
  fieldset: { role: 'box' },
  legend:   { role: 'box' },
  ul:       { role: 'box' },
  ol:       { role: 'box' },
  li:       { role: 'box' },
  dl:       { role: 'box' },
  dt:       { role: 'box', bold: true },
  dd:       { role: 'box', indent: 2 },
  table:    { role: 'box' },
  thead:    { role: 'box' },
  tbody:    { role: 'box' },
  tfoot:    { role: 'box' },
  tr:       { role: 'box', row: true },
  th:       { role: 'box', cell: true, bold: true, refuses: ['colspan', 'rowspan'] },
  td:       { role: 'box', cell: true, refuses: ['colspan', 'rowspan'] },
  hr:       { role: 'rule' },
  p:        { role: 'box' },
  h1:       { role: 'box', bold: true },
  h2:       { role: 'box', bold: true },
  h3:       { role: 'box', bold: true },
  h4:       { role: 'box', bold: true },
  h5:       { role: 'box', bold: true },
  h6:       { role: 'box', bold: true },
  span:     { role: 'box', inline: true },
  label:    { role: 'box', inline: true },
  strong:   { role: 'box', inline: true, bold: true },
  b:        { role: 'box', inline: true, bold: true },
  em:       { role: 'box', inline: true, italic: true },
  i:        { role: 'box', inline: true, italic: true },
  code:     { role: 'box', inline: true },
  pre:      { role: 'box' },
  kbd:      { role: 'box', inline: true, bold: true },
  sup:      { role: 'box', inline: true },
  small:    { role: 'box', inline: true, dim: true },
  a:        { role: 'box', inline: true, underline: true },
  output:   { role: 'box', inline: true },
  mark:     { role: 'box', inline: true, inverse: true },
  del:      { role: 'box', inline: true, strike: true },
  ins:      { role: 'box', inline: true, underline: true },
  dfn:      { role: 'box', inline: true, italic: true },
  img:      { role: 'image', text: 'alt' },
  svg:      { role: 'image', text: 'aria-label' },
  progress: { role: 'progress' },
  dialog:   { role: 'dialog' },
  details:  { role: 'details' },
  summary:  { role: 'summary' },
  button:   { role: 'button' },
  input:    { role: 'input' },
  textarea: { role: 'textarea' },
  select:   { role: 'select', refuses: ['multiple'] },
  option:   { role: 'box', hidden: true },
  optgroup: { role: 'box', hidden: true },
  datalist: { role: 'box', hidden: true }
}

/**
 * The ARIA roles whose `aria-label` and value a content-less box paints. A
 * browser draws a handle or a thumb the terminal has no shape for, and a
 * screen reader says these words instead.
 */
export const WIDGET_ROLES = new Set(['slider', 'switch', 'tab', 'option', 'menuitem'])

/**
 * What an `<input>` is on a terminal, by its `type`: the one attribute that
 * makes it a different control. `field` is the one-line text field, and a
 * `password` one draws `•` for every character it holds, as a browser masks
 * it. A `date`, `time`, `datetime-local`, `month` or `week` field is typed
 * in its value's own format (`2026-10-10T09:30`), which is its placeholder,
 * and reads `''` until the text is a whole valid value, as a browser's
 * control does. `check` is a box showing `[x]`/`[ ]`, or `(•)`/`( )` for a
 * radio, that Space or a press toggles, firing `input` then `change`; a
 * radio checked unchecks the others of its `name` in its form. `hidden` is
 * never laid out, as a browser never paints one. `file` is a field a path
 * is typed into, since a terminal has no picker. No `type` is `text`. Any type
 * missing here, a typo included, is refused: at compile when written
 * statically, and when written while live, as `multiple` on `<select>` is,
 * since a range painted as a text field takes typing the control would
 * never accept.
 */
export const INPUT_TYPES = {
  text:     'field',
  search:   'field',
  email:    'field',
  tel:      'field',
  url:      'field',
  number:   'field',
  password: 'field',
  date:     'field',
  time:     'field',
  month:    'field',
  week:     'field',
  'datetime-local': 'field',
  checkbox: 'check',
  radio:    'check',
  hidden:   'hidden',
  file:     'file'
}

/** What an `<input>` of `type` is, or undefined for one a terminal refuses. */
export const inputKind = (type) => INPUT_TYPES[type && type !== true ? String(type).toLowerCase() : 'text']

/**
 * Whether a `type="file"` input is one a browser shows no control for, from
 * its `hidden` attribute and its `class`: `hidden`, or `@frontierjs/css`'s
 * `visually-hidden`, which the kit's `FileUpload` puts a button in front of.
 * Such an input paints nothing until its `click()` opens it.
 */
export const pickerHidden = (hidden, cls) =>
  (hidden != null && hidden !== false) || (typeof cls === 'string' && cls.split(/\s+/).includes('visually-hidden'))

/**
 * `@frontierjs/css`'s surface lineage — the classes `surface.css` gives a
 * background — and the variants that set that background `transparent`. A
 * terminal box shows what is under it through every cell it leaves empty, a
 * space in its text included, so a box a browser paints opaque is blanked
 * before its children draw (`opaque`, FJS-D979). `test/terminal-tags.test.js`
 * holds both lists to `surface.css`.
 */
export const SURFACES    = ['surface', 'card', 'tile', 'lane', 'alert', 'toast', 'dialog', 'popover', 'drawer', 'band']
export const SEE_THROUGH = ['outlined', 'ghost']

/** Whether a box of class `cls` hides what is under it. */
export const opaque = (cls) => {
  if (typeof cls !== 'string') return false
  const names = cls.split(/\s+/)
  return names.some((n) => SURFACES.includes(n)) && !names.some((n) => SEE_THROUGH.includes(n))
}

/**
 * Whether a box of class `cls` is glass: a browser blurs what is behind it
 * (`backdrop-filter`), and a terminal frosts it, so the cells under the box
 * keep the colors of what is behind and lose its characters.
 */
export const GLASS = 'glass'
export const frosted = (cls) => typeof cls === 'string' && cls.split(/\s+/).includes(GLASS)

/**
 * The surfaces a terminal draws a border round, and the variants that clear
 * `surface.css`'s border (`--_surface-border: transparent`). Only the box
 * composites: a terminal border is two rows and two columns, and Haven puts
 * a bare `surface` on every bubble row it places by cell (FJS-D1423).
 * `dialog` draws its own. `test/terminal-tags.test.js` holds BORDERLESS to
 * `surface.css`.
 */
export const BORDERED   = ['card', 'tile', 'alert', 'toast', 'popover', 'drawer']
export const BORDERLESS = ['raised', 'ghost']

/** Whether a box of class `cls` draws a border. */
export const bordered = (cls) => {
  if (typeof cls !== 'string') return false
  const names = cls.split(/\s+/)
  return names.some((n) => BORDERED.includes(n)) && !names.some((n) => BORDERLESS.includes(n))
}

/** `@frontierjs/css`'s muted text utility; the `muted` tone is dim too. */
export const MUTED_TEXT = 'text-muted'

/**
 * `@frontierjs/css`'s vertical rhythm: a browser sets a `.stack`'s children
 * apart by `--space-2xl` (1rem), a terminal by one blank row. Without it a
 * `<Form>`, which is a stack, drew label, field, label, field with nothing
 * between. A `style:gap` under 1rem is a stack drawn tight — the kit's
 * Checkbox holds its control over its hint at 0.25rem — and a terminal has
 * no row smaller than one, so it leaves none.
 */
export const STACK = 'stack'

/** The rows a box of class `cls` leaves between its children, given its
 *  `style:gap`. A gap this cannot read in rem is the stack's own. */
export const stackRows = (cls, gap) => {
  if (typeof cls !== 'string' || !cls.split(/\s+/).includes(STACK)) return 0
  const m = /^\s*(\d*\.?\d+)(rem|em|px)?\s*$/.exec(gap == null ? '' : String(gap))
  if (!m) return 1
  const rem = m[2] === 'px' ? m[1] / 16 : Number(m[1])
  return rem < 1 ? 0 : 1
}

/** The `style:` properties a terminal reads; every other is inert. */
export const paintsStyle = (prop) => prop === 'gap'

/** Whether a class name paints anything on a terminal: every other is inert. */
export const paintsClass = (name) =>
  SURFACES.includes(name) || SEE_THROUGH.includes(name) || name === GLASS ||
  BORDERLESS.includes(name) || name === MUTED_TEXT || name === STACK || Object.hasOwn(TONES, name)

/**
 * The roles a browser lays out inside a line, beside text, rather than as a
 * block of their own. With every tag the table marks `inline`, these are
 * what a terminal box lays side by side, and what keeps the white space
 * between two of them (`isInline`).
 */
export const INLINE_ROLES = new Set(['button', 'input', 'select', 'image'])

/** Whether `tag` sits inside a line; an unknown tag answers no. */
export const isInline = (tag) => {
  const spec = TERMINAL_TAGS[tag]
  return !!spec && (!!spec.inline || INLINE_ROLES.has(spec.role))
}

/**
 * DOM event names with a terminal meaning, and whether each bubbles as it
 * does in a browser. A listener on an ancestor hears a descendant's event by
 * that rule: `<form oninput>` sees every field under it, and `focus`/`blur`
 * reach an ancestor only through a `|capture` listener, where `focusin` and
 * `focusout` are their bubbling twins, sent after each.
 *
 * `scroll` is heard and never sent. No element scrolls on a terminal, only
 * the page, so a handler waits as it does on a page whose element never
 * overflows; a role that scrolls must send it. `error` is heard and never sent for the same reason:
 * a terminal loads no image, so none fails to load. The drop-target events
 * are heard and never sent: nothing outside a terminal can be dropped into
 * it, and the kit's drop zone wraps a field the keyboard reaches. A drag
 * inside the screen would be the engine's `onMouseDrop`, a drag source's
 * lowering, so a drag source stays refused until that is built.
 * `touchstart` is heard and never sent: a terminal has no touch, and every
 * kit listener sits beside a `mousedown` that does the same. `toggle` is a
 * `<details>`'s, sent a task after its `open` changes. `cancel`
 * and `close` are a `<dialog>`'s, and neither bubbles. `paste` is a
 * bracketed paste, sent where a key would be before the field takes the
 * text: a terminal pastes text only, so `clipboardData.files` is empty and a
 * handler for pasted files does nothing, as a browser's does for a text paste.
 *
 * `mouseenter` and `mouseleave` follow the pointer from element to element,
 * a drag included: one at each element the pointer came onto or went off,
 * neither bubbling, so a listener hears its own element's and never a
 * descendant's. An element built under a still pointer is entered when the
 * screen is next drawn.
 *
 * The window is the end of every event's path, past the screen's root, so a
 * `<mesa:window>` listener hears what bubbles there, and a key pressed with
 * nothing focused is sent to the window alone, as a browser sends it to the
 * body.
 */
export const TERMINAL_EVENTS = {
  click:   { bubbles: true },
  input:   { bubbles: true },
  change:  { bubbles: true },
  submit:  { bubbles: true },
  keydown: { bubbles: true },
  keypress: { bubbles: true },
  paste:   { bubbles: true },
  mousedown: { bubbles: true },
  mousemove: { bubbles: true },
  mouseenter: { bubbles: false },
  mouseleave: { bubbles: false },
  scroll:  { bubbles: false },
  error:   { bubbles: false },
  dragenter: { bubbles: true },
  dragover:  { bubbles: true },
  dragleave: { bubbles: true },
  drop:      { bubbles: true },
  touchstart: { bubbles: true },
  focus:   { bubbles: false },
  blur:    { bubbles: false },
  focusin:  { bubbles: true },
  focusout: { bubbles: true },
  toggle:  { bubbles: false },
  cancel:  { bubbles: false },
  close:   { bubbles: false }
}
