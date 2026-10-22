/**
 * The terminal runtime — `$$host`, what a component compiled with
 * `target: 'terminal'` calls in place of the DOM half of `runtime.js`. The
 * signal graph, the flush and the component frame are the same `runtime.js`;
 * only the tree the effects write into differs, and this file is that tree.
 *
 * The engine seam: everything below reaches OpenTUI (`@opentui/core`), and
 * nothing above it does — the emitter and `terminal/tags.js` name roles, not
 * renderables, so the engine is an optional peer behind this one file, as
 * happy-dom is behind `render.js`. A missing install fails through
 * `missingPeer` naming the feature and the `bun add`.
 *
 * What the engine does that the DOM does not, and what this file does about it:
 *
 * - `marker()` is a `visible: false` BoxRenderable, chosen by measuring a
 *   40x12 headless frame. A zero-size box leaves no row in a column but still
 *   consumes the parent's `gap` in a row (`A  B` for `gap: 1`); an invisible
 *   box is skipped by layout altogether and still sits in the parent's child
 *   order, so `insertBefore(node, marker)` places correctly.
 * - `insertBefore` with a node that is already a child MOVES it (the engine
 *   splices it out of layout order and reinserts), so a reordered `{#each}`
 *   row is one node and no remove-first is needed.
 * - A block marker appended to a fragment has no parent yet, because a
 *   component builds its tree in an array before the final `append(__anchor,
 *   …)`. Nodes placed before such a marker go into the array at the marker's
 *   position and ride into the real parent with it.
 * - Text attributes (`bold`, `italic`, `dim`, `underline`, `inverse` and
 *   `strike` in the tag table) are cell attributes on a TextRenderable, so a
 *   box carries its bits and stamps every text that lands under it, through
 *   boxes appended later.
 * - The engine lays out boxes and has no line boxes, so a box paints each
 *   run of text and text-only inline tags as one engine text it keeps beside
 *   them, and hides the run (`FlowBox`). Without it, every piece of a
 *   sentence took a row of its own, and a row narrower than its pieces
 *   painted them over each other. A link in the run is hidden with it, so
 *   a press on the run's cells is handed to the node that wrote them
 *   (`relay`), and Tab still stops at a hidden link.
 * - A button paints as `[ label ]` on one row rather than a bordered box: a
 *   bordered box fills the parent's width and three rows, which in a 40x12
 *   frame is a quarter of the screen per button.
 * - Writing an input's `value` makes the engine emit `input`, which a DOM
 *   program write never does, so `set_attribute` mutes the handler for the
 *   duration of the write. Without the mute, a handler that logs or
 *   validates runs on every render.
 * - Key dispatch runs the renderer's global listeners before the focused
 *   renderable's, and `preventDefault` on the global stops the focused one
 *   seeing it. Every key is therefore taken by ONE global listener per
 *   renderer (`keys`), which sends the DOM events and runs their defaults —
 *   Tab moves focus without typing a tab into an input — before a field
 *   types anything. One per renderer, not per mount: the shell mounts its
 *   list and a route on one renderer, and a listener each moved focus twice
 *   per Tab.
 * - The engine draws a child over its own parent's earlier siblings only, so
 *   a modal `<dialog>` is moved under a backdrop on the screen's root while it
 *   is open, and a hidden box holds its place (`__home`). Every walk up the
 *   tree goes through `up`, which steps from the dialog to that place, so its
 *   events still bubble through the component that wrote it.
 * - A box with no background leaves the cells beneath it showing, and a
 *   background is a color. A modal dialog, and a box whose class a browser
 *   paints opaque (`opaque`), blank their own cells instead, a glass one
 *   (`frosted`) frosts them, and the backdrop sets the dim bit on everything
 *   drawn before it.
 * - The engine fits a column of boxes into its parent's height by shrinking
 *   them, so a page taller than the screen painted its rows over each other.
 *   A mount goes into the renderer's document (`documentOf`), a box the size
 *   of the screen that scrolls what is in it, as a browser's page does.
 */
import { createRoot, createEffect, createSignal, onCleanup, eachItems, setRenderEnvironment, captureContext } from './runtime.js'
import { missingPeer } from './optional-peer.js'
import { TERMINAL_TAGS, TERMINAL_EVENTS, WIDGET_ROLES, isInline, inputKind, pickerHidden, opaque, frosted } from './terminal/tags.js'
import { htmlEntitiesToText } from './entities.js'

// A terminal is a running client with no DOM: `$.onMount` runs and a watch is
// live, where `runtime.js` left to itself takes a process with no `document`
// for a server render and makes both no-ops. Set as this module loads, which
// is before any component that imports it evaluates.
setRenderEnvironment(false, true)

const core = await import('@opentui/core').catch(missingPeer('@opentui/core', 'the terminal target'))
const { BoxRenderable, TextRenderable, InputRenderable, TextareaRenderable, ScrollBoxRenderable, TextAttributes, RGBA, StyledText } = core

/**
 * `<textarea>`: the engine's multi-line field, given the half of its one-line
 * subclass's contract it lacks — a `value`, and `input` and `change` emitted
 * as `InputRenderable` emits them, so one `inputSource` reads both. The
 * engine's own content event arrives a microtask after the edit and reads the
 * text then, so two quick edits would report the second text twice; `input`
 * here fires at the edit, from the two places a person edits: a key and a
 * paste. Enter types a new line and emits no `enter`, so the field never
 * submits its form.
 */
class FieldArea extends TextareaRenderable {
  __committed = ''
  get value() { return this.plainText }
  set value(v) {
    if (v === this.plainText) return
    this.setText(v)
    this.cursorOffset = v.length
  }
  handleKeyPress(key) { return this.#edited(() => super.handleKeyPress(key)) }
  handlePaste(event) { this.#edited(() => super.handlePaste(event)) }
  insertText(text) { joined(this, text, (s) => super.insertText(s)) }
  #edited(run) {
    const before = this.plainText
    const out = run()
    if (this.plainText !== before) this.emit('input', this.plainText)
    return out
  }
  focus() { super.focus(); this.__committed = this.plainText }
  blur() {
    if (!this.isDestroyed && this.plainText !== this.__committed) {
      this.__committed = this.plainText
      this.emit('change', this.plainText)
    }
    super.blur()
  }
}

/**
 * `<select>`: one row showing the chosen option's text, padded to the widest
 * option so the row keeps its width as the choice moves, as a browser's does.
 * The options are hidden children, built by the template like any others, so
 * an `{#each}` of them needs nothing of its own. Which one is chosen is read
 * off them (`chosen`) each frame, before layout, so options that arrive after
 * the value are matched to it as they land (`FJS-1320`).
 */
class SelectBox extends BoxRenderable {
  // What was last written as the value, or NONE once a person picks.
  __wanted = NONE
  __picked = null
  onLifecyclePass = () => {
    const all = options(this)
    const width = Math.max(0, ...all.map((o) => optionLabel(o).length))
    const pick = chosen(this)
    set_text(this.__label, (pick ? optionLabel(pick) : '').padEnd(width) + ' \u25BE')
  }
}

const NONE = Symbol('none')

const GRAPHEMES = new Intl.Segmenter()

/**
 * Insert `text` into a field, joined to the grapheme before the cursor when
 * it continues that grapheme. The engine reads a key per code point, so a
 * grapheme typed or pasted as one (👍🏽, 👩‍💻, e + U+0301) arrives as several
 * inserts, and each past the first leaves the cursor a cluster's width beyond
 * the text — or, after a combining mark, inside the cluster — where the next
 * key lands.
 */
function joined(field, text, insert) {
  const at = field.cursorOffset
  let last = ''
  for (const g of GRAPHEMES.segment(field.getTextRange(Math.max(0, at - 32), at))) last = g.segment
  if (!last || [...GRAPHEMES.segment(last + text)].length !== 1) return insert(text)
  field.deleteCharBackward()
  insert(last + text)
}

/**
 * `<input>` as a text field: the engine's, with `password` drawn as a browser
 * draws it. The engine has no mask, so the field holds the real text, edits
 * it with every key binding it has, and each cell its text was drawn into is
 * overwritten with `•` before the frame is flushed; the cursor and the
 * placeholder are drawn apart from those cells. A wide character is two
 * cells and masks as two.
 *
 * A date, a time, a month or a week is typed in its value's own format,
 * which is the placeholder whatever the author wrote, as a browser ignores
 * a placeholder on one. `value` reads `''` until the text is a whole valid
 * value and a malformed write stores `''`, as a browser sanitizes it.
 */
class Field extends InputRenderable {
  __mask = false
  __format = null
  __placeholder = ''
  get value() { return this.__format ? this.__format.read(super.value) : super.value }
  set value(v) { super.value = this.__format ? this.__format.read(v) : v }
  typed(type) {
    const t = type == null ? 'text' : String(type).toLowerCase()
    this.__mask = t === 'password'
    this.__format = TYPED_FIELDS[t] ?? null
    this.placeholder = this.__format?.placeholder ?? this.__placeholder
    if (this.__format && this.plainText && !this.value) {
      this.__muted = true
      try { super.value = '' } finally { this.__muted = false }
    }
    this.requestRender()
  }
  insertText(text) { joined(this, text, (s) => super.insertText(s)) }
  renderSelf(buffer) {
    super.renderSelf(buffer)
    if (!this.__mask) return
    const text = this.plainText
    if (!text) return
    const cells = Math.min(this.width, stringWidth(text) - this.editorView.getViewport().offsetX)
    const { char } = buffer.buffers
    const at = this.screenY * buffer.width + this.screenX
    for (let i = 0; i < cells; i++) char[at + i] = 0x2022
  }
}

/**
 * `<input type="file">`: a terminal has no picker, so the control is a field
 * a path is typed into. Committing it, by Enter or by leaving the field,
 * reads that file into `files` and fires `input` then `change`, as a browser
 * does when its picker closes on a new choice (`choose`). `value` is the
 * browser's `C:\fakepath\` plus the name, and `''` clears the choice.
 *
 * One hidden by `pickerHidden` paints nothing until `click()`, which the
 * kit's `FileUpload` calls from its own button: then it shows in place and
 * takes focus, and leaving it hides it again, as a picker opens on demand.
 */
class FilePath extends Field {
  __files = []
  __placeholder = 'path to a file'
  __hidden = false
  __opener = null
  __picks = 0
  get files() { return this.__files }
  get value() { return this.__files[0] ? `C:\\fakepath\\${this.__files[0].name}` : '' }
  set value(v) { if (v === '' || v == null) this.__files = [] }
  /** The typed text, written without the engine's `input`. */
  say(text, placeholder = this.__placeholder) {
    this.__muted = true
    try { super.value = text } finally { this.__muted = false }
    this.placeholder = placeholder
  }
  open() {
    if (!this.__hidden) { this.focus(); return }
    this.__opener = _renderer?.currentFocusedRenderable ?? null
    this.visible = true
    this.focus()
  }
  blur() {
    super.blur()
    if (!this.__hidden || !this.visible) return
    this.visible = false
    const back = this.__opener
    this.__opener = null
    if (back && !back.isDestroyed && back.focusable) back.focus()
  }
}

/**
 * The path committed in a file field, read into its `files`. A path that
 * reads no file leaves the choice as it was and says so in the empty field,
 * since a browser's picker can only offer a file that exists. `~/` is the
 * home directory and anything else is resolved from the working directory.
 */
async function choose(node, text) {
  const pick = ++node.__picks
  const path = text.trim()
  let files = []
  if (path) {
    const at = path.startsWith('~/') ? (process.env.HOME ?? '~') + path.slice(1) : path
    try {
      const f = Bun.file(at)
      const bytes = await f.arrayBuffer()
      // A browser's type is the bare media type: no `;charset=`.
      const type = f.type.split(';')[0]
      files = [new File([bytes], at.split(/[\\/]/).pop(), { type: type === 'application/octet-stream' ? '' : type })]
    } catch {
      if (pick === node.__picks) node.say('', `no file at ${path}`)
      return
    }
  }
  if (pick !== node.__picks || node.isDestroyed) return
  if (!files.length && !node.__files.length) return
  node.__files = files
  node.placeholder = node.__placeholder
  dispatch(node, 'input')
  dispatch(node, 'change')
}

/** A file field's commit, and Enter, which in one opened by `click()` hands
 *  focus back to what opened it rather than submitting the form. */
function fileSource(node) {
  node.on('change', (text) => void choose(node, text))
  node.on('enter', () => { if (node.__hidden) node.blur() })
}

// ─── typed fields ─────────────────────────────────────────────────────

// HTML's valid date, time, month and week strings (§ 2.3.5). `read` answers
// the value a browser's `input.value` would, or `''`.
const leap = (y) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
const daysIn = (y, m) => m === 2 ? (leap(y) ? 29 : 28) : [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
// A year has 53 ISO weeks when it starts on a Thursday, or on a Wednesday in
// a leap year.
const weeksIn = (y) => {
  const jan1 = new Date(0)
  jan1.setUTCFullYear(y, 0, 1)
  const day = jan1.getUTCDay()
  return day === 4 || (day === 3 && leap(y)) ? 53 : 52
}
const YEAR = '(\\d{4,})'
const TIME = '(\\d\\d):(\\d\\d)(?::(\\d\\d)(?:\\.(\\d{1,3}))?)?'
const DATE_RE = new RegExp(`^${YEAR}-(\\d\\d)-(\\d\\d)$`)
const TIME_RE = new RegExp(`^${TIME}$`)
const MONTH_RE = new RegExp(`^${YEAR}-(\\d\\d)$`)
const WEEK_RE = new RegExp(`^${YEAR}-W(\\d\\d)$`)
const LOCAL_RE = new RegExp(`^${YEAR}-(\\d\\d)-(\\d\\d)[T ]${TIME}$`)

const validDate = (y, m, d) => +y > 0 && +m >= 1 && +m <= 12 && +d >= 1 && +d <= daysIn(+y, +m)
const validTime = (h, m, s = '0') => +h <= 23 && +m <= 59 && +s <= 59
const parse = (re, test) => (s) => { const m = re.exec(String(s ?? '')); return m && test(...m.slice(1)) ? m : null }
const whole = (re, test) => { const p = parse(re, test); return (s) => p(s) ? String(s) : '' }
const parseLocal = parse(LOCAL_RE, (y, mo, d, h, mi, s) => validDate(y, mo, d) && validTime(h, mi, s))

const TYPED_FIELDS = {
  date:  { placeholder: 'yyyy-mm-dd', read: whole(DATE_RE, validDate) },
  time:  { placeholder: 'hh:mm',      read: whole(TIME_RE, validTime) },
  month: { placeholder: 'yyyy-mm',    read: whole(MONTH_RE, (y, m) => +y > 0 && +m >= 1 && +m <= 12) },
  week:  { placeholder: 'yyyy-Www',   read: whole(WEEK_RE, (y, w) => +y > 0 && +w >= 1 && +w <= weeksIn(+y)) },
  // A date and a time read back normalized: a `T` between them, and the
  // shortest time that says the same, as a browser hands it back.
  'datetime-local': {
    placeholder: 'yyyy-mm-ddThh:mm',
    read: (s) => {
      const m = parseLocal(s)
      if (!m) return ''
      const [, y, mo, d, h, mi, sec = '00', frac = ''] = m
      const ms = frac.replace(/0+$/, '')
      const tail = ms ? `:${sec}.${ms}` : sec !== '00' ? `:${sec}` : ''
      return `${y}-${mo}-${d}T${h}:${mi}${tail}`
    },
  },
}

/**
 * `<input type="checkbox">` and `type="radio"`: one row showing the state, as
 * the box a browser draws. `checked` is the property, and a radio checked
 * unchecks the rest of its group (`radioGroup`), as the DOM's setter does.
 * `value` is the attribute, or `on` without one.
 */
class CheckBox extends BoxRenderable {
  __checked = false
  get checked() { return this.__checked }
  set checked(v) {
    this.__checked = !!v
    if (this.__checked && radio(this)) for (const r of radioGroup(this)) if (r !== this) r.checked = false
    this.paint()
  }
  get value() { const v = this.__attrs.value; return v == null ? 'on' : v === true ? '' : String(v) }
  paint() {
    if (this.isDestroyed) return
    const [open, close, on] = radio(this) ? ['(', ')', '•'] : ['[', ']', 'x']
    set_text(this.__label, open + (this.__checked ? on : ' ') + close)
  }
}

const radio = (node) => String(node.__attrs.type).toLowerCase() === 'radio'

/** The radios that share `node`'s `name` and form, as HTML groups them; a
 *  radio with no name is a group of its own. */
function radioGroup(node) {
  const name = node.__attrs.name
  if (name == null || name === '') return [node]
  const form = formOf(node)
  let root = node
  while (up(root)) root = up(root)
  return descendants(root, (n) => n instanceof CheckBox && radio(n) && n.__attrs.name === name && formOf(n) === form)
}

/**
 * `<progress>`: one row the width of its parent, `value` over `max` of it
 * filled. The fill is drawn when layout hands the box its width, since a
 * bar sized to its own text would never widen past the text it started
 * with. The numbers are read as a browser reads them: a `value` that is no
 * number makes the bar indeterminate, a `max` that is no positive number is
 * 1, and the value is held between 0 and `max`.
 */
class ProgressBar extends BoxRenderable {
  onResize(width, height) {
    super.onResize(width, height)
    this.draw()
  }
  draw() {
    const value = parseFloat(this.__attrs.value)
    if (Number.isNaN(value)) { set_text(this.__label, 'in progress'); return }
    const raw = parseFloat(this.__attrs.max)
    const max = raw > 0 ? raw : 1
    const filled = Math.round(this.width * Math.min(1, Math.max(0, value / max)))
    set_text(this.__label, '█'.repeat(filled) + '░'.repeat(this.width - filled))
  }
}

/**
 * `<dialog>`: laid out only while `open`. `show()` opens it where it sits;
 * `showModal()` opens it in the top layer (`enterTopLayer`), moves focus to
 * its `autofocus` control or its first, and keeps Tab inside it; `close()`
 * hides it, hands focus back to what held it before, and sends `close` a task
 * later, as a browser queues it. Escape sends the top modal `cancel`, and
 * closes it unless that is prevented (`keys`). A press inside it that lands
 * on no control sends no `click`, where a browser sends one at whatever was
 * pressed; the kit's dialogs listen only for the backdrop's.
 */
class DialogBox extends BoxRenderable {
  returnValue = ''
  get open() { return 'open' in this.__attrs }
  set open(v) { set_attribute(this, 'open', v ? '' : null) }
  show() {
    if (this.open) return
    set_attribute(this, 'open', '')
  }
  showModal() {
    if (this.__home) return
    if (this.open) throw new Error('[Mesa] showModal() on a <dialog> that show() already opened')
    if (!connected(this)) throw new Error('[Mesa] showModal() on a <dialog> that is not on the screen')
    const r = needRenderer('showModal')
    this.__returnFocus = r.currentFocusedRenderable
    set_attribute(this, 'open', '')
    enterTopLayer(r, this)
    const inside = focusables(this)
    const first = inside.find((n) => 'autofocus' in (n.__attrs ?? {})) ?? inside[0]
    if (first) first.focus()
    else r.currentFocusedRenderable?.blur()
  }
  close(value) {
    if (!this.open) return
    if (value !== undefined) this.returnValue = String(value)
    const back = this.__returnFocus
    this.__returnFocus = null
    const focused = _renderer?.currentFocusedRenderable
    set_attribute(this, 'open', null)
    if (focused && within(focused, this)) focused.blur()
    if (back && !back.isDestroyed && back.focusable) back.focus()
    setTimeout(() => { if (!this.isDestroyed) dispatch(this, 'close') })
  }
  // Blank under a modal dialog: the page behind it is drawn first and would
  // show through every cell the dialog leaves empty.
  renderBefore = function (buffer) {
    if (this.__glass) frost.call(this, buffer)
    else if (this.__home || this.__opaque) blank.call(this, buffer)
  }
}

/**
 * A box from the tag table, laid out as a browser lays out line boxes. Text,
 * and inline tags holding only text, that sit side by side are painted as one
 * run of words (`phrasing`), which the engine wraps between words. The run's
 * own nodes stay in the tree and are never laid out, so a live text, an
 * attribute and a block marker keep writing to them, and the run is read off
 * them each frame, before layout. A box whose every child is inline-level
 * lays them in a row that wraps, so a button sits on the line beside its
 * words; one holding a block stacks them, as a block breaks the line.
 */
class FlowBox extends BoxRenderable {
  // The first node of each run → the text that paints the run.
  __runs = new Map()
  __direction = null
  onLifecyclePass = () => flow(this)
}

/**
 * A table row, whose cells take equal shares of it. The engine splits a width
 * the cells do not divide into fractions of a column, and rounds a text's far
 * edge up where it rounds a box's to the nearest, so a text in a fractional
 * cell is measured at one width and painted at the next one up: the lines it
 * paints are not the lines it was laid out with, and the block after it is
 * drawn over its last one, or a blank row is left (`FJS-3413`). Each frame,
 * before layout, the row hands its cells whole columns of the width it was
 * last laid out at, the odd ones to the first cells. `flexGrow` holds the
 * share for the first frame and the one a resize lands on, which redraws.
 */
class RowBox extends BoxRenderable {
  onLifecyclePass = () => share(this)
}

function share(row) {
  const cells = row.getChildren().filter((c) => TERMINAL_TAGS[c.__tag]?.cell && laidOut(c))
  if (!cells.length || !row.width) return
  const each = Math.floor(row.width / cells.length)
  const odd = row.width % cells.length
  cells.forEach((c, i) => {
    const basis = each + (i < odd ? 1 : 0)
    // The engine asks for a frame on every write, so only a change is written.
    if (c.__basis !== basis) { c.__basis = basis; c.flexBasis = basis }
  })
}

/**
 * `<details>`: its `<summary>` always shows and the rest only while `open`.
 * The rest goes into a body box of its own (`attach`), which is shown and
 * hidden whole, so a run's own hiding of its members never shows content a
 * closed one holds. Every change of `open` sends `toggle` a task later, one
 * for any number of changes before it, and none when they cancel out, as a
 * browser coalesces it.
 */
class DetailsBox extends BoxRenderable {
  get open() { return 'open' in this.__attrs }
  set open(v) { set_attribute(this, 'open', v ? '' : null) }
}

const CLEAR = RGBA.fromValues(0, 0, 0, 0)

/** A box's `renderBefore` that writes a space to each of its cells, so
 *  nothing drawn before it shows through one its children leave empty. */
function blank(buffer) {
  for (let y = 0; y < this.height; y++) {
    for (let x = 0; x < this.width; x++) buffer.setCell(this.screenX + x, this.screenY + y, ' ', CLEAR, CLEAR, 0)
  }
}

const SPACE = 0x20
const HAZE  = '·'.codePointAt(0)
// How many cells a glyph behind spreads its haze; nearest first, so the
// closest glyph colors the dot.
const REACH = 2
const NEAR  = []
for (let dy = -REACH; dy <= REACH; dy++) for (let dx = -REACH; dx <= REACH; dx++) NEAR.push([dx, dy])
NEAR.sort((a, b) => Math.hypot(...a) - Math.hypot(...b))

/** A glass box's `renderBefore`. A cell beside a character of what is behind
 *  becomes a dim dot in that character's color, and every other cell a space,
 *  so the page shows through as a blurred haze, its colors kept and its text
 *  gone. The rows of the box's own text are cleared, ground and all, from its
 *  left edge to a cell past their end: a text's spaces leave the cell under
 *  them showing, and haze between its words would read as part of the line. */
function frost(buffer) {
  const { char, fg, bg, attributes } = buffer.buffers
  const W = buffer.width, H = buffer.height
  const x0 = Math.max(0, this.screenX), x1 = Math.min(W, this.screenX + this.width)
  const y0 = Math.max(0, this.screenY), y1 = Math.min(H, this.screenY + this.height)
  if (x0 >= x1 || y0 >= y1) return
  const per = fg.length / char.length
  const behind = char.slice(), inks = fg.slice()
  const glyph = (x, y) => x >= 0 && x < W && y >= 0 && y < H && behind[y * W + x] !== SPACE && behind[y * W + x] !== 0
  const clear = cleared(this)
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * W + x
      const plain = x < (clear.get(y) ?? -1)
      const near = plain ? null : NEAR.find(([dx, dy]) => glyph(x + dx, y + dy))
      char[i] = near ? HAZE : SPACE
      attributes[i] = TextAttributes.DIM
      if (plain) bg.fill(0, i * per, i * per + per)
      if (near) {
        const j = (y + near[1]) * W + x + near[0]
        for (let k = 0; k < per; k++) fg[i * per + k] = inks[j * per + k]
      }
    }
  }
}

/** Each screen row of `box`'s own text or controls → the column its clear run
 *  ends before. A control's whole width is cleared, since an input's empty
 *  cells are its own. */
function cleared(box) {
  const ends = new Map()
  const reach = (y, end) => { if (end > (ends.get(y) ?? -1)) ends.set(y, end) }
  const walk = (n) => {
    for (const c of n.getChildren()) {
      if (!c.visible) continue
      if (c.focusable) {
        for (let y = 0; y < c.height; y++) reach(c.screenY + y, c.screenX + c.width + 1)
      } else if (c instanceof TextRenderable) {
        const widths = c.lineInfo?.lineWidthCols ?? []
        widths.forEach((w, y) => { if (w) reach(c.screenY + y, c.screenX + w + 1) })
      } else walk(c)
    }
  }
  walk(box)
  return ends
}

// ─── the current renderer ─────────────────────────────────────────────

let _renderer = null

function needRenderer(what) {
  if (!_renderer) throw new Error(`[Mesa] $$host.${what}() before mount(): no renderer is current`)
  return _renderer
}

// ─── attributes ───────────────────────────────────────────────────────

const BITS = { bold: 'BOLD', italic: 'ITALIC', dim: 'DIM', underline: 'UNDERLINE', inverse: 'INVERSE', strike: 'STRIKETHROUGH' }

function bitsOf(spec) {
  let bits = 0
  for (const name in BITS) if (spec[name]) bits |= TextAttributes[BITS[name]]
  return bits
}

/** Stamp `bits` onto a subtree: a text takes them as cell attributes, a box
 *  keeps them for the texts appended to it later. */
function inherit(node, bits) {
  if (!bits || !node || node.__marker) return
  if (node instanceof TextRenderable) { node.attributes = node.attributes | bits; return }
  node.__bits = (node.__bits | 0) | bits
  if (typeof node.getChildren === 'function') for (const c of node.getChildren()) inherit(c, bits)
}

// ─── tree ─────────────────────────────────────────────────────────────

export function fragment() { return [] }

/** Put `node` under a real renderable, before `before` when given. A button
 *  keeps its closing bracket as `__tail`, so its content lands inside it. */
function attach(parent, node, before = null) {
  node = node.__home ?? node
  // A `<details>` takes its first `<summary>` as its own child, above the
  // body, and everything else into the body.
  if (parent instanceof DetailsBox) {
    const summary = parent.__summary
    if (node.__tag === 'summary' && (!summary || summary === node || summary.isDestroyed)) {
      parent.__summary = node
      set_text(node.__triangle, triangle(parent.open))
      before = parent.__body
    } else {
      parent = parent.__body
      if (before?.parent !== parent) before = null
    }
  }
  node.__fragment = null
  inherit(node, parent.__bits)
  const anchor = before ?? parent.__tail ?? null
  anchor ? parent.insertBefore(node, anchor) : parent.add(node)
  if (parent.__announce) announce(parent)
}

/** A component's `__anchor` is the marker its caller placed, so appending
 *  to a marker places before it, where the DOM path inserts before the
 *  anchor comment. */
export function append(parent, child) {
  if (Array.isArray(child)) { for (const c of child) append(parent, c); return }
  if (Array.isArray(parent)) { parent.push(child); child.__fragment = parent; return }
  if (parent.__marker) { placeBefore(parent, child); return }
  attach(parent, child)
}

function toNodes(out) { return Array.isArray(out) ? out : out == null ? [] : [out] }

/** Place `node` immediately before `marker`, wherever the marker currently
 *  lives: a real parent, or the fragment a component is still assembling. */
function placeBefore(marker, node) {
  node = node.__home ?? node
  if (marker.parent) { attach(marker.parent, node, marker); return }
  const fr = marker.__fragment
  if (!fr) throw new Error('[Mesa] a block marker is in no parent and no fragment — append the marker before running the block')
  const at = fr.indexOf(node)
  if (at >= 0) fr.splice(at, 1)
  fr.splice(fr.indexOf(marker), 0, node)
  node.__fragment = fr
}

/** Take `node` out of wherever it is and free it. `destroy` removes from a real
 *  parent and blurs it if focused; a fragment member is spliced out. */
function detach(node) {
  const fr = node.__fragment
  if (fr) { const at = fr.indexOf(node); if (at >= 0) fr.splice(at, 1); node.__fragment = null }
  const parent = node.parent
  node.destroyRecursively()
  if (parent?.__announce && !parent.isDestroyed) announce(parent)
}

// ─── nodes ────────────────────────────────────────────────────────────

export function element(tag, attrs = {}) {
  const spec = TERMINAL_TAGS[tag]
  if (!spec) throw new Error(`[Mesa] <${tag}> has no terminal lowering`)
  const r = needRenderer('element')
  const bits = bitsOf(spec)
  let node
  switch (spec.role) {
    case 'box':
      node = new (spec.row ? RowBox : spec.hidden ? BoxRenderable : FlowBox)(r, {
        flexDirection: spec.row || spec.inline ? 'row' : 'column',
        ...(spec.indent && { paddingLeft: spec.indent }),
        // flexBasis 0 is what makes the share equal: an auto basis starts each
        // cell at its content's width, and the columns drift row to row. The
        // row then makes each share a whole number of columns (`RowBox`).
        ...(spec.cell && { flexGrow: 1, flexBasis: 0, paddingRight: 1 }),
        ...(spec.hidden && { visible: false }),
      })
      break
    case 'rule':
      node = new BoxRenderable(r, { border: ['top'], height: 1 })
      break
    case 'button': {
      // A button's content is a line of its own, as an inline-block's is, so
      // its brackets and its label are one run and the label's edge spaces
      // collapse into the brackets'.
      node = new FlowBox(r, { flexDirection: 'row', focusable: true })
      const open = text('[ ')
      const tail = text(' ]')
      open.__chrome = tail.__chrome = true
      node.add(open)
      node.add(tail)
      node.__tail = tail
      // The frame has no other focus cue for a button: the brackets invert
      // while it is focused, and the characters never change.
      focusCue(node, [open, tail])
      break
    }
    case 'select': {
      node = new SelectBox(r, { flexDirection: 'row', focusable: true })
      const label = text('')
      node.add(label)
      // The options land before the label, where they take no room.
      node.__tail = node.__label = label
      focusCue(node, [label])
      node.__keyAction = (name) => name === 'up' || name === 'down' ? step(node, name === 'up' ? -1 : 1) : false
      Object.defineProperty(node, 'value', {
        get: () => { const o = chosen(node); return o ? String(optionValue(o)) : '' },
        configurable: true,
      })
      break
    }
    case 'image':
      node = new BoxRenderable(r, { flexDirection: 'row', visible: false })
      node.__label = text('')
      node.add(node.__label)
      break
    case 'progress':
      node = new ProgressBar(r, { width: '100%', height: 1 })
      node.__label = text('')
      node.add(node.__label)
      break
    case 'details':
      node = new DetailsBox(r, { flexDirection: 'column' })
      node.__body = new FlowBox(r, { flexDirection: 'column', visible: false })
      node.add(node.__body)
      break
    case 'summary': {
      node = new FlowBox(r, { flexDirection: 'row', focusable: true })
      node.__triangle = text(triangle(false))
      node.add(node.__triangle)
      invertWhileFocused(node)
      break
    }
    case 'dialog':
      node = new DialogBox(r, {
        flexDirection: 'column', border: true, paddingLeft: 1, paddingRight: 1,
        maxWidth: '100%', maxHeight: '100%', overflow: 'hidden', visible: false,
      })
      break
    case 'input': {
      const kind = inputKind(attrs.type)
      if (!kind) throw new Error(`[Mesa] <input type="${attrs.type}"> has no terminal lowering`)
      if (kind === 'file') {
        node = new FilePath(r, { minWidth: 20 })
        // The kit opens its hidden picker with `input.click()`.
        node.click = () => { if (!dispatch(node, 'click').defaultPrevented) node.open() }
      } else if (kind === 'field') {
        // A browser's text field is 20 characters wide unless `size` says
        // otherwise; with no width of its own, a field beside its label in a
        // row shrinks to one cell.
        node = new Field(r, { minWidth: 20 })
      } else if (kind === 'check') {
        node = new CheckBox(r, { flexDirection: 'row' })
        node.__label = text('')
        node.add(node.__label)
        focusCue(node, [node.__label])
      } else {
        node = new BoxRenderable(r, { visible: false })
      }
      node.__kind = kind
      break
    }
    case 'textarea':
      node = new FieldArea(r, {})
      break
    default:
      throw new Error(`[Mesa] <${tag}> has terminal role '${spec.role}', which this runtime does not build`)
  }
  node.__tag = tag
  node.__bits = bits
  node.__attrs = {}
  const field = node instanceof TextareaRenderable
  node.__canFocus = spec.role === 'button' || spec.role === 'select' || field || node instanceof CheckBox
  // A handler written for the DOM reads `e.target.name`, and the engine has
  // no `name` of its own; `value` it already has on a field.
  Object.defineProperty(node, 'name', { get: () => node.__attrs.name, configurable: true })
  // A key shortcut asks `tagName` and `type` whether the key is somebody's
  // typing before it acts on one.
  Object.defineProperty(node, 'tagName', { value: tag.toUpperCase(), configurable: true })
  if (tag === 'input') Object.defineProperty(node, 'type', { get: () => String(node.__attrs.type ?? 'text').toLowerCase(), configurable: true })
  // A click-away handler asks whether the click landed inside it. Inclusive,
  // as the DOM's is, and through `up`, so a lifted dialog is still inside the
  // component that wrote it.
  node.contains = (other) => { for (let n = other; n; n = up(n)) if (n === node) return true; return false }
  // What an attachment written for the DOM calls on its element, through
  // `on()`, so an event a terminal does not send throws by name.
  node.addEventListener = (type, fn, opts = false) => {
    const { capture = false, once = false } = typeof opts === 'boolean' ? { capture: opts } : opts
    on(node, type, fn, { capture, once })
  }
  node.removeEventListener = (type, fn, opts = false) => {
    const capture = typeof opts === 'boolean' ? opts : !!opts.capture
    const list = node.__listeners?.[type]
    const at = list ? list.findIndex((l) => l.fn === fn && l.capture === capture) : -1
    if (at >= 0) list.splice(at, 1)
  }
  // Where `@frontierjs/mesa/keys` puts a keymap on a terminal node: stepped
  // by `onKey` before the keydown is made, rather than heard in it.
  node.__hostKeys = (host) => {
    const set = (node.__keymaps ??= new Set())
    set.add(host)
    return () => set.delete(host)
  }
  if (node instanceof FilePath) fileSource(node)
  else if (field) inputSource(node)
  if (spec.role === 'button' || spec.role === 'summary' || node instanceof CheckBox) activatable(node)
  else if (node.__canFocus) focusSource(node)
  for (const name in attrs) set_attribute(node, name, attrs[name])
  if (node instanceof CheckBox) node.paint()
  return node
}

/**
 * The one owner of an attribute on a terminal node, static or live: the
 * emitter hands a static attribute to `element()`, which routes it here, and
 * a live one arrives from a render effect. `null` and `false` remove, as on
 * the DOM path; a name with no terminal meaning (`aria-*`) is kept on
 * `__attrs` and paints nothing. A `class` paints nothing either, except that
 * one a browser paints opaque blanks the box (`opaque`). An `href` makes an
 * `<a>` a link (`link`).
 *
 * `value` is the control's current text, the way the DOM property is: the
 * engine emits `input` when its value is written, which a DOM program write
 * never does, so the write is muted.
 */
const ANNOUNCED = new Set(['role', 'aria-label', 'aria-valuetext', 'aria-valuenow'])

/** A box with a `tabindex` of 0 or more is a Tab stop that hears its keys,
 *  inverted while focused; anything less leaves focus to what already made
 *  the node focusable (a button, a link, a `click` listener). */
function tabStop(node) {
  if (TERMINAL_TAGS[node.__tag]?.role !== 'box') return
  if (parseInt(node.__attrs.tabindex, 10) >= 0) {
    node.__canFocus = true
    node.focusable = !disabled(node)
    focusSource(node)
    invertWhileFocused(node)
  } else if (!node.__activatable) {
    node.__canFocus = false
    node.focusable = false
    if (node.focused) node.blur()
  }
}

/** Whether anything under `node` paints a character: a button's brackets, its
 *  announcement and a block's marker do not, nor does a hidden box. */
function paintsText(node) {
  return node.getChildren().some((c) => {
    if (c === node.__announce || c.__marker || c.__chrome || c.visible === false) return false
    return c instanceof TextRenderable ? (c.__t ?? c.plainText) !== '' : paintsText(c)
  })
}

/** A button or a link is named by its `aria-label` where its content paints no
 *  text, as an icon's does; a widget role also reads its value. */
const named = (node) => node.__tag === 'button' || (node.__tag === 'a' && node.__link)

/** What a screen reader says for a widget with a name and no content: the
 *  `aria-label`, then the value. A box with content of its own paints that
 *  and nothing more, so the text goes empty while one is there; a block's
 *  marker holds none. */
function announce(node) {
  const role = TERMINAL_TAGS[node.__tag]?.role
  if (role !== 'box' && role !== 'button') return
  const a = node.__attrs
  const words = named(node) ? [a['aria-label']]
    : WIDGET_ROLES.has(a.role) ? [a['aria-label'], a['aria-valuetext'] ?? a['aria-valuenow']] : []
  let str = words.filter((w) => w != null && w !== '').join(' ')
  if (!node.__announce) {
    if (!str) return
    node.__announce = text('')
    const [first] = node.getChildren()
    // A button's content sits between its brackets.
    role === 'button' ? node.insertBefore(node.__announce, node.__tail) : first ? node.insertBefore(node.__announce, first) : node.add(node.__announce)
  }
  if (named(node) ? paintsText(node) : node.getChildren().some((c) => c !== node.__announce && !c.__marker)) str = ''
  set_text(node.__announce, str)
}

/** Text arriving or leaving under a control named by its label gives the
 *  label up or takes it back. */
function reannounce(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (p.__announce && named(p)) { announce(p); return }
  }
}

export function set_attribute(node, name, value) {
  const present = value != null && value !== false
  if (present) node.__attrs[name] = value
  else delete node.__attrs[name]
  if (node instanceof TextareaRenderable) {
    if (name === 'value') {
      const str = present ? String(value) : ''
      // Half a date reads `''`, and a handler or a bind writes that `''`
      // straight back; replacing the text then would wipe it a key at a time.
      if (node.__format && str === node.value) return
      node.__muted = true
      try { node.value = str } finally { node.__muted = false }
      return
    }
    if (name === 'placeholder') {
      node.__placeholder = present ? String(value) : ''
      node.placeholder = node.__format?.placeholder ?? node.__placeholder
      return
    }
  }
  if (node.__kind) {
    // The renderable was chosen by the `type` the node was built with, so a
    // live one may move only within that kind: text to `password` or `date`
    // and back.
    if (name === 'type') {
      const kind = inputKind(present ? value : null)
      if (!kind) throw new Error(`[Mesa] <input type="${value}"> has no terminal lowering`)
      if (kind !== node.__kind) throw new Error(`[Mesa] <input type="${value}"> cannot replace a type="${node.__type ?? 'text'}" on a terminal, which builds one control per <input>`)
      node.__type = present ? String(value) : undefined
      if (node instanceof Field) node.typed(node.__type)
      if (node instanceof CheckBox) node.paint()
      return
    }
    if (name === 'checked' && node instanceof CheckBox) { node.checked = present; return }
    // An opened picker stays open until it is left.
    if ((name === 'hidden' || name === 'class') && node instanceof FilePath) {
      node.__hidden = pickerHidden(node.__attrs.hidden, node.__attrs.class)
      if (!node.focused) node.visible = !node.__hidden
      return
    }
  }
  if (node instanceof SelectBox) {
    if (name === 'multiple' && present) throw new Error('[Mesa] <select multiple> has no terminal lowering')
    // The DOM path writes an absent value as `el.value = ''`, which chooses
    // the option whose value is empty.
    if (name === 'value') { node.__wanted = present ? value : ''; return }
  }
  if (name === TERMINAL_TAGS[node.__tag]?.text) {
    const str = present ? String(value) : ''
    set_text(node.__label, str)
    node.visible = str !== ''
    return
  }
  if (node instanceof ProgressBar && (name === 'value' || name === 'max')) { node.draw(); return }
  if (node instanceof DetailsBox && name === 'open') { opened(node, present); return }
  if (node instanceof DialogBox && name === 'open') {
    node.visible = present
    if (!present && node.__home) leaveTopLayer(node)
    return
  }
  if (name === 'class') { paintOpaque(node); return }
  if (name === 'href' && node.__tag === 'a') { link(node, present); return }
  if (name === 'tabindex') tabStop(node)
  if (ANNOUNCED.has(name)) announce(node)
  if (name === 'size' && node instanceof Field) { node.minWidth = parseInt(value, 10) > 0 ? parseInt(value, 10) : 20; return }
  if (name === 'disabled') {
    // A disabled control takes no focus and no activation, and gives up the
    // focus it holds, as a browser's does.
    node.focusable = node.__canFocus && !present
    if (present && node.focused) node.blur()
  }
}

/**
 * `class:name={on}` on a terminal node. It paints nothing, as the `class`
 * attribute paints nothing, except a name `opaque` or `frosted` reads, which are the only
 * ones the emitter sends here.
 */
export function toggle_class(node, name, on) {
  (node.__toggled ??= new Set())[on ? 'add' : 'delete'](name)
  paintOpaque(node)
}

/** Blank `node`, frost it or stop, from its `class` and its `class:` names together. */
function paintOpaque(node) {
  if (!(node instanceof BoxRenderable)) return
  const cls = [node.__attrs.class ?? '', ...(node.__toggled ?? [])].join(' ')
  node.__opaque = opaque(cls)
  node.__glass  = frosted(cls)
  if (node instanceof DialogBox) node.borderStyle = node.__glass ? 'rounded' : 'single'
  else node.renderBefore = node.__glass ? frost : node.__opaque ? blank : undefined
}

/**
 * `{...expr}` on an element: each key goes where the same key written in the
 * source would — a value to `set_attribute`, a function under `on<event>` to
 * that event's handler — and a key the object stops carrying is removed, as
 * `spreadAttributes` does on the DOM path. A spread's keys come from data, so
 * none of them is refused: one with no terminal meaning (`onpointerdown`,
 * `style`, a function under any other name) is inert, as an inert attribute
 * is.
 *
 * A handler is wired once per event, through a slot the spread rewrites, so
 * a replaced spread object does not stack a second handler on the first.
 */
// The disclosure triangle a browser draws before a summary, pointing at the
// content while it shows.
const triangle = (open) => open ? '\u25be ' : '\u25b8 '

/** Show or hide a `<details>`'s body and point its summary's triangle. */
function opened(node, open) {
  if (open === node.__body.visible) return
  // The engine blurs a control it hides, as a browser does one in a closed
  // `<details>`.
  node.__body.visible = open
  const summary = node.__summary
  if (summary && !summary.isDestroyed) set_text(summary.__triangle, triangle(open))
  if (node.__toggleFrom !== undefined) return
  node.__toggleFrom = !open
  setTimeout(() => {
    const from = node.__toggleFrom
    node.__toggleFrom = undefined
    if (node.isDestroyed || from === node.open) return
    const state = (o) => o ? 'open' : 'closed'
    dispatch(node, 'toggle', { oldState: state(from), newState: state(node.open) })
  })
}

export function spread(node, fn) {
  const live = {}
  let prev = {}
  const put = (k, v) => {
    const event = k.length > 2 && k.startsWith('on') ? k.slice(2) : null
    if (event && (typeof v === 'function' || event in live)) {
      if (!TERMINAL_EVENTS[event]) return
      if (!(event in live)) on(node, event, (e) => live[event]?.(e))
      live[event] = typeof v === 'function' ? v : null
      return
    }
    if (typeof v !== 'function') set_attribute(node, k, v)
  }
  createEffect(() => {
    const state = fn() ?? {}
    for (const k in state) if (prev[k] !== state[k]) put(k, state[k])
    for (const k in prev) if (!(k in state)) put(k, null)
    prev = { ...state }
  })
}

export function text(value) {
  return new TextRenderable(needRenderer('text'), { content: value == null ? '' : String(value) })
}

// The tags whose end starts a new line in `innerText`, and the ones whose
// contents it never reads: a script, a stylesheet, and an inline icon, which
// a browser draws rather than writes.
const BLOCK_END = /<\/(?:p|div|li|dt|dd|h[1-6]|tr|pre|blockquote|section|article|header|footer|ul|ol|dl|table)\s*>/gi
const UNREAD = /<(script|style|svg)\b[\s\S]*?<\/\1\s*>/gi

/**
 * `{@html}` markup as the text a browser's `innerText` reads from it: tags
 * gone, a `<br>` or the end of a block a line break, references decoded.
 * Outside a `<pre>` a run of whitespace is one space and a line holds no
 * edge spaces, as the page lays it out; inside one, the whitespace stays.
 */
export function markupText(html, pre) {
  if (html == null) return ''
  let s = String(html).replace(/<!--[\s\S]*?-->/g, '').replace(UNREAD, '')
  if (!pre) s = s.replace(/\s+/g, ' ')
  s = htmlEntitiesToText(s.replace(/<br\s*\/?>/gi, '\n').replace(BLOCK_END, '\n').replace(/<[^>]*>/g, ''))
  if (pre) return s
  return s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
}

/** The text of `{@html}`: `markupText` has laid its white space out already,
 *  and each newline in it is a line break. */
export function markup() {
  const t = text('')
  t.__laid = true
  return t
}

export function set_text(node, value) {
  const str = value == null ? '' : String(value)
  if (str === node.__t) return
  const was = node.__t ?? node.plainText
  node.__t = str
  node.content = str
  if ((was === '') !== (str === '')) reannounce(node)
}

export function marker() {
  const m = new BoxRenderable(needRenderer('marker'), { visible: false })
  m.__marker = true
  return m
}

/** Invert `texts` while `node` holds focus. `destroy` blurs a focused node
 *  after its children are already gone, so the blur listener must not write
 *  into a freed text buffer. */
function focusCue(node, texts) {
  const cue = (bits) => { for (const t of texts) if (!t.isDestroyed) t.attributes = bits }
  node.on('focused', () => cue(TextAttributes.INVERSE))
  node.on('blurred', () => cue(TextAttributes.NONE))
}

// ─── flow ─────────────────────────────────────────────────────────────

const inlineLevel = (n) => n instanceof TextRenderable || isInline(n.__tag)

/** Text, or an inline tag holding only text: what can join its neighbors as
 *  one run of words. A link, or a tag something listens to, joins too: the
 *  run hands a press or a move on its cells to the node that wrote them
 *  (`relay`), and Tab stops at a node the layout never sees (`focusables`). */
function phrasing(n) {
  if (n instanceof TextRenderable) return !n.__proxy
  if (!TERMINAL_TAGS[n.__tag]?.inline) return false
  return n.getChildren().every((c) => !laidOut(c) || phrasing(c))
}

// A child the layout sees, counting one hidden only because its run paints it.
const laidOut = (n) => !n.__marker && !n.__proxy && (n.visible !== false || n.__merged)

// HTML's white space, which a browser collapses; a no-break space is not in it.
const WS = /[ \t\n\r\f]+/g
const LEADING_WS = /^[ \t\n\r\f]+/

/** The run's text as engine chunks, each with its cell attributes. Outside a
 *  `<pre>` a run of white space is one space, across tag edges too. */
function words(n, out, pre) {
  if (n instanceof TextRenderable) {
    let text = pre || n.__laid ? n.plainText : n.plainText.replace(WS, ' ')
    if (!pre && out.at(-1)?.text.endsWith(' ') && text.startsWith(' ')) text = text.slice(1)
    if (text) out.push({ __isChunk: true, text, attributes: n.attributes, from: n })
    return out
  }
  for (const c of n.getChildren()) if (laidOut(c)) words(c, out, pre)
  return out
}

function flow(box) {
  const kids = box.getChildren()
  // Each child the layout sees stands alone or is one of a run of phrasing.
  const units = []
  for (const c of kids) {
    if (!laidOut(c)) continue
    if (!phrasing(c)) units.push(c)
    else if (Array.isArray(units.at(-1))) units.at(-1).push(c)
    else units.push([c])
  }
  const dir = units.length > 1 && units.every((u) => Array.isArray(u) || inlineLevel(u)) ? 'row' : 'column'

  let pre = false
  for (let n = box; n && !pre; n = n.parent) pre = n.__tag === 'pre'
  // A line starts with no white space: in a block, every run in a column
  // starts one, and the first run in a row does. An inline tag's edges are
  // inside its parent's line.
  const edges = !pre && !isInline(box.__tag)
  const merged = new Set()
  const next = new Map()
  units.forEach((u, i) => {
    if (!Array.isArray(u)) return
    const [only] = u
    if (u.length === 1 && !(only instanceof TextRenderable)) return
    const chunks = []
    for (const m of u) words(m, chunks, pre)
    if (edges && (dir === 'column' || i === 0)) {
      while (chunks.length && !(chunks[0].text = chunks[0].text.replace(LEADING_WS, ''))) chunks.shift()
    }
    if (u.length === 1 && chunks[0]?.text === only.plainText) return
    for (const m of u) merged.add(m)
    if (!chunks.length) return
    let t = box.__runs.get(only)
    box.__runs.delete(only)
    if (!t) {
      t = new TextRenderable(box.ctx, { content: '' })
      t.__proxy = true
      t.onMouseDown = (e) => relay(t, box, e, '__pressSource')
      t.onMouseMove = (e) => { hoverTo(t.ctx, t, e); relay(t, box, e, '__moveSource') }
    }
    t.__chunks = chunks
    next.set(only, t)
    const now = box.getChildren()
    if (now[now.indexOf(only) - 1] !== t) box.insertBefore(t, only)
    const sig = chunks.map((c) => `${c.attributes}\u0001${c.text}`).join('\u0000')
    if (sig !== t.__sig) { t.__sig = sig; t.content = new StyledText(chunks) }
  })
  for (const t of box.__runs.values()) t.destroyRecursively()
  box.__runs = next

  // Only what a run hid is shown again: a box can be hidden for a reason of
  // its own, an image with no alt or a closed dialog.
  for (const c of kids) {
    const was = !!c.__merged
    c.__merged = merged.has(c)
    if (was !== c.__merged) hide(c, c.__merged)
  }
  if (dir !== box.__direction) {
    box.__direction = dir
    box.flexDirection = dir
    box.flexWrap = dir === 'row' ? 'wrap' : 'no-wrap'
  }
}

/** Hide `n` from layout, or show it again. The engine blurs a node it hides,
 *  and a link that joins a run after it took focus — a route focuses its
 *  first control as it mounts, before the first frame lays it out — would
 *  lose it, so focus is handed straight back with its events held: in the
 *  page nothing moved. */
function hide(n, on) {
  const focused = on ? n.ctx.currentFocusedRenderable : null
  const held = focused && within(focused, n) ? focused : null
  if (held) held.__still = true
  n.visible = !on
  if (held) { held.focus(); held.__still = false }
}

// A cell is a display column; the engine counts a newline in a run as one.
const stringWidth = globalThis.Bun?.stringWidth ?? ((s) => [...s].length)
const cellsOf = (text) => stringWidth(text.replace(/\n/g, ' '))

/** The text node that wrote the cell of `run` under a mouse event, or null
 *  past the end of a line. */
function cellAt(run, e) {
  const x = e.x - run.screenX
  const y = e.y - run.screenY + run.scrollY
  const { lineStartCols: starts, lineWidthCols: widths } = run.lineInfo
  if (x < 0 || y < 0 || y >= starts.length || x >= widths[y]) return null
  let col = starts[y] + x
  for (const c of run.__chunks) if ((col -= cellsOf(c.text)) < 0) return c.from
  return null
}

/** A press or a move on a run's cells, at the node that wrote them. The
 *  engine sends it up from the run, past every member, so the nearest member
 *  that is a source handles it here; above the box the engine's own walk
 *  carries on, and `pointer` reads the cell's node off the event. */
function relay(run, box, e, source) {
  const at = cellAt(run, e)
  if (!at) return
  e.__at = at
  for (let n = at.parent; n && n !== box; n = n.parent) if (n[source]) { n[source](e); return }
}

const _show = (n, on) => { if (n.visible !== on) n.visible = on }

// ─── options ──────────────────────────────────────────────────────────

const options = (select) => descendants(select, (n) => n.__tag === 'option')

/** An option's text as a browser reads it: its `label`, else its text with
 *  the whitespace collapsed. */
function optionLabel(o) {
  if (o.__attrs.label != null) return String(o.__attrs.label)
  return descendants(o, (n) => n instanceof TextRenderable)
    .map((t) => t.plainText).join('').replace(/\s+/g, ' ').trim()
}

/** The value an option stands for, unstringified, so `<option value={obj}>`
 *  binds the object as the DOM path's `__value` does. A bare `value` is ''. */
function optionValue(o) {
  if (!('value' in o.__attrs)) return optionLabel(o)
  return o.__attrs.value === true ? '' : o.__attrs.value
}

/**
 * The option a select holds, by the DOM path's rule. A written value chooses
 * the option equal to it, and none when no option is: strictly, except that
 * a string also matches an option's value as a string, as `el.value = v`
 * does. With nothing written, a person's pick, then the last option marked
 * `selected`, then the first that is not disabled.
 */
function chosen(select) {
  const all = options(select)
  const v = select.__wanted
  if (v !== NONE) return all.find((o) => optionValue(o) === v || (typeof v === 'string' && String(optionValue(o)) === v)) ?? null
  if (select.__picked && all.includes(select.__picked)) return select.__picked
  return all.findLast((o) => 'selected' in o.__attrs) ?? all.find((o) => !disabled(o)) ?? null
}

/** Up or Down on a select: the next option that is not disabled, as a
 *  browser's closed select moves, firing `input` then `change`. Never wraps. */
function step(select, by) {
  const all = options(select).filter((o) => !disabled(o))
  const now = chosen(select)
  const next = now ? all[all.indexOf(now) + by] : all[0]
  if (!next || next === now) return true
  select.__wanted = NONE
  select.__picked = next
  dispatch(select, 'input')
  dispatch(select, 'change')
  return true
}

// ─── events ───────────────────────────────────────────────────────────

/** What a DOM-written handler reads off `e.key`, from the engine's key name. */
const DOM_KEY = {
  return: 'Enter', enter: 'Enter', escape: 'Escape', tab: 'Tab', space: ' ',
  backspace: 'Backspace', delete: 'Delete', up: 'ArrowUp', down: 'ArrowDown',
  left: 'ArrowLeft', right: 'ArrowRight', home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown',
}

// What a keydown carries for the engine's key `k`; exported for a host that
// reads a key before the runtime dispatches it (sierra's terminal shell).
// Without the kitty protocol a Ctrl letter is a control byte, so its sequence
// is no letter: `e.key` is the name, as a browser's is `k` for Ctrl+K. Ctrl+J
// is 0x0A, which the engine names `linefeed`; read as a sequence it was a
// typed newline, and a handler for Ctrl+J never matched.
export const keyFields = (k) => k.name === 'linefeed' ? keyFields({ ...k, name: 'j', ctrl: true }) : ({
  key:      DOM_KEY[k.name] ?? (k.sequence?.length === 1 && k.sequence >= ' ' ? k.sequence : k.name),
  code:     k.name,
  shiftKey: !!k.shift, ctrlKey: !!k.ctrl, altKey: !!(k.option || k.meta), metaKey: !!k.meta,
  raw:      k,
})

const ACTIVATE_KEYS = new Set(['return', 'enter', 'space'])
// Enter on a checkbox or a radio does nothing in a browser.
const CHECK_KEYS = new Set(['space'])

const disabled = (node) => 'disabled' in node.__attrs

/**
 * `onevent` on a terminal node. The listener goes into a list of the
 * runtime's own rather than onto the engine, which wires one key slot per
 * node and keeps no way to take a listener back off; `dispatch` reads the
 * list. `capture` and `once` are the DOM's listener options.
 */
export function on(node, event, handler, { capture = false, once = false } = {}) {
  if (!TERMINAL_EVENTS[event]) throw new Error(`[Mesa] on${event} has no terminal lowering`)
  // A kit forwards its caller's handler props, most of them unset; `addEvent`
  // skips those on the DOM path, and a stored `undefined` throws on the event.
  if (!handler) return
  ;((node.__listeners ??= {})[event] ??= []).push({ fn: handler, capture, once })
  // A dialog hears its backdrop's press (`enterTopLayer`) and is never a
  // control Tab stops at, which is what a click listener makes a box.
  if (event === 'click' && !(node instanceof DialogBox)) activatable(node)
  if (event === 'mousedown') pressSource(node)
  if (event === 'mousemove') moveSource(node)
  if (event === 'mouseenter' || event === 'mouseleave') hoverSource(node.ctx)
}

function fire(node, e, phase) {
  const list = node.__listeners?.[e.type]
  if (!list) return
  e.currentTarget = node
  for (const l of list.slice()) {
    if (phase === 'capture' && !l.capture) continue
    if (phase === 'bubble' && l.capture) continue
    if (l.once) list.splice(list.indexOf(l), 1)
    l.fn(e)
    if (e.__stopNow) return
  }
}

const KEY_EVENTS = new Set(['keydown', 'keypress'])

/**
 * Deliver `type` at `target` the way a browser does: capture listeners from
 * the root down, every listener on the target, then the bubble listeners back
 * up when the event bubbles. The path crosses component boundaries, since a
 * child's nodes sit under its caller's. Answers the event, so a source can see
 * whether its default was prevented.
 */
function dispatch(target, type, extra = {}) {
  const path = []
  for (let n = up(target); n; n = up(n)) path.push(n)
  const sideKey = KEY_EVENTS.has(type) && [target, ...path].some((n) => n.__pane === 'side')
  if (_renderer && !sideKey && (path.at(-1) ?? target) === _renderer.root) path.push(windowOf(_renderer))
  let stopped = false
  const e = {
    type, target, currentTarget: null, isTrusted: true, defaultPrevented: false,
    bubbles: TERMINAL_EVENTS[type].bubbles,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { stopped = true },
    stopImmediatePropagation() { stopped = true; this.__stopNow = true },
    ...extra,
  }
  for (let i = path.length - 1; i >= 0 && !stopped; i--) fire(path[i], e, 'capture')
  if (!stopped) { fire(target, e, 'capture'); if (!e.__stopNow) fire(target, e, 'bubble') }
  if (e.bubbles) for (let i = 0; i < path.length && !stopped; i++) fire(path[i], e, 'bubble')
  e.currentTarget = null
  return e
}

// ─── event sources ────────────────────────────────────────────────────
//
// What the engine reports, turned into DOM events at the node it happened
// to. Every focusable node is a source whether or not a listener is on it,
// because the listener may be on an ancestor.

/** Focus and blur, each followed by its bubbling twin, from a node that can
 *  hold focus; its keys arrive through `keys`. The engine blurs the node
 *  losing focus before it marks the next one focused, so the four arrive in
 *  a browser's order: `blur`, `focusout`, `focus`, `focusin`. */
function focusSource(node) {
  if (node.__focusSource) return
  node.__focusSource = true
  node.on('focused', () => {
    if (node.__still) return
    dispatch(node, 'focus')
    dispatch(node, 'focusin')
  })
  // `destroy` blurs a node it has already marked destroyed; a browser fires
  // nothing at an element removed while focused.
  node.on('blurred', () => {
    if (node.isDestroyed || node.__still) return
    dispatch(node, 'blur')
    dispatch(node, 'focusout')
  })
}

// ─── the keymaps ──────────────────────────────────────────────────────

const shells = new WeakMap()

/**
 * The keys the renderer's host takes after every keymap on the focus path and
 * before the keydown is made (sierra's terminal shell: Ctrl+P, `?`, the ways
 * into INSERT, and h j k l renamed to the arrows). `text()` answers false where
 * no field is a text context — the shell's NORMAL — and `step(e)` may prevent
 * the key or rename it by writing `e.raw.name` and `e.raw.sequence`, which the
 * keydown is then made from.
 */
export function setShellKeys(r, { text, step }) { shells.set(r, { text, step }) }

/** The keymaps active on the focus path, innermost first, as `?` lists them. */
export function keymapsAt(r, node = r.currentFocusedRenderable) {
  const out = []
  for (let n = node; n; n = up(n)) for (const host of n.__keymaps ?? []) out.push(...host.active())
  return out
}

/**
 * The keymaps a key meets before its keydown, the way Emacs reads its active
 * maps and CodeMirror its keymaps: each `keys()` host from the focused node
 * out, then the shell's. One event goes through all of them, so a key an inner
 * keymap took reaches an outer one prevented and clears what it had pending.
 * Answers whether the key was taken.
 */
function stepKeys(r, target, k, fields) {
  const shell = shells.get(r)
  const e = {
    ...fields, target, isComposing: false, defaultPrevented: false,
    typing: shell?.text() ?? true,
    composedPath: () => [target],
    preventDefault() { this.defaultPrevented = true },
  }
  for (let n = target; n && !n.__window; n = up(n)) for (const host of n.__keymaps ?? []) host.keydown(e)
  shell?.step(e)
  return e.defaultPrevented
}

/**
 * A key, as a browser delivers one: `keydown` at the focused node, or at the
 * window when nothing holds focus, then `keypress` for a key that types a
 * character, or Enter, with no Ctrl, Alt or Meta held. The keymaps are
 * stepped first (`stepKeys`), and a key one of them took is theirs, as a key
 * an Emacs keymap binds runs no other command: no keydown is made of it, so
 * a listener reading `defaultPrevented` as somebody else's NORMAL does not
 * act on it too. A prevented one is withheld from the engine, so a field
 * never types it. Then the key's default: Tab moves focus, Escape asks the
 * top modal dialog to close, a control's own keys (`__keyAction`) act, and
 * Enter or Space activates. Escape taken by a dialog is stopped there, so no
 * listener after this one — the shell going back a screen — hears it.
 */
function onKey(r, k) {
  // Taken by a listener the host put on before the first mount: a shell's key
  // that moves between panes is not the page's.
  if (k.defaultPrevented) return
  const focused = r.currentFocusedRenderable
  const target = focused?.__focusSource && !focused.isDestroyed ? focused : windowOf(r)
  if (stepKeys(r, target, k, keyFields(k))) { k.preventDefault(); return }
  const fields = keyFields(k)
  if (dispatch(target, 'keydown', fields).defaultPrevented) { k.preventDefault(); return }
  if (types(fields) && dispatch(target, 'keypress', fields).defaultPrevented) { k.preventDefault(); return }
  if (k.name === 'tab') { k.preventDefault(); k.shift ? focusPrev() : focusNext(); return }
  if (fields.key === 'Escape' && closeRequest(r)) { k.preventDefault(); k.stopPropagation(); return }
  if (k.name in PAGE_KEYS && !(target instanceof TextareaRenderable) && turnPage(r, PAGE_KEYS[k.name])) { k.preventDefault(); return }
  if (target.__window) return
  if (target.__keyAction?.(k.name)) { k.preventDefault(); return }
  if (!target.__activatable || target instanceof TextareaRenderable) return
  if (!(target instanceof CheckBox ? CHECK_KEYS : ACTIVATE_KEYS).has(k.name)) return
  // Space scrolls past a link in a browser and follows nothing.
  if (target.__link && k.name === 'space') return
  k.preventDefault()
  activate(target, fields)
}

const PASTED = new TextDecoder()

/** What a handler reads off `e.clipboardData`: the text, and no files. */
const clipboard = (text) => ({
  types: ['text/plain'],
  files: [],
  items: [{ kind: 'string', type: 'text/plain', getAsString: (cb) => cb(text), getAsFile: () => null }],
  getData: (type) => (type === 'text/plain' || type === 'text' ? text : ''),
})

/**
 * A bracketed paste, as a browser delivers one: `paste` at the focused node,
 * or at the window, before the field takes the text. A prevented one is
 * withheld from the field, which never types it.
 */
function onPaste(r, p) {
  if (p.defaultPrevented) return
  const focused = r.currentFocusedRenderable
  const target = focused?.__focusSource && !focused.isDestroyed ? focused : windowOf(r)
  const e = dispatch(target, 'paste', { clipboardData: clipboard(PASTED.decode(p.bytes)), raw: p })
  if (e.defaultPrevented) p.preventDefault()
}

const keyed = new WeakMap()

/** Take `r`'s keys and pastes through `onKey` and `onPaste`, once however
 *  many mounts share it; the answer lets one mount go. */
function keys(r) {
  let held = keyed.get(r)
  if (!held) {
    const listener = (k) => onKey(r, k)
    const pasted = (p) => onPaste(r, p)
    r.keyInput.on('keypress', listener)
    r.keyInput.on('paste', pasted)
    keyed.set(r, held = { count: 0, listener, pasted })
  }
  held.count++
  return () => {
    if (--held.count) return
    r.keyInput.off('keypress', held.listener)
    r.keyInput.off('paste', held.pasted)
    keyed.delete(r)
  }
}

// ─── the window ───────────────────────────────────────────────────────

const windows = new WeakMap()

/** The window of `r`: the last stop on every event's path, and where a key
 *  goes when nothing holds focus. */
function windowOf(r) {
  let w = windows.get(r)
  if (!w) windows.set(r, w = { __window: true, __tag: '#window', __listeners: {}, parent: null })
  return w
}

/** `<mesa:window onevent>`: a listener on the window, taken off when the
 *  component that wrote it is destroyed. */
export function onWindow(event, handler, { capture = false, once = false } = {}) {
  if (!TERMINAL_EVENTS[event]) throw new Error(`[Mesa] on${event} has no terminal lowering`)
  if (!handler) return
  const r = needRenderer('onWindow')
  if (event === 'mouseenter' || event === 'mouseleave') hoverSource(r)
  const list = (windowOf(r).__listeners[event] ??= [])
  const entry = { fn: handler, capture, once }
  list.push(entry)
  onCleanup(() => { const at = list.indexOf(entry); if (at >= 0) list.splice(at, 1) })
}

// ─── the document ─────────────────────────────────────────────────────

const documents = new WeakMap()

/**
 * The page of `r`, where `mount` puts a component: it scrolls, the wheel
 * through the engine and PageUp and PageDown through `onKey`, and a node
 * that takes focus is scrolled into view once a frame has laid it out —
 * before that it has no place, and a route focuses its first control as it
 * mounts — and again after the terminal is resized. The top layer is
 * beside it on the root, so a modal dialog stays where it is while the page
 * under it moves.
 */
function documentOf(r) {
  let doc = documents.get(r)
  if (doc && !doc.isDestroyed) return doc
  // The engine skips laying out what is outside the view, and a node it
  // skipped reports the place and height it had when last seen, or none.
  doc = new ScrollBoxRenderable(r, { width: '100%', height: '100%', viewportCulling: false })
  // Focused, the engine's box takes the arrow keys a field or a select is owed.
  doc.focusable = false
  r.root.add(doc)
  documents.set(r, doc)
  let focused = null
  r.on('focused_renderable', (node) => { focused = node })
  // A resize keeps the scroll where it was, so a terminal made shorter leaves
  // the field being typed in under the bottom edge until focus moves.
  r.on('resize', () => { focused = r.currentFocusedRenderable })
  r.addPostProcessFn(() => {
    const node = focused
    focused = null
    if (node && reveal(doc, node)) r.requestRender()
  })
  return doc
}

/**
 * The page: the box every mount without a `parent` goes in, and the pane a
 * side narrows. Its `resize` is the one to fit to — the renderer's misses
 * a side opening, and before the first layout its width reads 0.
 */
export const pageOf = (r) => documentOf(r)

const footers = new WeakMap()

/**
 * A strip under the page that does not scroll with it, for `mount(C, {
 * parent })` — a status line a long page would otherwise carry off screen.
 * Asked for, the page gives up the rows it takes.
 */
export function footerOf(r) {
  let foot = footers.get(r)
  if (foot && !foot.isDestroyed) return foot
  const doc = documentOf(r)
  doc.height = 'auto'
  doc.flexGrow = 1
  doc.flexShrink = 1
  foot = new BoxRenderable(r, { width: '100%', flexShrink: 0, flexDirection: 'column' })
  r.root.add(foot)
  footers.set(r, foot)
  return foot
}

const sides = new WeakMap()

/**
 * A pane at the right of the page, for `mount(C, { parent })`: the page and
 * the side are a row above the footer, and the page takes what the side
 * leaves. Hidden (`visible = false`), the side gives its columns back. A
 * rule down its left edge takes one of its columns, since two panes on one
 * background otherwise read as one screen.
 *
 * Each is a PANE. Tab and `focusNext` stay inside the pane holding focus, and
 * `focusPane` moves between them. A key at a node in the side does not reach
 * the window, where a page's scene walks on every key; focus events still do,
 * so a mode line follows focus across.
 */
export function sideOf(r, { width = '40%' } = {}) {
  let side = sides.get(r)
  if (side && !side.isDestroyed) return side
  const doc = documentOf(r)
  const row = new BoxRenderable(r, { width: '100%', flexGrow: 1, flexShrink: 1, flexDirection: 'row' })
  r.root.insertBefore(row, doc)
  row.add(doc)
  doc.width = 'auto'
  doc.height = '100%'
  doc.flexGrow = 1
  doc.flexShrink = 1
  side = new BoxRenderable(r, { width, height: '100%', flexShrink: 0, flexDirection: 'column', border: ['left'] })
  row.add(side)
  side.__pane = 'side'
  doc.__pane = 'page'
  sides.set(r, side)
  const last = { page: null, side: null }
  panes.set(r, last)
  r.on('focused_renderable', (node) => {
    const pane = node && paneOf(r, node)
    if (pane) last[pane] = node
  })
  return side
}

const toggles = new WeakMap()

/** How the side is shown and hidden, said by whoever fills it — the fill is
 *  theirs, mounted the first time it shows, so Mesa cannot show it alone. */
export function setSideToggle(r, fn) { toggles.set(r, fn) }

/** The side's show-and-hide, or null where nobody fills a side, so a page's
 *  command can be offered only where it works. */
export function sideToggle(r = _renderer) { return (r && toggles.get(r)) ?? null }

const panes = new WeakMap()

/** The pane `node` is in — `'page'` or `'side'` — or null where the renderer
 *  has no side; `node` is what holds focus when not given. */
export function paneOf(r, node = r.currentFocusedRenderable) {
  if (!panes.has(r)) return null
  for (let n = node; n; n = up(n)) if (n.__pane) return n.__pane
  return 'page'
}

/** Focus `pane`: the node last focused there, else its first control.
 *  Answers the node, or null when the pane holds nothing to focus. */
export function focusPane(r, pane) {
  const last = panes.get(r)
  if (!last) return null
  const box = pane === 'side' ? sides.get(r) : documentOf(r)
  const was = last[pane]
  const next = was && !was.isDestroyed && within(was, box) && focusables(box).includes(was) ? was : focusables(box)[0]
  next?.focus()
  return next ?? null
}

/** Where focus cycles: the top modal, else the pane holding focus. */
function cycleScope(r) {
  const modal = topModal(r)
  if (modal) return modal
  const pane = paneOf(r)
  if (!pane) return r.root
  return pane === 'side' ? sides.get(r) : documentOf(r)
}

/** `node` is in the page's flow: a modal dialog in the top layer is not,
 *  though `up` walks it home. */
const onPage = (node, doc) => {
  for (let n = node; n; n = n.parent) if (n === doc.content) return true
  return false
}

/** What paints `node`: itself, or the run a box hid it in. */
function drawn(node) {
  for (let n = node; n; n = n.parent) {
    if (!n.__merged) continue
    for (const run of n.parent.__runs.values()) if (run.__chunks.some((c) => within(c.from, n))) return run
    return n.parent
  }
  return node
}

/** Scroll `doc` the least that shows `node` whole, or to its top when it is
 *  taller than the page. Answers whether it moved. */
function reveal(doc, node) {
  if (node.isDestroyed || doc.isDestroyed || !onPage(node, doc)) return false
  const shown = drawn(node)
  const top = shown.y - doc.viewport.y
  const room = doc.viewport.height
  const by = top < 0 || shown.height > room ? top : Math.max(0, top + shown.height - room)
  const was = doc.scrollTop
  doc.scrollBy(by)
  return doc.scrollTop !== was
}

const PAGE_KEYS = { pageup: -1, pagedown: 1 }

/** PageUp or PageDown: the page moves by a screen less one row, so the row
 *  read last stays in sight. Not under a modal dialog, which holds the keys. */
function turnPage(r, step) {
  const doc = documents.get(r)
  if (!doc || doc.isDestroyed || topModal(r)) return false
  doc.scrollBy(step * Math.max(1, doc.viewport.height - 1))
  return true
}

// ─── the top layer ────────────────────────────────────────────────────

const layers = new WeakMap()
const topModal = (r) => layers.get(r)?.at(-1) ?? null

/** One step toward the root: from a dialog in the top layer, the place its
 *  component wrote it. */
const up = (n) => n.__home ? n.__home.parent : n.parent

const within = (node, ancestor) => {
  for (let n = node; n; n = up(n)) if (n === ancestor) return true
  return false
}

const connected = (node) => !!_renderer && within(node, _renderer.root)

/**
 * Lift `dialog` over the screen: a hidden box takes its place, and it goes
 * under a backdrop on the root that fills the screen, centers it, and dims
 * what is drawn before it. A press on the backdrop is a `click` at the dialog
 * itself, as a press on a browser's `::backdrop` is; nothing beneath hears
 * one. Destroying either the dialog or its place takes the other with it.
 */
function enterTopLayer(r, dialog) {
  const stack = layers.get(r) ?? []
  layers.set(r, stack)
  const home = new BoxRenderable(r, { visible: false })
  dialog.parent.insertBefore(home, dialog)
  dialog.parent.remove(dialog)
  const backdrop = new BoxRenderable(r, {
    position: 'absolute', left: 0, top: 0, width: '100%', height: '100%',
    zIndex: 1000 + stack.length, justifyContent: 'center', alignItems: 'center',
  })
  backdrop.renderBefore = function (buffer) {
    const bits = buffer.buffers.attributes
    for (let i = 0; i < bits.length; i++) bits[i] |= TextAttributes.DIM
  }
  backdrop.onMouseDown = (e) => {
    if (e.target !== backdrop) return
    e.preventDefault()
    const { fields } = pointer(dialog, e)
    dispatch(dialog, 'mousedown', fields)
    dispatch(dialog, 'click', fields)
  }
  backdrop.add(dialog)
  r.root.add(backdrop)
  dialog.__home = home
  dialog.__backdrop = backdrop
  dialog.__layer = stack
  stack.push(dialog)
  dialog.__onGone = () => leaveTopLayer(dialog)
  home.__onGone = () => { if (!dialog.isDestroyed) dialog.destroyRecursively() }
  dialog.on('destroyed', dialog.__onGone)
  home.on('destroyed', home.__onGone)
}

/** Put `dialog` back in its place, or, when the place is gone, nowhere. */
function leaveTopLayer(dialog) {
  const { __home: home, __backdrop: backdrop } = dialog
  if (!home) return
  dialog.__home = dialog.__backdrop = null
  dialog.off('destroyed', dialog.__onGone)
  home.off('destroyed', home.__onGone)
  const stack = dialog.__layer
  stack.splice(stack.indexOf(dialog), 1)
  if (!dialog.isDestroyed && !home.isDestroyed && home.parent) {
    backdrop.remove(dialog)
    home.parent.insertBefore(dialog, home)
  }
  if (!home.isDestroyed) home.destroy()
  if (!backdrop.isDestroyed) backdrop.destroy()
}

/** Escape with a modal dialog open: `cancel` at it, then `close()` unless
 *  that was prevented. Answers whether a dialog took the key. */
function closeRequest(r) {
  const dialog = topModal(r)
  if (!dialog) return false
  if (!dispatch(dialog, 'cancel').defaultPrevented) dialog.close()
  return true
}

const types = (f) => (f.key.length === 1 || f.key === 'Enter') && !f.ctrlKey && !f.altKey && !f.metaKey

/** A node that fires `click` on Enter, Space or a press: every button, and a
 *  box something listens to `click` on, which this makes focusable since a
 *  terminal has no other way to reach it. */
function activatable(node) {
  if (node.__activatable) return
  node.__activatable = true
  node.__canFocus = true
  node.focusable = !disabled(node)
  focusSource(node)
  pressSource(node)
}

/** A press, from a node that fires `click` or that something listens to
 *  `mousedown` on: `mousedown` at the element under the pointer, then focus
 *  to the nearest node above it that takes focus, then `click` at the nearest
 *  activatable one. Preventing `mousedown` keeps focus where it is, its
 *  default in a browser too, and the `click` still fires. The focus is moved
 *  here rather than left to the engine, which moves it after this handler
 *  returns: a click that opens a modal dialog focuses inside it, and the
 *  engine would then hand focus back to the button pressed. */
function pressSource(node) {
  if (node.__pressSource) return
  node.onMouseDown = node.__pressSource = (e) => {
    const { target, fields } = pointer(node, e)
    e.preventDefault()
    if (!dispatch(target, 'mousedown', fields).defaultPrevented) {
      for (let n = target; n; n = up(n)) if (n.focusable) { n.focus(); break }
    }
    for (let n = target; n; n = n.parent) if (n.__activatable) { activate(n, fields); return }
  }
}

/** `mousemove` at the element under the pointer, from a node something
 *  listens to it on. Only a move with no button held: the engine sends a drag
 *  to the node the press began on rather than the one under the pointer, so a
 *  drag sends none. */
function moveSource(node) {
  if (node.__moveSource) return
  node.onMouseMove = node.__moveSource = (e) => {
    const { target, fields } = pointer(node, e)
    dispatch(target, 'mousemove', fields)
  }
}

const hovered = new WeakMap()

/** `mouseenter` and `mouseleave`, from the renderer `r`. The engine sends
 *  `over` at whatever the pointer comes onto, a move, a drag, or a redraw that
 *  put something new under a still pointer, and it reaches the root
 *  whatever stopped the move itself; a run's cells are told apart on its own
 *  moves (`hoverTo` at the run). */
function hoverSource(r) {
  if (hovered.has(r)) return
  hovered.set(r, [])
  r.root.onMouseOver = (e) => hoverTo(r, e.target, e)
}

/** The pointer is over `renderable`: `mouseleave` at each element it went
 *  off, innermost first, then `mouseenter` at each it came onto, outermost
 *  first, as a browser orders them. An element removed while under the
 *  pointer hears nothing, as in a browser. */
function hoverTo(r, renderable, e) {
  const was = hovered.get(r)
  if (!was) return
  let at = renderable?.__proxy ? cellAt(renderable, e) ?? renderable : renderable
  const now = []
  for (; at && !at.__window; at = up(at)) if (at.__tag) now.push(at)
  if (now[0] === was[0]) return
  hovered.set(r, now)
  const fields = mouseFields(e)
  const stays = new Set(now)
  for (const n of was) if (!stays.has(n) && !n.isDestroyed) dispatch(n, 'mouseleave', { ...fields, relatedTarget: now[0] ?? null })
  const had = new Set(was)
  for (let i = now.length - 1; i >= 0; i--) if (!had.has(now[i])) dispatch(now[i], 'mouseenter', { ...fields, relatedTarget: was[0] ?? null })
}

/** The element a mouse event happened to, and its DOM fields. The engine
 *  sends one event through every ancestor's slot, and the first slot delivers
 *  for the whole path, so an ancestor that listens hears it once. On a run,
 *  the engine's target is the run and `relay` names the cell's node. */
function pointer(node, e) {
  e.stopPropagation()
  let target = e.__at ?? e.target
  while (target && !target.__tag) target = target.parent
  return { target: target ?? node, fields: mouseFields(e) }
}

const mouseFields = (e) => ({
  button: e.button ?? 0, shiftKey: !!e.modifiers?.shift, ctrlKey: !!e.modifiers?.ctrl,
  altKey: !!e.modifiers?.alt, metaKey: false, raw: e,
})

/** `click`, and then its default: a link is followed, a button submits its
 *  form. */
function activate(node, extra) {
  if (disabled(node)) return
  if (node instanceof CheckBox) { toggle(node, extra); return }
  if (dispatch(node, 'click', extra).defaultPrevented) return
  if (node.__link) { follow(node); return }
  if (node.__tag === 'summary') {
    const details = node.parent
    if (details instanceof DetailsBox && details.__summary === node) details.open = !details.open
    return
  }
  if (node.__tag !== 'button' || !submits(node)) return
  const form = formOf(node)
  if (form) dispatch(form, 'submit', { submitter: node })
}

/**
 * A check's activation, in HTML's order: the state moves BEFORE `click`, so a
 * handler reads the new `checked`; a prevented click puts it back, a radio's
 * group included, and sends nothing more; otherwise `input` then `change`,
 * unless a radio was checked already.
 */
function toggle(node, extra) {
  const was = radio(node) ? radioGroup(node).find((r) => r.checked) ?? null : node.checked
  node.checked = radio(node) || !node.checked
  if (dispatch(node, 'click', extra).defaultPrevented) {
    if (!radio(node)) node.checked = was
    else if (was) was.checked = true
    else node.checked = false
    return
  }
  if (was === node) return
  dispatch(node, 'input')
  dispatch(node, 'change')
}

// ─── links ────────────────────────────────────────────────────────────

const followers = new WeakMap()

/**
 * What following a link means on `renderer`: `fn(href)` is handed a link's
 * `href`, as written, when it is activated and its `click` was not
 * prevented. A terminal has no address of its own, so with no follower an
 * activated link goes nowhere, as one does in a page that cannot navigate.
 * Answers a function that takes it back off.
 *
 * @param {object} renderer
 * @param {(href: string) => void} fn
 */
export function followLinks(renderer, fn) {
  followers.set(renderer, fn)
  return () => { if (followers.get(renderer) === fn) followers.delete(renderer) }
}

/** An `<a>` with an `href` is a link: focusable, activated by Enter or a
 *  press, and inverted while focused, the frame's only focus cue for text.
 *  Without one it is text again, unless something listens to its `click`. */
function link(node, on) {
  node.__link = on
  announce(node)
  if (on) {
    activatable(node)
    invertWhileFocused(node)
    return
  }
  if (node.__listeners?.click?.length) return
  node.__activatable = false
  node.__canFocus = false
  node.focusable = false
  if (node.focused) node.blur()
}

/** Invert every text under `node` while it holds focus, the frame's only
 *  focus cue for a node with no brackets: a link, a summary. */
function invertWhileFocused(node) {
  if (node.__textCue) return
  node.__textCue = true
  let held = null
  node.on('focused', () => {
    held = descendants(node, (n) => n instanceof TextRenderable && !n.__proxy).map((t) => [t, t.attributes])
    for (const [t, bits] of held) t.attributes = bits | TextAttributes.INVERSE
  })
  node.on('blurred', () => {
    for (const [t, bits] of held ?? []) if (!t.isDestroyed) t.attributes = bits
    held = null
  })
}

/** A link with a `target` or a `download` is not followed in the page, in
 *  a browser either. */
function follow(node) {
  const { href, target, download } = node.__attrs
  if (href == null || target != null || download != null) return
  followers.get(_renderer)?.(String(href))
}

/** A `<button>` with no `type` is a submit button, as in HTML. */
const submits = (node) => String(node.__attrs.type ?? 'submit').toLowerCase() === 'submit'

function formOf(node) {
  for (let n = up(node); n; n = up(n)) if (n.__tag === 'form') return n
  return null
}

function descendants(node, pick, out = []) {
  for (const c of node.getChildren?.() ?? []) {
    if (pick(c)) out.push(c)
    descendants(c, pick, out)
  }
  return out
}

/** `input`, `change` and Enter from a text field. */
function inputSource(node) {
  node.on('input', () => { if (!node.__muted) dispatch(node, 'input') })
  node.on('change', () => dispatch(node, 'change'))
  node.on('enter', () => implicitSubmit(node))
}

/**
 * Enter in a single-line field submits its form by HTML's rule: through the
 * form's first submit button when it has one, which a disabled button blocks,
 * and otherwise only when the field is the form's one field.
 */
function implicitSubmit(field) {
  const form = formOf(field)
  if (!form) return
  const [button] = descendants(form, (n) => n.__tag === 'button' && submits(n))
  if (button) { activate(button, {}); return }
  if (descendants(form, (n) => n instanceof Field).length === 1) dispatch(form, 'submit', { submitter: null })
}

/**
 * `bind:value` on a control: `get` written as the value from an effect, and
 * the control's value handed to `set` on each `input` and `change`, as the
 * DOM path's `bindInput` does. A select's value is its chosen option's,
 * unstringified, or null when none is; a bound value no option equals
 * chooses none. A number or range input reads back a number, and `undefined`
 * for an empty or half-typed box (`FJS-857`).
 */
export function bind(node, name, get, set, value) {
  if (node instanceof CheckBox ? name === 'value' : name !== 'value' || !(node instanceof SelectBox || node instanceof TextareaRenderable)) {
    const type = node.__kind ? ` type="${node.__type ?? 'text'}"` : ''
    throw new Error(`[Mesa] bind:${name} on <${node.__tag}${type}> has no terminal lowering`)
  }
  if (node instanceof CheckBox) { bindCheck(node, name, get, set, value); return }
  const read = () => {
    if (node instanceof SelectBox) { const o = chosen(node); return o ? optionValue(o) : null }
    const type = node.__attrs.type
    if (type !== 'number' && type !== 'range') return node.value
    const n = Number(node.value)
    return node.value.trim() === '' || Number.isNaN(n) ? undefined : n
  }
  const handler = () => set(read())
  on(node, 'input', handler)
  on(node, 'change', handler)
  createEffect(() => {
    const v = get()
    if (node instanceof SelectBox) node.__wanted = v
    else set_attribute(node, 'value', v ?? '')
  })
}

/**
 * `bind:checked` and `bind:group` on a check, as the DOM path's `bind` and
 * `bindGroup` do: `checked` is the state, and a group is the array of the
 * checked boxes' values, or the one checked radio's value.
 */
function bindCheck(node, name, get, set, value) {
  if (name === 'checked') {
    on(node, 'change', () => set(node.checked))
    createEffect(() => { node.checked = !!get() })
    return
  }
  on(node, 'change', () => {
    const v = value()
    if (radio(node)) { if (node.checked) set(v); return }
    const all = get() ?? []
    if (node.checked) { if (!all.includes(v)) set([...all, v]) }
    else set(all.filter((x) => x !== v))
  })
  createEffect(() => {
    const v = value()
    const now = get()
    node.checked = radio(node) ? now === v : Array.isArray(now) && now.includes(v)
  })
}

// ─── blocks ───────────────────────────────────────────────────────────

/** Run `factory` in its own root, place what it returns before `marker`, and
 *  take it all out when the root is disposed. The cleanup is registered on the
 *  ROOT, never on the enclosing effect: an effect runs its cleanups on every
 *  re-run, which would tear the content down each time the selector was
 *  merely re-evaluated. */
function mountBlock(marker, factory) {
  return createRoot((dispose) => {
    const nodes = toNodes(factory())
    for (const n of nodes) placeBefore(marker, n)
    onCleanup(() => { for (const n of nodes) detach(n) })
    return dispose
  })
}

// A branch, a keyed block and a row are built later than the component that
// declares them, inside an effect, so each reinstates the `$context` stack
// captured where it is written: a DropdownItem behind `{#if open}` read no
// `close` and choosing it never closed the menu.
export function ifBlock(marker, selectFn, blocks) {
  const withContext = captureContext()
  let current = null, dispose = null
  createEffect(() => {
    const index = selectFn()
    if (index === current) return
    current = index
    if (dispose) { dispose(); dispose = null }
    if (index == null) return
    dispose = mountBlock(marker, () => withContext(blocks[index]))
  })
}

/** Build `factory(key)` before `marker`, and rebuild it whenever `keyFn`
 *  answers a different key — `{#key}`, and `<mesa:element this>`, whose
 *  tag is the key. */
export function keyBlock(marker, keyFn, factory) {
  const withContext = captureContext()
  let current, dispose = null
  createEffect(() => {
    const key = keyFn()
    if (dispose && key === current) return
    current = key
    if (dispose) dispose()
    dispose = mountBlock(marker, () => withContext(() => factory(key)))
  })
}

export function eachBlock(marker, getItems, keyFn, rowFn, elseFn) {
  const withContext = captureContext()
  const rows = new Map()
  let elseDispose = null
  let warned = false
  createEffect(() => {
    const items = eachItems(getItems())
    const keys = []
    const seen = new Set()
    for (let i = 0; i < items.length; i++) {
      let key = keyFn ? keyFn(items[i], i) : i
      if (seen.has(key)) {
        if (!warned) {
          warned = true
          console.warn(`[Mesa] {#each} key ${String(key)} repeats; the repeat is keyed by its index`)
        }
        key = `\u0000dup:${i}`
      }
      seen.add(key)
      keys.push(key)
    }
    for (const [key, row] of rows) if (!seen.has(key)) { row.dispose(); rows.delete(key) }
    keys.forEach((key, i) => {
      const row = rows.get(key)
      if (row) { row.setItem(items[i]); row.setIndex(i); return }
      const [getItem, setItem] = createSignal(items[i])
      const [getIndex, setIndex] = createSignal(i)
      const made = { nodes: [], dispose: null, setItem, setIndex }
      made.dispose = createRoot((dispose) => {
        made.nodes = toNodes(withContext(() => rowFn(getItem, getIndex)))
        onCleanup(() => { for (const n of made.nodes) detach(n) })
        return dispose
      })
      rows.set(key, made)
    })
    // Every node in the new order lands before the marker in turn, so the
    // sequence ends in order whether a row moved, arrived or stayed.
    for (const key of keys) for (const n of rows.get(key).nodes) placeBefore(marker, n)
    if (items.length === 0) {
      if (elseFn && !elseDispose) elseDispose = mountBlock(marker, () => withContext(elseFn))
    } else if (elseDispose) {
      elseDispose()
      elseDispose = null
    }
  })
}

// ─── focus ────────────────────────────────────────────────────────────

// A node a run paints is hidden from layout and is still where Tab stops.
function focusables(node, out = []) {
  if (!node || node.__marker || (node.visible === false && !node.__merged)) return out
  if (node.focusable) out.push(node)
  if (typeof node.getChildren === 'function') for (const c of node.getChildren()) focusables(c, out)
  return out
}

function cycle(step) {
  const r = needRenderer('focusNext')
  const list = focusables(cycleScope(r))
  if (!list.length) return null
  const at = list.indexOf(r.currentFocusedRenderable)
  const next = list[(at + step + list.length) % list.length]
  next.focus()
  return next
}

export function focusNext() { return cycle(1) }
export function focusPrev() { return cycle(-1) }

// ─── measure and focus ────────────────────────────────────────────────

// `$.measure`, `$.viewport` and `$.focus` on a terminal, in the shape
// `runtime.js` gives the DOM's. A box has no place until a frame lays it out, and one mounted this
// tick still reports zero, so the answer waits for the next frame.

/** The cells `node` occupies on screen, as `{ left, top, right, bottom,
 *  width, height }`. No node answers `null`. */
export function measure(node) {
  if (!node) return Promise.resolve(null)
  const r = needRenderer('measure')
  return new Promise((resolve) => {
    const read = () => {
      r.removePostProcessFn(read)
      const left = node.screenX
      const top = node.screenY
      resolve({ left, top, right: left + node.width, bottom: top + node.height, width: node.width, height: node.height })
    }
    r.addPostProcessFn(read)
    r.requestRender()
  })
}

/** The renderer's area, as `{ width, height }` in cells. */
export function viewport() {
  const r = needRenderer('viewport')
  return Promise.resolve({ width: r.width, height: r.height })
}

/** Move focus to `node`. No node does nothing. */
export function focus(node) {
  node?.focus()
  return Promise.resolve()
}

// ─── renderers ────────────────────────────────────────────────────────

/** The engine's renderer on this process's TTY, for `mount`. A caller outside
 *  this package takes it from here: importing the engine itself from another
 *  package's directory installs a second copy, and two copies fail
 *  `instanceof` inside the engine's own `remove()`. */
export function createRenderer(options = {}) {
  return core.createCliRenderer(options)
}

/** A headless renderer of `width` x `height` cells: `{ renderer, renderOnce,
 *  captureCharFrame, mockInput }`, for printing or asserting a frame without
 *  a TTY. */
export async function createHeadlessRenderer({ width = 80, height = 24 } = {}) {
  const { createTestRenderer } = await import('@opentui/core/testing')
  return createTestRenderer({ width, height })
}

// ─── mount ────────────────────────────────────────────────────────────

export function mount(Component, { renderer, props = {}, parent = null } = {}) {
  if (!renderer) throw new Error('[Mesa] $$host.mount() needs a renderer')
  parent ??= documentOf(renderer)
  _renderer = renderer
  const before = new Set(parent.getChildren())
  const release = keys(renderer)
  let disposeRoot = () => {}
  try {
    createRoot((dispose) => {
      disposeRoot = dispose
      Component(parent, props)
    })
  } catch (e) {
    release()
    disposeRoot()
    throw e
  }
  return {
    renderer,
    parent,
    dispose() {
      disposeRoot()
      release()
      for (const c of parent.getChildren()) if (!before.has(c)) c.destroyRecursively()
    },
  }
}
