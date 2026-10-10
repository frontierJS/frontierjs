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
 * `input` is a one-line text field where Enter submits, `textarea` is a field
 * of many lines where Enter types a new line, `select` is one row showing its
 * chosen option where Up and Down choose another, `rule` is a line across the
 * parent's width, `image` is its `alt` text, as a browser shows an image it
 * cannot load, and takes no room while that text is empty, and `progress` is
 * a bar across its parent's width filled by `value` over `max`, as a browser
 * draws one, or the words `in progress` with no `value`, where a browser
 * animates. A progress's children are the fallback a browser shows only when
 * it cannot draw the bar, so the terminal never builds them. The optional
 * style hints are terminal cell attributes, never colors (Invariant 13).
 *
 * Layout hints: `inline` lays a box's children side by side; `indent` is
 * columns of left padding; `cell` takes an equal share of its row, which is
 * what lines a table's columns up — a terminal has no auto table layout, so
 * columns are equal widths rather than sized to their content. `refuses`
 * names attributes the compiler refuses on that tag: a spanning cell would
 * sit its row's later values under the wrong header, with nothing to say so.
 * A `colspan` on the only cell in its row is let through, since that cell
 * fills the row already (`terminalOffenses`). `hidden` builds a box that is
 * never laid out, as a browser never paints it: a `<datalist>`, whose
 * suggestions a terminal does not offer, and an `<option>`, which its
 * `<select>` reads rather than shows. `requires` names attributes the
 * compiler refuses the tag WITHOUT: an `<img>` with no `alt` has nothing a
 * terminal can show, and nothing a screen reader can say either. One inside
 * a static `aria-hidden="true"` is left out instead (`terminalDropped`).
 */

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
  tr:       { role: 'box', inline: true },
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
  kbd:      { role: 'box', inline: true, bold: true },
  sup:      { role: 'box', inline: true },
  small:    { role: 'box', inline: true, dim: true },
  a:        { role: 'box', inline: true, underline: true },
  output:   { role: 'box', inline: true },
  mark:     { role: 'box', inline: true, inverse: true },
  img:      { role: 'image', requires: ['alt'] },
  progress: { role: 'progress' },
  button:   { role: 'button' },
  input:    { role: 'input' },
  textarea: { role: 'textarea' },
  select:   { role: 'select', refuses: ['multiple'] },
  option:   { role: 'box', hidden: true },
  optgroup: { role: 'box', hidden: true },
  datalist: { role: 'box', hidden: true }
}

/**
 * DOM event names with a terminal meaning, and whether each bubbles as it
 * does in a browser. A listener on an ancestor hears a descendant's event by
 * that rule: `<form on:input>` sees every field under it, and `focus`/`blur`
 * reach an ancestor only through a `|capture` listener.
 *
 * `scroll` is heard and never sent. No terminal node scrolls, so a handler
 * waits as it does on a page whose element never overflows; a role that
 * scrolls must send it. `error` is heard and never sent for the same reason:
 * a terminal loads no image, so none fails to load. The drop-target events
 * are heard and never sent: nothing outside a terminal can be dropped into
 * it, and the kit's drop zone wraps a field the keyboard reaches. A drag
 * inside the screen would be the engine's `onMouseDrop`, a drag source's
 * lowering, so a drag source stays refused until that is built.
 */
export const TERMINAL_EVENTS = {
  click:   { bubbles: true },
  input:   { bubbles: true },
  change:  { bubbles: true },
  submit:  { bubbles: true },
  keydown: { bubbles: true },
  keypress: { bubbles: true },
  mousedown: { bubbles: true },
  mousemove: { bubbles: true },
  scroll:  { bubbles: false },
  error:   { bubbles: false },
  dragenter: { bubbles: true },
  dragover:  { bubbles: true },
  dragleave: { bubbles: true },
  drop:      { bubbles: true },
  focus:   { bubbles: false },
  blur:    { bubbles: false }
}
