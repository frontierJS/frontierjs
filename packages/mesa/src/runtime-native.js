/**
 * The native runtime — `$$host`, what a component compiled with
 * `target: 'native'` calls (`FJS-D1074`), over Lynx's Element PAPI: the
 * `__Create*`, `__Append*` and `__Set*` globals Lynx puts on its main thread.
 * Nothing is imported from the engine, so mesa gains no dependency; the one
 * place Lynx is named is this file, and a second engine is a second file.
 *
 * Every node is a wrapper `{ el, tag, role, parent }` around an engine
 * element. The wrapper tree is the one events bubble through and the one a
 * component's anchor is keyed by. The engine is touched only through its
 * globals, never as DOM: on Lynx for Web the element IS a DOM node, and
 * reaching into it would pass the drive and fail on a phone.
 *
 * What a phone does that a browser does not (`IDEAS/mesa-ir.md` §§ 9, 10):
 * - Raw text paints only inside a text element, so `text()` builds one.
 * - A text element inherits nothing from the view around it, not even
 *   `color`, unless the bundle is built with `enableCSSInheritance`. That
 *   option is the build's, so this file cannot see it is missing: every
 *   label then paints black and nothing reports it.
 * - A write is invisible on a phone until `__FlushElementTree`, so every
 *   mutation schedules one flush per microtask. Lynx for Web ignores it.
 * - A tap's handler runs one microtask after the tap; Mesa's own microtask
 *   flush absorbs that.
 * - A native event names its target by `uid` alone; `elementRefptr` exists
 *   only on Lynx for Web. Taps that looked the target up by ref landed on
 *   the window and did nothing, with no error.
 * - The native main thread (PrimJS) has no `queueMicrotask`, which the
 *   signal flush calls on every write.
 * - Measuring and focusing are callbacks (`__InvokeUIMethod`), never
 *   synchronous. `measure()` and `focus()` answer a Promise everywhere, so
 *   code that reads a rect synchronously fails on the web run too.
 * - A phone sends touch events, never pointer or mouse events. Both are made
 *   here from the touch, one finger, so `drag.js` and `onpointerdown` run
 *   as written for the DOM.
 * - Native flattens a plain view into its parent, and a flattened view has
 *   no native view to answer a UI method (code 6). A node is unflattened the
 *   first time something measures or focuses it.
 */
import { createRoot, createEffect, createSignal, onCleanup, eachItems, setRenderEnvironment, captureContext } from './runtime.js'
import { NATIVE_TAGS, NATIVE_EVENTS, inputKind, tagClass } from './native/tags.js'
import { htmlEntitiesToText } from './entities.js'

// A phone is a running client with no `document`, where `runtime.js` left to
// itself assumes a server render and makes `$.onMount` and a watch no-ops.
setRenderEnvironment(false, true)

globalThis.queueMicrotask ??= (fn) => { Promise.resolve().then(fn) }

// ─── the engine ───────────────────────────────────────────────────────────────

// What each DOM event is on the engine. `root` is one delegated listener on
// the page; `node` is a listener on the element itself; `synth` is made here
// from another event. Keyed by NATIVE_EVENTS, which the compiler refuses by.
const ENGINE_EVENTS = {
  click:              { name: 'tap',         via: 'root' },
  mousedown:          { name: 'touchstart',  via: 'root' },
  mouseup:            { name: 'touchend',    via: 'root' },
  mousemove:          { name: 'touchmove',   via: 'root' },
  pointerdown:        { name: 'touchstart',  via: 'root' },
  pointermove:        { name: 'touchmove',   via: 'root' },
  pointerup:          { name: 'touchend',    via: 'root' },
  pointercancel:      { name: 'touchcancel', via: 'root' },
  input:              { name: 'input',       via: 'node' },
  focus:              { name: 'focus',       via: 'node' },
  blur:               { name: 'blur',        via: 'node' },
  load:               { name: 'load',        via: 'node' },
  error:              { name: 'error',       via: 'node' },
  change:             { via: 'synth' },
  submit:             { via: 'synth' },
  lostpointercapture: { via: 'synth' },
}

const create = {
  box:      (pid) => __CreateView(pid),
  button:   (pid) => __CreateView(pid),
  text:     (pid) => __CreateText(pid),
  image:    (pid) => __CreateImage(pid),
  input:    (pid) => __CreateElement('input', pid),
  textarea: (pid) => __CreateElement('textarea', pid),
}

let _page = null
let _pid = 0
let _flushQueued = false
const byEl = new WeakMap()
const byUid = new Map()

function scheduleFlush() {
  if (_flushQueued) return
  _flushQueued = true
  Promise.resolve().then(() => { _flushQueued = false; __FlushElementTree() })
}

function wrap(el, tag, role) {
  const node = Object.assign(Object.create(Listening), { el, tag, role, parent: null, attrs: {}, __fragment: null })
  byEl.set(el, node)
  byUid.set(__GetElementUniqueID(el), node)
  return node
}

const refuse = (what) => { throw new Error(`[Mesa] ${what} has no native lowering`) }

// ─── tree ─────────────────────────────────────────────────────────────────────

export function fragment() { return [] }

function attach(parent, node, before = null) {
  if (node.parent) __RemoveElement(node.parent.el, node.el)
  node.__fragment = null
  if (before) __InsertElementBefore(parent.el, node.el, before.el)
  else __AppendElement(parent.el, node.el)
  node.parent = parent
  scheduleFlush()
}

export function append(parent, child) {
  if (Array.isArray(child)) { for (const c of child) append(parent, c); return }
  if (Array.isArray(parent)) { parent.push(child); child.__fragment = parent; return }
  if (parent.marker) { placeBefore(parent, child); return }
  attach(parent, child)
}

const toNodes = (out) => Array.isArray(out) ? out : out == null ? [] : [out]

function placeBefore(marker, node) {
  if (marker.parent) { attach(marker.parent, node, marker); return }
  const fr = marker.__fragment
  if (!fr) throw new Error('[Mesa] a block marker is in no parent and no fragment')
  const at = fr.indexOf(node)
  if (at >= 0) fr.splice(at, 1)
  fr.splice(fr.indexOf(marker), 0, node)
  node.__fragment = fr
}

function detach(node) {
  const fr = node.__fragment
  if (fr) { const at = fr.indexOf(node); if (at >= 0) fr.splice(at, 1); node.__fragment = null }
  if (node.parent) { __RemoveElement(node.parent.el, node.el); node.parent = null; scheduleFlush() }
}

// ─── nodes ────────────────────────────────────────────────────────────────────

// The compiler refuses a literal tag and a static type the table lacks; a
// tag or type that is a read reaches here, and is refused by name the same way.
// `scope` is the class the component's scoped rules match on.
export function element(tag, attrs = {}, scope = null) {
  const role = NATIVE_TAGS[tag]?.role
  if (!role) refuse(`<${tag}>`)
  if (role === 'input' && !inputKind(attrs.type)) refuse(`<input type="${attrs.type}">`)
  const node = wrap(create[role](_pid), tag, role)
  if (role === 'input' || role === 'textarea') node.value = ''
  if (scope) node.scope = scope
  paintClasses(node)
  for (const k in attrs) set_attribute(node, k, attrs[k])
  return node
}

export function set_attribute(node, name, value) {
  const present = value != null && value !== false
  if (present) node.attrs[name] = value
  else delete node.attrs[name]
  const str = present ? (value === true ? '' : String(value)) : null
  if (name === 'class') paintClasses(node)
  else if (name === 'id') __SetID(node.el, str)
  else if (name === 'style' || name === 'hidden') paintStyle(node)
  else {
    if (name === 'value' && 'value' in node) node.value = str ?? ''
    __SetAttribute(node.el, name, str)
  }
  scheduleFlush()
}

// A `class:` name lives beside the written class, so a later `class=` write keeps it.
export function toggle_class(node, name, on) {
  (node.toggled ??= new Set())[on ? 'add' : 'delete'](name)
  paintClasses(node)
  scheduleFlush()
}

function paintClasses(node) {
  const written = node.attrs.class == null ? '' : String(node.attrs.class)
  __SetClasses(node.el, [written, ...(node.toggled ?? []), node.scope, tagClass(node.tag)].filter(Boolean).join(' '))
}

// A `style:` property, which a later `style=` write keeps, as on the DOM. A
// null or empty value removes it.
export function set_style(node, name, value) {
  const props = (node.styled ??= new Map())
  if (value == null || value === '') props.delete(name)
  else props.set(name, String(value))
  paintStyle(node)
  scheduleFlush()
}

// One write of the whole inline style, since the engine's call replaces it:
// the `style` attribute, then each `style:` property, then `hidden`.
function paintStyle(node) {
  const written = node.attrs.style == null || node.attrs.style === true ? '' : String(node.attrs.style).trim().replace(/;+$/, '')
  const parts = written ? [written] : []
  for (const [k, v] of node.styled ?? []) parts.push(`${k}: ${v}`)
  if (node.attrs.hidden != null) parts.push('display: none')
  __SetInlineStyles(node.el, parts.length ? parts.join('; ') : undefined)
}

export function spread(node, fn) {
  const live = {}
  let prev = {}
  const put = (k, v) => {
    const event = k.length > 2 && k.startsWith('on') ? k.slice(2) : null
    if (event && (typeof v === 'function' || event in live)) {
      if (!NATIVE_EVENTS[event]) return
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
  const t = value == null ? '' : String(value)
  const el = __CreateText(_pid)
  const raw = __CreateRawText(t)
  __AppendElement(el, raw)
  const node = wrap(el, '#text', 'text')
  node.raw = raw
  node.t = t
  return node
}

export function set_text(node, value) {
  const str = value == null ? '' : String(value)
  if (str === node.t) return
  node.t = str
  __SetAttribute(node.raw, 'text', str)
  scheduleFlush()
}

// Markup paints as the text a browser's `innerText` reads from it: the
// engine has no HTML parser on its main thread.
const BLOCK_END = /<\/(?:p|div|li|dt|dd|h[1-6]|tr|pre|blockquote|section|article|header|footer|ul|ol|dl|table)\s*>/gi
export function markupText(html, pre) {
  if (html == null) return ''
  let s = String(html).replace(/<!--[\s\S]*?-->/g, '')
  if (!pre) s = s.replace(/\s+/g, ' ')
  s = htmlEntitiesToText(s.replace(/<br\s*\/?>/gi, '\n').replace(BLOCK_END, '\n').replace(/<[^>]*>/g, ''))
  return pre ? s : s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
}
export function markup() { return text('') }

export function marker() {
  const el = __CreateView(_pid)
  __AddInlineStyle(el, 'display', 'none')
  const node = wrap(el, '#marker', 'box')
  node.marker = true
  return node
}

// ─── events ───────────────────────────────────────────────────────────────────

const rootListening = new Set()

/** The wrapper an engine event happened at: its own, or the nearest ancestor's. */
function nodeOf(target) {
  if (target?.uid != null && byUid.has(target.uid)) return byUid.get(target.uid)
  let el = target?.elementRefptr
  while (el) {
    const n = byEl.get(el)
    if (n) return n
    el = __GetParent(el)
  }
  return null
}

export function on(node, event, handler, { capture = false, once = false } = {}, spelling = `on${event}`) {
  const spec = ENGINE_EVENTS[event]
  if (!spec) refuse(spelling)
  if (!handler) return
  ;((node.listeners ??= {})[event] ??= []).push({ fn: handler, capture, once })
  if (spec.via === 'root') listenAtRoot(event)
  if (spec.via === 'node') source(node, event)
  if (event === 'change' && (node.role === 'input' || node.role === 'textarea')) { source(node, 'focus'); source(node, 'blur') }
}

// The window is the last stop of every bubbling path, as on the DOM.
const win = { tag: '#window', role: 'window', parent: null, listeners: {} }

function listenAtRoot(event) {
  if (rootListening.has(event)) return
  rootListening.add(event)
  const touch = ENGINE_EVENTS[event].name.startsWith('touch')
  const pointer = event.startsWith('pointer')
  __AddEventListener(_page, ENGINE_EVENTS[event].name, (e) => {
    const target = (pointer && event !== 'pointerdown' && captured) || (nodeOf(e.target) ?? win)
    const done = dispatch(target, event, touch ? touchFields(e, event, pointer) : { detail: e.detail })
    if (event === 'click' && !done.defaultPrevented) activate(target)
    if ((event === 'pointerup' || event === 'pointercancel') && captured) captured.releasePointerCapture(POINTER_ID)
  }, {})
}

// ─── touch as mouse and pointer ───────────────────────────────────────────────

// One finger, so one id: a single-touch `identifier` is the address of an
// engine stack frame, a new number on every event of the same touch.
const POINTER_ID = 1

// `detail` is the one position a phone and Lynx for Web agree on, the page's
// own coordinates, in `$.measure`'s units. A Touch's `pageX` is the page's on a
// phone and the browser document's on Lynx for Web. A lifted finger has no
// `detail` on Lynx for Web, so an end reports where the last move was.
let lastAt = { x: 0, y: 0 }

function touchFields(e, event, pointer) {
  const d = e.detail
  if (typeof d?.x === 'number' && typeof d?.y === 'number') lastAt = { x: d.x, y: d.y }
  const { x, y } = lastAt
  const held = event.endsWith('down') || event.endsWith('move')
  const fields = { detail: d, button: 0, buttons: held ? 1 : 0, clientX: x, clientY: y, pageX: x, pageY: y }
  if (pointer) Object.assign(fields, { pointerId: POINTER_ID, pointerType: 'touch', isPrimary: true })
  return fields
}

// The engine keeps every event of a touch at the element it began on, so a
// touch is captured before anything asks. What capture adds is the DOM's
// retargeting, to an ancestor that took it, and `lostpointercapture` once the
// finger lifts or the capture is released.
let captured = null

// What an attachment written for the DOM calls on its element. Every listener
// goes through `on()`, so an event a phone does not send throws by name.
const Listening = {
  addEventListener(type, fn, opts = false) {
    const { capture = false, once = false } = typeof opts === 'boolean' ? { capture: opts } : opts
    on(this, type, fn, { capture, once }, `addEventListener('${type}')`)
  },
  removeEventListener(type, fn, opts = false) {
    const capture = typeof opts === 'boolean' ? opts : !!opts.capture
    const list = this.listeners?.[type]
    const at = list ? list.findIndex((l) => l.fn === fn && l.capture === capture) : -1
    if (at >= 0) list.splice(at, 1)
  },
  // The release is heard at the root whoever else listens, or a capture
  // nobody released would take the next touch.
  setPointerCapture(id) {
    if (id !== POINTER_ID) return
    captured = this
    listenAtRoot('pointerup')
    listenAtRoot('pointercancel')
  },
  hasPointerCapture(id) { return id === POINTER_ID && captured === this },
  releasePointerCapture(id) {
    if (!this.hasPointerCapture(id)) return
    captured = null
    dispatch(this, 'lostpointercapture', { pointerId: POINTER_ID, pointerType: 'touch', isPrimary: true })
  },
}

/** Listen at the element for an event the engine reports only there. */
function source(node, event) {
  const s = (node.sources ??= new Set())
  if (s.has(event)) return
  s.add(event)
  __AddEventListener(node.el, ENGINE_EVENTS[event].name, (e) => {
    if (event === 'input') node.value = String(e.detail?.value ?? '')
    if (event === 'focus') node.focusedWith = node.value
    dispatch(node, event)
    if (event === 'blur' && node.focusedWith !== undefined && node.focusedWith !== node.value) dispatch(node, 'change')
  }, {})
}

/** A tap's default: a submit button submits its form. */
function activate(target) {
  for (let n = target; n; n = n.parent) {
    if (n.role !== 'button') continue
    if ((n.attrs.type ?? 'submit') !== 'submit') return
    for (let f = n.parent; f; f = f.parent) if (f.tag === 'form') { dispatch(f, 'submit', { submitter: n }); return }
    return
  }
}

function fire(node, e, phase) {
  const list = node.listeners?.[e.type]
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

function dispatch(target, type, extra = {}) {
  const path = []
  for (let n = target.parent; n; n = n.parent) path.push(n)
  if (target !== win) path.push(win)
  let stopped = false
  const e = {
    type, target, currentTarget: null, isTrusted: true, defaultPrevented: false,
    bubbles: NATIVE_EVENTS[type]?.bubbles ?? false,
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

// Only an event the page hears can reach the window.
export function onWindow(event, handler, { capture = false, once = false } = {}) {
  if (ENGINE_EVENTS[event]?.via !== 'root') refuse(`<mesa:window on${event}>`)
  if (!handler) return
  listenAtRoot(event)
  const list = (win.listeners[event] ??= [])
  const entry = { fn: handler, capture, once }
  list.push(entry)
  onCleanup(() => { const at = list.indexOf(entry); if (at >= 0) list.splice(at, 1) })
}

// ─── bindings ─────────────────────────────────────────────────────────────────

export function bind(node, name, get, set) {
  if (name !== 'value' || !('value' in node)) refuse(`bind:${name} on <${node.tag}>`)
  const read = () => {
    if (node.attrs.type !== 'number') return node.value
    const n = Number(node.value)
    return node.value.trim() === '' || Number.isNaN(n) ? undefined : n
  }
  on(node, 'input', () => set(read()))
  createEffect(() => { set_attribute(node, 'value', get() ?? '') })
}

// ─── blocks ───────────────────────────────────────────────────────────────────

function mountBlock(marker, factory) {
  return createRoot((dispose) => {
    const nodes = toNodes(factory())
    for (const n of nodes) placeBefore(marker, n)
    onCleanup(() => { for (const n of nodes) detach(n) })
    return dispose
  })
}

export function ifBlock(marker, selectFn, blocks) {
  const withContext = captureContext()
  let current = null
  let dispose = null
  createEffect(() => {
    const index = selectFn()
    if (index === current) return
    current = index
    if (dispose) { dispose(); dispose = null }
    if (index == null) return
    dispose = mountBlock(marker, () => withContext(blocks[index]))
  })
}

export function keyBlock(marker, keyFn, factory) {
  const withContext = captureContext()
  let current
  let dispose = null
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
  createEffect(() => {
    const items = eachItems(getItems())
    const keys = []
    const seen = new Set()
    for (let i = 0; i < items.length; i++) {
      let key = keyFn ? keyFn(items[i], i) : i
      if (seen.has(key)) key = `\u0000dup:${i}`
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
    for (const key of keys) for (const n of rows.get(key).nodes) placeBefore(marker, n)
    if (items.length === 0) {
      if (elseFn && !elseDispose) elseDispose = mountBlock(marker, () => withContext(elseFn))
    } else if (elseDispose) {
      elseDispose()
      elseDispose = null
    }
  })
}

// ─── measure and focus ────────────────────────────────────────────────────────

// `$.measure`, `$.viewport` and `$.focus` on a phone; `runtime.js` holds the
// DOM's answer in the same shape.

/** Move focus to `node`. No node does nothing. */
export function focus(node) {
  if (!node) return Promise.resolve()
  return invoke(node, 'focus').then(() => {})
}

/** The box `node` occupies, as `{ left, top, right, bottom, width, height }`.
 *  No node answers `null`. A phone answers its `data` as a JSON string and
 *  Lynx for Web as an object. */
export function measure(node) {
  if (!node) return Promise.resolve(null)
  return invoke(node, 'boundingClientRect').then(({ data }) => {
    const { left, top, right, bottom, width, height } = typeof data === 'string' ? JSON.parse(data) : data
    return { left, top, right, bottom, width, height }
  })
}

/** The screen, as `{ width, height }`: the page's own box, so it is in the
 *  units `measure` answers whatever the device's pixel ratio. A page is never
 *  flattened, so it is not unflattened first. */
export function viewport() {
  if (!_page) return Promise.reject(new Error('[Mesa] $.viewport() before mount(): there is no page'))
  return measure({ el: _page, tag: 'page', unflattened: true }).then(({ width, height }) => ({ width, height }))
}

// The answer is deferred a microtask even where the engine calls back at
// once, so the web run cannot pass code a phone would answer later. A code
// other than 0 is the engine refusing, and a caller reading it as a rect would
// place a panel at undefined.
function invoke(node, method, params = {}) {
  if (!node.unflattened) {
    node.unflattened = true
    __SetAttribute(node.el, 'flatten', false)
    __FlushElementTree()
  }
  return new Promise((resolve, reject) => __InvokeUIMethod(node.el, method, params, (r) => {
    Promise.resolve().then(() => r?.code === 0 ? resolve(r)
      : reject(new Error(`[Mesa] ${method} on <${node.tag}> was refused by the engine: code ${r?.code}${r?.data ? `, ${typeof r.data === 'string' ? r.data : JSON.stringify(r.data)}` : ''}`)))
  }))
}

// ─── mount ────────────────────────────────────────────────────────────────────

/** Mount `Component` as the page. Call it from the engine's `__RenderPage`. */
export function mount(Component, { props = {} } = {}) {
  _page = __CreatePage('0', 0)
  _pid = __GetElementUniqueID(_page)
  // The page is the document root: the user-agent sheet's 16px root font-size
  // lands here, and without it every rem and em reads the engine's 14px.
  __SetClasses(_page, tagClass('html'))
  const root = wrap(__CreateView(_pid), '#root', 'box')
  __AppendElement(_page, root.el)
  let disposeRoot = () => {}
  createRoot((dispose) => {
    disposeRoot = dispose
    Component(root, props)
  })
  __FlushElementTree()
  return { root, dispose: disposeRoot }
}
