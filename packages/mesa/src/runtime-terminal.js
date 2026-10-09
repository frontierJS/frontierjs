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
import { createRoot, createEffect, createSignal, onCleanup, eachItems } from './runtime.js'
import { missingPeer } from './optional-peer.js'
import { TERMINAL_TAGS, TERMINAL_EVENTS } from './terminal/tags.js'

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
      node = new BoxRenderable(r, { flexDirection: spec.inline ? 'row' : 'column' })
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
  node.__bits = bits
  node.__attrs = {}
  node.__canFocus = spec.role !== 'box'
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
 * A handler is wired once per event, through a slot the spread rewrites,
 * because the engine has no way to take a listener back off a node: a
 * replaced spread object would otherwise stack a second handler on the first.
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

function keyEvent(node, event, k) {
  return domEvent(node, event, {
    key:      DOM_KEY[k.name] ?? (k.sequence?.length === 1 ? k.sequence : k.name),
    code:     k.name,
    shiftKey: !!k.shift, ctrlKey: !!k.ctrl, altKey: !!(k.option || k.meta), metaKey: !!k.meta,
    raw:      k,
  })
}

function domEvent(node, type, extra) {
  return { type, target: node, currentTarget: node, preventDefault() {}, stopPropagation() {}, ...extra }
}

/** The engine exposes one `onKeyDown` / `onMouseDown` slot per node; several
 *  handlers on one element share it through a list. */
function addKey(node, fn) {
  if (!node.__keys) { node.__keys = []; node.onKeyDown = (k) => { for (const f of node.__keys.slice()) f(k) } }
  node.__keys.push(fn)
}

function addMouseDown(node, fn) {
  if (!node.__mouse) { node.__mouse = []; node.onMouseDown = (e) => { for (const f of node.__mouse.slice()) f(e) } }
  node.__mouse.push(fn)
}

export function on(node, event, handler) {
  const kind = TERMINAL_EVENTS[event]
  if (!kind) throw new Error(`[Mesa] on:${event} has no terminal lowering`)
  switch (kind) {
    case 'activate':
      node.__canFocus = true
      node.focusable = !('disabled' in node.__attrs)
      addMouseDown(node, (e) => { if (!('disabled' in node.__attrs)) handler(domEvent(node, event, { button: 0, raw: e })) })
      addKey(node, (k) => {
        if (k.name !== 'return' && k.name !== 'space' && k.name !== 'enter') return
        k.preventDefault()
        if (!('disabled' in node.__attrs)) handler(keyEvent(node, event, k))
      })
      break
    case 'input':
      node.on('input', (value) => { if (!node.__muted) handler(domEvent(node, event, { value })) })
      break
    case 'keydown':
      addKey(node, (k) => handler(keyEvent(node, event, k)))
      break
    case 'focus':
      node.on('focused', () => handler(domEvent(node, event, {})))
      break
    case 'blur':
      node.on('blurred', () => handler(domEvent(node, event, {})))
      break
    default:
      throw new Error(`[Mesa] on:${event} lowers to '${kind}', which this runtime does not wire`)
  }
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
