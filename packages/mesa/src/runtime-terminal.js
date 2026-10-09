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
 * - Text attributes (`bold`, `italic`, `dim`, `underline` in the tag table)
 *   are cell attributes on a TextRenderable, so a box carries its bits and
 *   stamps every text that lands under it, through boxes appended later.
 * - A button paints as `[ label ]` on one row rather than a bordered box: a
 *   bordered box fills the parent's width and three rows, which in a 40x12
 *   frame is a quarter of the screen per button.
 * - Writing an input's `value` makes the engine emit `input`, which a DOM
 *   program write never does, so `set_attribute` mutes the handler for the
 *   duration of the write. Without the mute, a handler that logs or
 *   validates runs on every render.
 * - Key dispatch runs the renderer's global listeners before the focused
 *   renderable's, and `preventDefault` on the global stops the focused one
 *   seeing it — which is how Tab cycles focus without typing a tab into an
 *   input.
 */
import { createRoot, createEffect, createSignal, onCleanup, eachItems, setRenderEnvironment } from './runtime.js'
import { missingPeer } from './optional-peer.js'
import { TERMINAL_TAGS, TERMINAL_EVENTS } from './terminal/tags.js'

// A terminal is a running client with no DOM: `$.onMount` runs and a watch is
// live, where `runtime.js` left to itself takes a process with no `document`
// for a server render and makes both no-ops. Set as this module loads, which
// is before any component that imports it evaluates.
setRenderEnvironment(false, true)

const core = await import('@opentui/core').catch(missingPeer('@opentui/core', 'the terminal target'))
const { BoxRenderable, TextRenderable, InputRenderable, TextAttributes } = core

// ─── the current renderer ─────────────────────────────────────────────

let _renderer = null

function needRenderer(what) {
  if (!_renderer) throw new Error(`[Mesa] $$tui.${what}() before mount(): no renderer is current`)
  return _renderer
}

// ─── attributes ───────────────────────────────────────────────────────

const BITS = { bold: 'BOLD', italic: 'ITALIC', dim: 'DIM', underline: 'UNDERLINE' }

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
      node = new BoxRenderable(r, {
        flexDirection: spec.inline ? 'row' : 'column',
        ...(spec.indent && { paddingLeft: spec.indent }),
        // flexBasis 0 is what makes the share equal: an auto basis starts each
        // cell at its content's width, and the columns drift row to row.
        ...(spec.cell && { flexGrow: 1, flexBasis: 0, paddingRight: 1 }),
      })
      break
    case 'rule':
      node = new BoxRenderable(r, { border: ['top'], height: 1 })
      break
    case 'button': {
      node = new BoxRenderable(r, { flexDirection: 'row', focusable: true })
      const open = text('[ ')
      const tail = text(' ]')
      node.add(open)
      node.add(tail)
      node.__tail = tail
      // The frame has no other focus cue for a button: the brackets invert
      // while it is focused, and the characters never change. `destroy` blurs
      // a focused node after its children are already gone, so the blur
      // listener must not write into a freed text buffer.
      const cue = (bits) => { if (!open.isDestroyed) open.attributes = tail.attributes = bits }
      node.on('focused', () => cue(TextAttributes.INVERSE))
      node.on('blurred', () => cue(TextAttributes.NONE))
      break
    }
    case 'input':
      node = new InputRenderable(r, {})
      break
    default:
      throw new Error(`[Mesa] <${tag}> has terminal role '${spec.role}', which this runtime does not build`)
  }
  node.__tag = tag
  node.__bits = bits
  node.__attrs = {}
  node.__canFocus = spec.role === 'button' || spec.role === 'input'
  // A handler written for the DOM reads `e.target.name`, and the engine has
  // no `name` of its own; `value` it already has on an input.
  Object.defineProperty(node, 'name', { get: () => node.__attrs.name, configurable: true })
  if (spec.role === 'input') inputSource(node)
  if (spec.role === 'button') activatable(node)
  else if (node.__canFocus) focusSource(node)
  for (const name in attrs) set_attribute(node, name, attrs[name])
  return node
}

/**
 * The one owner of an attribute on a terminal node, static or live: the
 * emitter hands a static attribute to `element()`, which routes it here, and
 * a live one arrives from a render effect. `null` and `false` remove, as on
 * the DOM path; a name with no terminal meaning (`class`, `href`, `aria-*`)
 * is kept on `__attrs` and paints nothing.
 *
 * `value` is the control's current text, the way the DOM property is: the
 * engine emits `input` when its value is written, which a DOM program write
 * never does, so the write is muted.
 */
export function set_attribute(node, name, value) {
  const present = value != null && value !== false
  if (present) node.__attrs[name] = value
  else delete node.__attrs[name]
  if (node instanceof InputRenderable) {
    if (name === 'value') {
      node.__muted = true
      try { node.value = present ? String(value) : '' } finally { node.__muted = false }
      return
    }
    if (name === 'placeholder') { node.placeholder = present ? String(value) : ''; return }
  }
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

export function set_text(node, value) {
  const str = value == null ? '' : String(value)
  if (str !== node.__t) { node.__t = str; node.content = str }
}

export function marker() {
  const m = new BoxRenderable(needRenderer('marker'), { visible: false })
  m.__marker = true
  return m
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
  if (event === 'click') activatable(node)
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
  for (let n = target.parent; n; n = n.parent) path.push(n)
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

/** Focus, blur and keys, from a node that can hold focus. A key whose
 *  `keydown` was prevented is withheld from the engine, as a prevented key is
 *  never typed in a browser, and so is one whose `keypress` was: that event
 *  follows an unprevented `keydown` for a key that types a character, or
 *  Enter, with no Ctrl, Alt or Meta held. */
function focusSource(node) {
  if (node.__focusSource) return
  node.__focusSource = true
  node.on('focused', () => dispatch(node, 'focus'))
  // `destroy` blurs a node it has already marked destroyed; a browser fires
  // nothing at an element removed while focused.
  node.on('blurred', () => { if (!node.isDestroyed) dispatch(node, 'blur') })
  node.onKeyDown = (k) => {
    const fields = keyFields(k)
    if (dispatch(node, 'keydown', fields).defaultPrevented) { k.preventDefault(); return }
    if (types(fields) && dispatch(node, 'keypress', fields).defaultPrevented) { k.preventDefault(); return }
    if (!node.__activatable || node instanceof InputRenderable || !ACTIVATE_KEYS.has(k.name)) return
    k.preventDefault()
    activate(node, fields)
  }
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
  node.onMouseDown = (e) => {
    // The engine bubbles a press through every ancestor's slot; `dispatch`
    // carries the click up instead, so an activatable ancestor hears it once.
    e.stopPropagation()
    activate(node, { button: 0, raw: e })
  }
}

/** `click`, and then a button's default: submitting its form. */
function activate(node, extra) {
  if (disabled(node)) return
  if (dispatch(node, 'click', extra).defaultPrevented) return
  if (node.__tag !== 'button' || !submits(node)) return
  const form = formOf(node)
  if (form) dispatch(form, 'submit', { submitter: node })
}

/** A `<button>` with no `type` is a submit button, as in HTML. */
const submits = (node) => String(node.__attrs.type ?? 'submit').toLowerCase() === 'submit'

function formOf(node) {
  for (let n = node.parent; n; n = n.parent) if (n.__tag === 'form') return n
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
 * and otherwise only when the field is the form's one field. A `<textarea>`
 * never submits, since Enter there is a new line.
 */
function implicitSubmit(field) {
  if (field.__tag !== 'input') return
  const form = formOf(field)
  if (!form) return
  const [button] = descendants(form, (n) => n.__tag === 'button' && submits(n))
  if (button) { activate(button, {}); return }
  if (descendants(form, (n) => n.__tag === 'input').length === 1) dispatch(form, 'submit', { submitter: null })
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

export function ifBlock(marker, selectFn, blocks) {
  let current = null, dispose = null
  createEffect(() => {
    const index = selectFn()
    if (index === current) return
    current = index
    if (dispose) { dispose(); dispose = null }
    if (index == null) return
    dispose = mountBlock(marker, blocks[index])
  })
}

/** Build `factory(key)` before `marker`, and rebuild it whenever `keyFn`
 *  answers a different key — `<mesa:element this>`, whose tag is the key. */
export function keyBlock(marker, keyFn, factory) {
  let current, dispose = null
  createEffect(() => {
    const key = keyFn()
    if (dispose && key === current) return
    current = key
    if (dispose) dispose()
    dispose = mountBlock(marker, () => factory(key))
  })
}

export function eachBlock(marker, getItems, keyFn, rowFn, elseFn) {
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
        made.nodes = toNodes(rowFn(getItem, getIndex))
        onCleanup(() => { for (const n of made.nodes) detach(n) })
        return dispose
      })
      rows.set(key, made)
    })
    // Every node in the new order lands before the marker in turn, so the
    // sequence ends in order whether a row moved, arrived or stayed.
    for (const key of keys) for (const n of rows.get(key).nodes) placeBefore(marker, n)
    if (items.length === 0) {
      if (elseFn && !elseDispose) elseDispose = mountBlock(marker, elseFn)
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

function focusables(node, out = []) {
  if (!node || node.__marker || node.visible === false) return out
  if (node.focusable) out.push(node)
  if (typeof node.getChildren === 'function') for (const c of node.getChildren()) focusables(c, out)
  return out
}

function cycle(step) {
  const r = needRenderer('focusNext')
  const list = focusables(r.root)
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
  const onKey = (k) => {
    if (k.name !== 'tab') return
    k.preventDefault()
    k.shift ? focusPrev() : focusNext()
  }
  renderer.keyInput.on('keypress', onKey)
  let disposeRoot = () => {}
  try {
    createRoot((dispose) => {
      disposeRoot = dispose
      Component(parent, props, null)
    })
  } catch (e) {
    renderer.keyInput.off('keypress', onKey)
    disposeRoot()
    throw e
  }
  return {
    renderer,
    dispose() {
      disposeRoot()
      renderer.keyInput.off('keypress', onKey)
      for (const c of parent.getChildren()) if (!before.has(c)) c.destroyRecursively()
    },
  }
}
