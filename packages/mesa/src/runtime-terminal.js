/**
 * The terminal runtime — `$$tui`, what a component compiled with
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
 *   background is a color. A modal dialog blanks its own cells instead, and
 *   the backdrop sets the dim bit on everything drawn before it.
 */
import { createRoot, createEffect, createSignal, onCleanup, eachItems, setRenderEnvironment, captureContext } from './runtime.js'
import { missingPeer } from './optional-peer.js'
import { TERMINAL_TAGS, TERMINAL_EVENTS, isInline } from './terminal/tags.js'
import { htmlEntitiesToText } from './entities.js'

// A terminal is a running client with no DOM: `$.onMount` runs and a watch is
// live, where `runtime.js` left to itself takes a process with no `document`
// for a server render and makes both no-ops. Set as this module loads, which
// is before any component that imports it evaluates.
setRenderEnvironment(false, true)

const core = await import('@opentui/core').catch(missingPeer('@opentui/core', 'the terminal target'))
const { BoxRenderable, TextRenderable, InputRenderable, TextareaRenderable, TextAttributes, RGBA, StyledText } = core

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
    if (!this.__home) return
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) buffer.setCell(this.screenX + x, this.screenY + y, ' ', CLEAR, CLEAR, 0)
    }
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

const CLEAR = RGBA.fromValues(0, 0, 0, 0)

// ─── the current renderer ─────────────────────────────────────────────

let _renderer = null

function needRenderer(what) {
  if (!_renderer) throw new Error(`[Mesa] $$tui.${what}() before mount(): no renderer is current`)
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
  node.__fragment = null
  inherit(node, parent.__bits)
  const anchor = before ?? parent.__tail ?? null
  anchor ? parent.insertBefore(node, anchor) : parent.add(node)
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
  node.destroyRecursively()
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
      node = new (spec.row || spec.hidden ? BoxRenderable : FlowBox)(r, {
        flexDirection: spec.row || spec.inline ? 'row' : 'column',
        ...(spec.indent && { paddingLeft: spec.indent }),
        // flexBasis 0 is what makes the share equal: an auto basis starts each
        // cell at its content's width, and the columns drift row to row.
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
    case 'dialog':
      node = new DialogBox(r, {
        flexDirection: 'column', border: true, paddingLeft: 1, paddingRight: 1,
        maxWidth: '100%', maxHeight: '100%', overflow: 'hidden', visible: false,
      })
      break
    case 'input':
      // A browser's text field is 20 characters wide unless `size` says
      // otherwise; with no width of its own, a field beside its label in a
      // row shrinks to one cell.
      node = new InputRenderable(r, { minWidth: 20 })
      break
    case 'textarea':
      node = new FieldArea(r, {})
      break
    default:
      throw new Error(`[Mesa] <${tag}> has terminal role '${spec.role}', which this runtime does not build`)
  }
  node.__tag = tag
  node.__bits = bits
  node.__attrs = {}
  const field = spec.role === 'input' || spec.role === 'textarea'
  node.__canFocus = spec.role === 'button' || spec.role === 'select' || field
  // A handler written for the DOM reads `e.target.name`, and the engine has
  // no `name` of its own; `value` it already has on a field.
  Object.defineProperty(node, 'name', { get: () => node.__attrs.name, configurable: true })
  // A click-away handler asks whether the click landed inside it. Inclusive,
  // as the DOM's is, and through `up`, so a lifted dialog is still inside the
  // component that wrote it.
  node.contains = (other) => { for (let n = other; n; n = up(n)) if (n === node) return true; return false }
  if (field) inputSource(node)
  if (spec.role === 'button') activatable(node)
  else if (node.__canFocus) focusSource(node)
  for (const name in attrs) set_attribute(node, name, attrs[name])
  return node
}

/**
 * The one owner of an attribute on a terminal node, static or live: the
 * emitter hands a static attribute to `element()`, which routes it here, and
 * a live one arrives from a render effect. `null` and `false` remove, as on
 * the DOM path; a name with no terminal meaning (`class`, `aria-*`) is kept
 * on `__attrs` and paints nothing. An `href` makes an `<a>` a link (`link`).
 *
 * `value` is the control's current text, the way the DOM property is: the
 * engine emits `input` when its value is written, which a DOM program write
 * never does, so the write is muted.
 */
export function set_attribute(node, name, value) {
  const present = value != null && value !== false
  if (present) node.__attrs[name] = value
  else delete node.__attrs[name]
  if (node instanceof TextareaRenderable) {
    if (name === 'value') {
      node.__muted = true
      try { node.value = present ? String(value) : '' } finally { node.__muted = false }
      return
    }
    if (name === 'placeholder') { node.placeholder = present ? String(value) : ''; return }
  }
  if (node instanceof SelectBox) {
    if (name === 'multiple' && present) throw new Error('[Mesa] <select multiple> has no terminal lowering')
    // The DOM path writes an absent value as `el.value = ''`, which chooses
    // the option whose value is empty.
    if (name === 'value') { node.__wanted = present ? value : ''; return }
  }
  if (name === 'alt' && node.__tag === 'img') {
    const str = present ? String(value) : ''
    set_text(node.__label, str)
    node.visible = str !== ''
    return
  }
  if (node instanceof ProgressBar && (name === 'value' || name === 'max')) { node.draw(); return }
  if (node instanceof DialogBox && name === 'open') {
    node.visible = present
    if (!present && node.__home) leaveTopLayer(node)
    return
  }
  if (name === 'href' && node.__tag === 'a') { link(node, present); return }
  if (name === 'size' && node.__tag === 'input') { node.minWidth = parseInt(value, 10) > 0 ? parseInt(value, 10) : 20; return }
  if (name === 'disabled') {
    // A disabled control takes no focus and no activation, and gives up the
    // focus it holds, as a browser's does.
    node.focusable = node.__canFocus && !present
    if (present && node.focused) node.blur()
  }
}

/**
 * `{...expr}` on an element: each key goes where the same key written in the
 * source would — a value to `set_attribute`, a function under `on<event>` to
 * that event's handler — and a key the object stops carrying is removed, as
 * `spreadAttributes` does on the DOM path. A spread's keys come from data, so
 * none of them is refused: one with no terminal meaning (`onmouseenter`,
 * `style`, a function under any other name) is inert, as an inert attribute
 * is.
 *
 * A handler is wired once per event, through a slot the spread rewrites, so
 * a replaced spread object does not stack a second handler on the first.
 */
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
  if (str !== node.__t) { node.__t = str; node.content = str }
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
      t.onMouseMove = (e) => relay(t, box, e, '__moveSource')
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

const keyFields = (k) => ({
  key:      DOM_KEY[k.name] ?? (k.sequence?.length === 1 ? k.sequence : k.name),
  code:     k.name,
  shiftKey: !!k.shift, ctrlKey: !!k.ctrl, altKey: !!(k.option || k.meta), metaKey: !!k.meta,
  raw:      k,
})

const ACTIVATE_KEYS = new Set(['return', 'enter', 'space'])

const disabled = (node) => 'disabled' in node.__attrs

/**
 * `on:event` on a terminal node. The listener goes into a list of the
 * runtime's own rather than onto the engine, which wires one key slot per
 * node and keeps no way to take a listener back off; `dispatch` reads the
 * list. `capture` and `once` are the DOM's listener options.
 */
export function on(node, event, handler, { capture = false, once = false } = {}) {
  if (!TERMINAL_EVENTS[event]) throw new Error(`[Mesa] on:${event} has no terminal lowering`)
  // A kit forwards its caller's handler props, most of them unset; `addEvent`
  // skips those on the DOM path, and a stored `undefined` throws on the event.
  if (!handler) return
  ;((node.__listeners ??= {})[event] ??= []).push({ fn: handler, capture, once })
  // A dialog hears its backdrop's press (`enterTopLayer`) and is never a
  // control Tab stops at, which is what a click listener makes a box.
  if (event === 'click' && !(node instanceof DialogBox)) activatable(node)
  if (event === 'mousedown') pressSource(node)
  if (event === 'mousemove') moveSource(node)
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
  if (_renderer && (path.at(-1) ?? target) === _renderer.root) path.push(windowOf(_renderer))
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

/**
 * A key, as a browser delivers one: `keydown` at the focused node, or at the
 * window when nothing holds focus, then `keypress` for a key that types a
 * character, or Enter, with no Ctrl, Alt or Meta held. A prevented one is
 * withheld from the engine, so a field never types it. Then the key's
 * default: Tab moves focus, Escape asks the top modal dialog to close, a
 * control's own keys (`__keyAction`) act, and Enter or Space activates.
 * Escape taken by a dialog is stopped there, so no listener after this one —
 * the shell going back a screen — hears it.
 */
function onKey(r, k) {
  const focused = r.currentFocusedRenderable
  const target = focused?.__focusSource && !focused.isDestroyed ? focused : windowOf(r)
  const fields = keyFields(k)
  if (dispatch(target, 'keydown', fields).defaultPrevented) { k.preventDefault(); return }
  if (types(fields) && dispatch(target, 'keypress', fields).defaultPrevented) { k.preventDefault(); return }
  if (k.name === 'tab') { k.preventDefault(); k.shift ? focusPrev() : focusNext(); return }
  if (fields.key === 'Escape' && closeRequest(r)) { k.preventDefault(); k.stopPropagation(); return }
  if (target.__window) return
  if (target.__keyAction?.(k.name)) { k.preventDefault(); return }
  if (!target.__activatable || target instanceof TextareaRenderable || !ACTIVATE_KEYS.has(k.name)) return
  // Space scrolls past a link in a browser and follows nothing.
  if (target.__link && k.name === 'space') return
  k.preventDefault()
  activate(target, fields)
}

const keyed = new WeakMap()

/** Take `r`'s keys through `onKey`, once however many mounts share it; the
 *  answer lets one mount go. */
function keys(r) {
  let held = keyed.get(r)
  if (!held) {
    const listener = (k) => onKey(r, k)
    r.keyInput.on('keypress', listener)
    keyed.set(r, held = { count: 0, listener })
  }
  held.count++
  return () => {
    if (--held.count) return
    r.keyInput.off('keypress', held.listener)
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

/** `<mesa:window on:event>`: a listener on the window, taken off when the
 *  component that wrote it is destroyed. */
export function onWindow(event, handler, { capture = false, once = false } = {}) {
  if (!TERMINAL_EVENTS[event]) throw new Error(`[Mesa] on:${event} has no terminal lowering`)
  if (!handler) return
  const list = (windowOf(needRenderer('onWindow')).__listeners[event] ??= [])
  const entry = { fn: handler, capture, once }
  list.push(entry)
  onCleanup(() => { const at = list.indexOf(entry); if (at >= 0) list.splice(at, 1) })
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

/** The element a mouse event happened to, and its DOM fields. The engine
 *  sends one event through every ancestor's slot, and the first slot delivers
 *  for the whole path, so an ancestor that listens hears it once. On a run,
 *  the engine's target is the run and `relay` names the cell's node. */
function pointer(node, e) {
  e.stopPropagation()
  let target = e.__at ?? e.target
  while (target && !target.__tag) target = target.parent
  return {
    target: target ?? node,
    fields: {
      button: e.button ?? 0, shiftKey: !!e.modifiers?.shift, ctrlKey: !!e.modifiers?.ctrl,
      altKey: !!e.modifiers?.alt, metaKey: false, raw: e,
    },
  }
}

/** `click`, and then its default: a link is followed, a button submits its
 *  form. */
function activate(node, extra) {
  if (disabled(node)) return
  if (dispatch(node, 'click', extra).defaultPrevented) return
  if (node.__link) { follow(node); return }
  if (node.__tag !== 'button' || !submits(node)) return
  const form = formOf(node)
  if (form) dispatch(form, 'submit', { submitter: node })
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
  if (on) {
    activatable(node)
    if (!node.__linkCue) {
      node.__linkCue = true
      let held = null
      node.on('focused', () => {
        held = descendants(node, (n) => n instanceof TextRenderable).map((t) => [t, t.attributes])
        for (const [t, bits] of held) t.attributes = bits | TextAttributes.INVERSE
      })
      node.on('blurred', () => {
        for (const [t, bits] of held ?? []) if (!t.isDestroyed) t.attributes = bits
        held = null
      })
    }
    return
  }
  if (node.__listeners?.click?.length) return
  node.__activatable = false
  node.__canFocus = false
  node.focusable = false
  if (node.focused) node.blur()
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
  if (descendants(form, (n) => n.__tag === 'input').length === 1) dispatch(form, 'submit', { submitter: null })
}

/**
 * `bind:value` on a control: `get` written as the value from an effect, and
 * the control's value handed to `set` on each `input` and `change`, as the
 * DOM path's `bindInput` does. A select's value is its chosen option's,
 * unstringified, or null when none is; a bound value no option equals
 * chooses none. A number or range input reads back a number, and `undefined`
 * for an empty or half-typed box (`FJS-857`).
 */
export function bind(node, name, get, set) {
  if (name !== 'value' || !(node instanceof SelectBox || node instanceof TextareaRenderable)) {
    throw new Error(`[Mesa] bind:${name} on <${node.__tag}> has no terminal lowering`)
  }
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
 *  answers a different key — `<mesa:element this>`, whose tag is the key. */
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

/** `<slot>`: the caller's block for this name, or the fallback when the
 *  caller passed none. Either is a factory returning a fragment, built once —
 *  which slots a caller passed is fixed by its markup. */
export function slot(marker, block, fallback) {
  const factory = block ?? fallback
  if (factory) mountBlock(marker, factory)
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
  const list = focusables(topModal(r) ?? r.root)
  if (!list.length) return null
  const at = list.indexOf(r.currentFocusedRenderable)
  const next = list[(at + step + list.length) % list.length]
  next.focus()
  return next
}

export function focusNext() { return cycle(1) }
export function focusPrev() { return cycle(-1) }

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

export function mount(Component, { renderer, props = {}, parent = renderer.root } = {}) {
  if (!renderer) throw new Error('[Mesa] $$tui.mount() needs a renderer')
  _renderer = renderer
  const before = new Set(parent.getChildren())
  const release = keys(renderer)
  let disposeRoot = () => {}
  try {
    createRoot((dispose) => {
      disposeRoot = dispose
      Component(parent, props, null)
    })
  } catch (e) {
    release()
    disposeRoot()
    throw e
  }
  return {
    renderer,
    dispose() {
      disposeRoot()
      release()
      for (const c of parent.getChildren()) if (!before.has(c)) c.destroyRecursively()
    },
  }
}
