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
 * activation, `input` is a text field. The optional style hints are terminal
 * cell attributes, never colors (Invariant 13).
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
  small:    { role: 'box', inline: true, dim: true },
  a:        { role: 'box', inline: true, underline: true },
  button:   { role: 'button' },
  input:    { role: 'input' },
  textarea: { role: 'input' }
}

/** DOM event names with a terminal meaning. The value is what the runtime wires. */
export const TERMINAL_EVENTS = {
  click:   'activate',
  input:   'input',
  keydown: 'keydown',
  focus:   'focus',
  blur:    'blur'
}
