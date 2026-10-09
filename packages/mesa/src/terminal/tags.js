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
 * `input` is a text field, `rule` is a line across the parent's
 * width. The optional style hints are terminal cell attributes, never colors
 * (Invariant 13).
 *
 * Layout hints: `inline` lays a box's children side by side; `indent` is
 * columns of left padding; `cell` takes an equal share of its row, which is
 * what lines a table's columns up — a terminal has no auto table layout, so
 * columns are equal widths rather than sized to their content. `refuses`
 * names attributes the compiler refuses on that tag: a spanning cell would
 * sit its row's later values under the wrong header, with nothing to say so.
 * A `colspan` on the only cell in its row is let through, since that cell
 * fills the row already (`terminalOffenses`).
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
  button:   { role: 'button' },
  input:    { role: 'input' },
  textarea: { role: 'input' }
}

/**
 * DOM event names with a terminal meaning, and whether each bubbles as it
 * does in a browser. A listener on an ancestor hears a descendant's event by
 * that rule: `<form on:input>` sees every field under it, and `focus`/`blur`
 * reach an ancestor only through a `|capture` listener.
 */
export const TERMINAL_EVENTS = {
  click:   { bubbles: true },
  input:   { bubbles: true },
  change:  { bubbles: true },
  submit:  { bubbles: true },
  keydown: { bubbles: true },
  focus:   { bubbles: false },
  blur:    { bubbles: false }
}
