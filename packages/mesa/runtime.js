/**
 * @frontierjs/mesa-runtime  v0.1.0
 */

const _resolved = Promise.resolve()
/** True in any browser environment. False in Node/Deno/workers without DOM.
 *  Can be set to true by renderToHTML when a virtual DOM (happy-dom) is active. */
let _isBrowser = typeof document !== 'undefined'

/**
 * Override the browser environment flag.
 * Called by @frontierjs/mesa-render before mounting components in a happy-dom Window.
 * This unlocks htmlToFragment and other DOM-dependent functions in Node.js.
 */
export function setRenderEnvironment(isBrowser) {
  _isBrowser = isBrowser
}
function _safeCall(fn) {
  try {
    return fn?.()
  } catch (e) {
    console.error(e)
  }
}
function _safeGroup(list) {
  if (!list) return
  for (const fn of list) _safeCall(fn)
}
function _remove(arr, item) {
  const i = arr.indexOf(item)
  if (i >= 0) arr.splice(i, 1)
}

let _listener = null
let _owner = null
let _batching = false
const _queue = new Set()
let _microtaskPending = false

// Schedule a microtask flush if one isn't already queued and we're not inside
// a synchronous batch(). This is the heart of automatic coalescing: multiple
// signal writes anywhere (async fns, timers, Promise callbacks) in the same
// tick accumulate into one flush rather than each triggering an immediate run.
function _scheduleFlush() {
  if (_microtaskPending || _batching) return
  _microtaskPending = true
  queueMicrotask(_flush)
}

// Drain all pending effect nodes. Run in a loop so that effects triggered by
// other effects in this batch are also flushed before control returns.
function _flush() {
  _microtaskPending = false
  while (_queue.size > 0) {
    const pending = [..._queue]
    _queue.clear()
    for (const node of pending) node._run()
  }
}

/**
 * Flush all pending effects synchronously right now.
 * Use in tests or anywhere you need to read reactive state immediately after
 * writing signals outside of a batch() or event handler.
 *
 *   setCount(1)
 *   flushSync()
 *   expect(el.textContent).toBe('1')  // works
 */
export function flushSync() {
  _microtaskPending = false
  _flush()
}

export function createSignal(value, opts) {
  const eq = opts?.equals ?? Object.is
  const self = { _subs: new Set() }
  const read = () => {
    if (_listener) {
      self._subs.add(_listener)
      _listener._deps.add(self)
    }
    return value
  }
  const write = (next) => {
    // Direct write — no updater-function pattern. The compiler emits final values
    // directly (count++ → set(sig, get(sig)+1)). Calling function values here would
    // accidentally invoke snippets/callbacks stored in signals.
    if (eq(value, next)) return
    value = next
    for (const sub of [...self._subs]) sub._notify()
  }
  return [read, write]
}

export function createEffect(fn) {
  const node = _makeNode(fn)
  node._run()
  return () => _disposeNode(node, true)
}

function _makeNode(fn) {
  const node = {
    _fn: fn,
    _deps: new Set(),
    _cleanups: [],
    _children: [],
    _owner: _owner,
    _disposed: false,
    _notify() {
      _queue.add(this)
      _scheduleFlush()
    },
    _run() {
      // Guard: if this node was disposed while sitting in the flush queue
      // (e.g. an ifBlock branch was torn down between queue snapshot and _run),
      // skip execution entirely. Without this, effects inside a disposed branch
      // can still fire and access null/undefined reactive state → TypeError.
      if (this._disposed) return
      // On re-run: clear reactive subscriptions and previous cleanups so we
      // re-subscribe to the correct signals on this run.
      // IMPORTANT: do NOT dispose _children here.
      //
      // Children (branchNode in ifBlock, blockNode in keyBlock, nested components)
      // have their own lifecycle managed by the block that created them:
      //   - ifBlock calls _removeBlock() → _disposeNode(branchNode) when branch changes
      //   - keyBlock calls _remove() → _disposeNode(blockNode) when key changes
      //   - pop_component() disposes the component rootNode on unmount
      //
      // Disposing children in _run() was the bug: when ifBlock's condition effect
      // re-ran (params changed, same branch), it disposed branchNode — which
      // contained ChainRendererInner's keyBlock effect — before the early-return
      // `if (next === current) return` check. The DOM stayed but all effects
      // tracking params inside that branch were permanently gone.
      for (let i = this._cleanups.length - 1; i >= 0; i--) _safeCall(this._cleanups[i])
      this._cleanups = []
      for (const sig of this._deps) sig._subs.delete(this)
      this._deps.clear()

      const prevL = _listener,
        prevO = _owner
      _listener = this
      _owner = this
      try {
        const result = this._fn()
        // Return-based cleanup: if the effect fn returns a function, register it
        // as a cleanup that runs before the next execution or on destroy.
        // If it returns a Promise (async handler), wait for resolution — if the
        // resolved value is a function, register it then.
        // Note: for async handlers, cancel-in-flight still requires $onCleanup
        // before the first await, since that cleanup must register synchronously.
        if (typeof result === 'function') {
          this._cleanups.push(result)
        } else if (result && typeof result.then === 'function') {
          const node = this
          result.then((ret) => {
            if (typeof ret === 'function') node._cleanups.push(ret)
          })
        }
      } finally {
        _listener = prevL
        _owner = prevO
      }
    }
  }
  if (_owner) _owner._children.push(node)
  return node
}

function _disposeNode(node, removeFromOwner) {
  // Children first (inner-to-outer). Parent cleanups may reference DOM or
  // subscriptions owned by children — children must go before parents do.
  for (const child of node._children) _disposeNode(child, false)
  node._children = []
  // This node's cleanups run after all children are disposed, LIFO.
  for (let i = node._cleanups.length - 1; i >= 0; i--) _safeCall(node._cleanups[i])
  node._cleanups = []
  for (const sig of node._deps) sig._subs.delete(node)
  node._deps.clear()
  // Mark as disposed so _run() can skip it if already in the pending snapshot.
  // _queue.delete() alone is insufficient because _flush() snapshots the queue
  // with [..._queue] then clears it before running nodes — by the time
  // _disposeNode is called from inside a running effect, the node is in the
  // snapshot array, not in _queue, so _queue.delete() is a no-op.
  node._disposed = true
  _queue.delete(node)
  if (removeFromOwner && node._owner) _remove(node._owner._children, node)
}

/**
 * A signal whose value is derived from a memo but can also be overridden
 * manually. When deps change, the derivation wins (last write wins between
 * memo and manual setter — memo fires on dep change, manual holds until then).
 *
 * Used for top-level `let` declarations with reactive deps:
 *   let selected = items[0]   →  createWritableSignal(() => items()[0])
 *
 * @param {Function} fn  Derivation function (same as createMemo)
 * @param {object}  [opts]  { equals? }
 * @returns {[readFn, writeFn]}
 */
export function createWritableSignal(fn, opts) {
  const memo = createMemo(fn, opts)
  const [read, write] = createSignal(memo())
  // When memo recomputes (deps changed), push derived value into signal.
  // Manual writes hold until the next dep change — then derivation takes over.
  createEffect(() => write(memo()))
  return [read, write]
}

export function createMemo(fn, opts) {
  const eq = opts?.equals ?? Object.is
  let value,
    dirty = true
  const ownSubs = new Set()
  const memoNode = {
    _deps: new Set(),
    _cleanups: [],
    _children: [],
    _owner: _owner,
    _notify() {
      if (dirty) return
      dirty = true
      for (const sub of [...ownSubs]) sub._notify()
    }
  }
  if (_owner) _owner._children.push(memoNode)
  const memoSignal = { _subs: ownSubs }
  const read = () => {
    if (_listener) {
      ownSubs.add(_listener)
      _listener._deps.add(memoSignal)
    }
    if (dirty) {
      for (const sig of memoNode._deps) sig._subs.delete(memoNode)
      memoNode._deps.clear()
      const prevL = _listener
      _listener = memoNode
      try {
        const next = fn()
        if (!eq(value, next)) value = next
        dirty = false
      } finally {
        _listener = prevL
      }
    }
    return value
  }
  return read
}

export function batch(fn) {
  if (_batching) return fn()
  _batching = true
  try {
    fn()
  } finally {
    _batching = false
    // Synchronous flush — so callers can read updated DOM/state right away.
    // The microtask that may have been scheduled inside fn() is cancelled by
    // _flush() setting _microtaskPending = false before it fires.
    _flush()
  }
}

export function $tick(fn) {
  fn && _resolved.then(fn)
  return _resolved
}

export function untrack(fn) {
  const prev = _listener
  _listener = null
  try {
    return fn()
  } finally {
    _listener = prev
  }
}

export function onCleanup(fn) {
  if (_owner) _owner._cleanups.push(fn)
}
let _mountList = null // $onMount callbacks collected during component init
let _propRegistry = null // prop signal map collected during component init
export function $onMount(fn) {
  if (!_isBrowser) return // Rule 19: $onMount is a no-op on server
  if (_mountList) _mountList.push(fn)
  else _resolved.then(fn)
}
export function $onDestroy(fn) {
  onCleanup(fn)
}
export const $onCleanup = onCleanup

export function createContext(defaultValue) {
  return { id: Symbol('mesa.ctx'), defaultValue }
}
const _contextStack = []
export function provideContext(ctx, value) {
  const map = _contextStack[_contextStack.length - 1]
  if (map) map.set(ctx.id, value)
}
export function useContext(ctx) {
  for (let i = _contextStack.length - 1; i >= 0; i--) {
    if (_contextStack[i].has(ctx.id)) return _contextStack[i].get(ctx.id)
  }
  return ctx.defaultValue
}

/**
 * $context.key = expr  — provide a reactive getter for `key` in this component's
 * context slot. Descendants can read it via contextRead('key').
 *
 * The getter is a function () => currentValue, typically a signal getter so that
 * consumers auto-subscribe when they call it inside a reactive scope.
 *
 * @param {string}   key     String key identifying this context value
 * @param {Function} getter  () => value  — reactive getter
 */
export function contextProvide(key, getter) {
  const map = _contextStack[_contextStack.length - 1]
  if (map) map.set('$$ctx$$' + key, getter)
}

/**
 * $context.key read — walk the context stack (from nearest ancestor outward)
 * and return the getter registered for `key`, or null if none found.
 *
 * The returned getter is a reactive function — calling it inside an effect or
 * memo auto-subscribes to the provider's signal.
 *
 * @param {string} key
 * @returns {Function|null}
 */
export function contextRead(key) {
  const k = '$$ctx$$' + key
  // Walk from innermost (top-1, skip current component's own map) outward.
  // The current component's map is _contextStack[length-1]. Its ancestors
  // are below it. We skip index length-1 because a component shouldn't
  // consume its own provides.
  for (let i = _contextStack.length - 2; i >= 0; i--) {
    if (_contextStack[i].has(k)) return _contextStack[i].get(k)
  }
  return null
}

export const $context = { use: useContext, provide: provideContext }

const _CACHE_MAX = 500
const _templateCache = new Map(),
  _templateCacheSvg = new Map()
function _cachePut(cache, key, value) {
  if (cache.size >= _CACHE_MAX) cache.delete(cache.keys().next().value)
  cache.set(key, value)
}

export function htmlToFragment(html, option, clean) {
  if (!_isBrowser)
    throw new Error(
      '@frontierjs/mesa-runtime: htmlToFragment() called in a non-browser environment. ' +
        'Use the Mesa SSR compiler target which emits string concatenation instead of DOM calls.'
    )
  let result = _templateCache.get(html)
  if (!result) {
    const t = document.createElement('template')
    t.innerHTML = html.replace(/<>/g, '<!---->')
    result = t.content
    if (clean) {
      const it = document.createNodeIterator(result, NodeFilter.SHOW_COMMENT)
      let n
      while ((n = it.nextNode())) {
        if (!n.nodeValue) n.parentNode.replaceChild(document.createTextNode(''), n)
      }
    }
    if (!(option & 2) && result.firstChild === result.lastChild) result = result.firstChild
    _cachePut(_templateCache, html, result)
  }
  return option & 1 ? result.cloneNode(true) : result
}

export const htmlToFragmentClean = (html, option) => htmlToFragment(html, option, true)

export function svgToFragment(content) {
  if (!_isBrowser)
    throw new Error(
      '@frontierjs/mesa-runtime: svgToFragment() called in a non-browser environment. ' +
        'Use the Mesa SSR compiler target.'
    )
  if (_templateCacheSvg.has(content)) return _templateCacheSvg.get(content).cloneNode(true)
  const t = document.createElement('template')
  t.innerHTML = `<svg>${content}</svg>`
  const result = document.createDocumentFragment()
  const svg = t.content.firstChild
  while (svg.firstChild) result.appendChild(svg.firstChild)
  _cachePut(_templateCacheSvg, content, result.cloneNode(true))
  return result
}

export const createTextNode = (text) => {
  if (!_isBrowser)
    throw new Error('@frontierjs/mesa-runtime: createTextNode() called in a non-browser environment.')
  return document.createTextNode(text)
}
export const insertAfter = (anchor, node) =>
  anchor.parentNode.insertBefore(node, anchor.nextSibling)
export const iterNodes = (first, last, fn) => {
  let next
  while (first) {
    next = first.nextSibling
    fn(first)
    if (first === last) break
    first = next
  }
}
export const removeElements = (first, last) => iterNodes(first, last, (n) => n.remove())
// ── Style injection ───────────────────────────────────────────────────────────
// By default styles go into document.head. Shadow DOM mounts register their
// shadow root via _registerStyleRoot() so styles land in the right place.
// Uses adoptedStyleSheets when available (shadow roots support them natively)
// with a <style> tag fallback for document.head and older environments.

const _styleRoots  = new Map()   // styleRoot → Set<id> (already-injected style ids)
let   _defaultRoot = null        // set to document.head after browser init

function _getStyleTarget(id) {
  // Check if any registered shadow root should receive this style
  for (const [root] of _styleRoots) return root   // first registered root for now
  return _defaultRoot ?? document.head
}

export const addStyles = (id, css) => {
  if (!_isBrowser) return
  _defaultRoot = _defaultRoot ?? document.head

  // Find the right target for this style
  let target = document.head
  for (const [root, ids] of _styleRoots) {
    if (!ids.has(id)) {
      ids.add(id)
      _injectStyle(root, id, css)
    }
    target = null  // handled by registered roots
  }

  // Also inject into document.head for non-shadow usage
  if (target) {
    if (document.head.querySelector(`style#${id}`)) return
    _injectStyle(document.head, id, css)
  }
}

function _injectStyle(target, id, css) {
  // ShadowRoot supports adoptedStyleSheets — use CSSStyleSheet for zero DOM overhead
  if (target instanceof ShadowRoot && typeof CSSStyleSheet !== 'undefined') {
    try {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(css)
      // Tag it so we can deduplicate
      sheet.__mesaId = id
      if (!target.adoptedStyleSheets.some(s => s.__mesaId === id)) {
        target.adoptedStyleSheets = [...target.adoptedStyleSheets, sheet]
      }
      return
    } catch { /* fall through to <style> tag */ }
  }
  // Fallback: <style> tag — works for document.head and older shadow root polyfills
  if (target.querySelector?.(`style#${id}`)) return
  const el = document.createElement('style')
  el.id = id
  el.textContent = css
  target.appendChild(el)
}

/**
 * Register a shadow root to receive component styles.
 * Called by mount() when a styleRoot option is provided.
 * Returns a cleanup fn that removes all injected styles on destroy.
 */
export function _registerStyleRoot(root) {
  if (!root || _styleRoots.has(root)) return () => {}
  _styleRoots.set(root, new Set())
  return () => {
    const ids = _styleRoots.get(root)
    if (ids) {
      // Remove adoptedStyleSheets we added
      if (root instanceof ShadowRoot) {
        root.adoptedStyleSheets = root.adoptedStyleSheets.filter(s => !ids.has(s.__mesaId))
      } else {
        for (const id of ids) root.querySelector(`style#${id}`)?.remove()
      }
    }
    _styleRoots.delete(root)
  }
}

export function refer(root, path) {
  const result = []
  let active = root
  const code = (c, d) => c.charCodeAt(0) - d
  for (let i = 0; i < path.length; i++) {
    const a = path[i]
    switch (a) {
      case '>':
        active = active.firstChild
        break
      case '.':
        result.push(active)
        break
      case '+':
        active = active.firstChild
        result.push(active)
        break
      case '~':
        result.push(
          active.nodeType === 3 || active.nodeType === 8 ? active : active.firstChild
        )
        break
      case '^':
        active = active.parentNode
        break
      case '!': {
        let v = code(path[++i], 48) * 42 + code(path[++i], 48)
        while (v--) active = active.nextSibling
        break
      }
      case '#': {
        active = result[code(path[++i], 48) * 26 + code(path[++i], 48)]
        break
      }
      default: {
        const v = code(a, 0)
        if (v >= 97) {
          active = result[v - 97]
        } else {
          let n = v - 48
          while (n--) active = active.nextSibling
        }
      }
    }
  }
  return result
}

export function bindText(el, fn) {
  createEffect(() => {
    // Memoize last written value — skip DOM write if value unchanged.
    const v = fn()
    const str = v == null ? '' : typeof v === 'object' ? '' + v : v
    if (str !== el.__t) {
      el.__t = str
      el.textContent = str
    }
  })
}

// DOM properties that should be set directly on the element rather than via
// setAttribute. Setting these as attributes either doesn't work or coerces
// the value to a string in ways that break boolean semantics.
const _DOM_PROPS = new Set([
  'value', 'checked', 'selected', 'indeterminate', 'innerHTML', 'textContent',
  'innerText', 'scrollTop', 'scrollLeft', 'selectedIndex', 'defaultValue',
  'defaultChecked', 'volume', 'currentTime', 'playbackRate', 'muted',
  'loop', 'autoplay', 'controls', 'open',
])

export function bindAttribute(el, name, fn) {
  createEffect(() => {
    const v = fn()
    if (v == null || v === false) {
      el.removeAttribute(name)
    } else if (_DOM_PROPS.has(name)) {
      el[name] = v
    } else if (_BOOL_ATTRS.has(name)) {
      el.setAttribute(name, '')
    } else {
      el.setAttribute(name, '' + v)
    }
  })
}
export function bindClass(el, fn, className) {
  createEffect(
    () => {
      fn() ? el.classList.add(className) : el.classList.remove(className)
    },
    { value: false }
  )
}
export function bindClassExp(el, fn) {
  createEffect(() => {
    const v = fn()
    if (v != null) el.setAttribute('class', v)
    else el.removeAttribute('class')
  })
}
export function bindStyle(el, name, fn) {
  createEffect(() => {
    el.style.setProperty(name, fn())
  })
}
export function bindInput(el, name, get, set) {
  const readFn = name === 'checked' ? () => !!get() : get
  const handler = () => set(el[name])
  addEvent(el, 'input', handler)
  // Also listen to 'change' — color/date/range inputs may only fire 'change',
  // not 'input', while the picker is open. Deduplication is handled by batching.
  addEvent(el, 'change', handler)
  createEffect(() => {
    el[name] = readFn() ?? ''
  })
}

/**
 * bindMask — input masking for bind:value|mask({"pattern"})={value}
 *
 * Pattern characters:
 *   9  — digit (0-9)
 *   a  — letter (a-zA-Z)
 *   *  — alphanumeric
 *   Everything else — literal, auto-inserted as you type
 *
 * Special patterns:
 *   '$money' — currency (stubbed — returns basic digit pattern)
 *
 * The signal always holds the formatted value.
 * Initial signal value is formatted on mount.
 */
export function bindMask(el, getter, setter, pattern) {
  const SLOTS = { '9': /[0-9]/, 'a': /[a-zA-Z]/, '*': /[a-zA-Z0-9]/ }

  function getPattern(input) {
    if (pattern === '$money') return _moneyStub(input)
    return typeof pattern === 'function' ? pattern(input) : pattern
  }

  // Strip literal characters from a value so we're left with only user-typed chars
  function stripLiterals(tmpl, val) {
    let out = '', vi = 0
    for (let ti = 0; ti < tmpl.length && vi < val.length; ti++, vi++) {
      if (tmpl[ti] in SLOTS) {
        out += val[vi]
      } else {
        // Consume matching literal from val if present, otherwise keep char
        if (val[vi] === tmpl[ti]) continue
        out += val[vi]
      }
    }
    while (vi < val.length) out += val[vi++]
    return out
  }

  // Walk template and stripped input simultaneously to produce formatted output
  function format(tmpl, raw) {
    const stripped = stripLiterals(tmpl, raw)
    let t = 0, i = 0, out = ''
    while (t < tmpl.length && i < stripped.length) {
      const tc = tmpl[t], ic = stripped[i]
      if (tc in SLOTS) {
        if (SLOTS[tc].test(ic)) { out += ic; t++ }
        i++
      } else {
        out += tc; t++
      }
    }
    return out
  }

  // Restore cursor to its logical position after formatting
  function applyWithCursor(raw, tmpl) {
    const cursor   = el.selectionStart
    const before   = el.value.slice(0, cursor)
    const formatted = format(tmpl, raw)
    el.value = formatted
    // Re-derive cursor: format the portion before old cursor, use its length
    const newPos = format(tmpl, stripLiterals(tmpl, before) + '\x00').replace('\x00', '').length
    el.setSelectionRange(newPos, newPos)
    return formatted
  }

  let lastValue = ''

  function processInput(restoreCursor = true) {
    const raw  = el.value
    const tmpl = getPattern(raw)
    if (!tmpl) return

    // Backspace — let browser handle the deletion, just track
    if (lastValue.length > raw.length) { lastValue = raw; return }

    const formatted = restoreCursor ? applyWithCursor(raw, tmpl) : format(tmpl, raw)
    if (!restoreCursor) el.value = formatted
    lastValue = el.value
    setter(el.value)
  }

  // Format and apply initial signal value on mount
  const initial = getter()
  if (initial != null && initial !== '') {
    const tmpl = getPattern(String(initial))
    if (tmpl) {
      el.value = format(tmpl, String(initial))
      lastValue = el.value
      setter(el.value)
    }
  }

  const onInput = () => processInput(true)
  const onBlur  = () => processInput(false)
  el.addEventListener('input', onInput)
  el.addEventListener('blur',  onBlur)
  return () => {
    el.removeEventListener('input', onInput)
    el.removeEventListener('blur',  onBlur)
  }
}

// $money stub — basic digit pattern based on current input length
// Full implementation (thousands separators, precision) deferred
function _moneyStub(input) {
  const digits = (input || '').replace(/[^0-9.]/g, '')
  const intLen = digits.split('.')[0].length || 1
  return '9'.repeat(Math.max(intLen, 1)) + (digits.includes('.') ? '.99' : '')
}

/**
 * bind:group={arr} — checkbox/radio group binding.
 *
 * Checkbox: `arr` is an array. The element's value is included/excluded on change.
 *   el.checked reflects whether the value is in the array.
 *
 * Radio: `arr` is a scalar. Set to element's value when selected.
 *   el.checked reflects whether the value matches the scalar.
 *
 * @param {Element}  el       The input element
 * @param {Function} getArr   () => current signal value (array or scalar)
 * @param {Function} setArr   Signal setter
 * @param {Function} getVal   () => this element's value
 */
export function bindGroup(el, getArr, setArr, getVal) {
  const isCheckbox = el.type === 'checkbox'

  // Sync DOM → signal on change
  addEvent(el, 'change', () => {
    const val = getVal()
    if (isCheckbox) {
      const arr = getArr() ?? []
      if (el.checked) {
        if (!arr.includes(val)) setArr([...arr, val])
      } else {
        setArr(arr.filter((v) => v !== val))
      }
    } else {
      // radio
      if (el.checked) setArr(val)
    }
  })

  // Sync signal → DOM (checked state)
  createEffect(() => {
    const val = getVal()
    const current = getArr()
    if (isCheckbox) {
      el.checked = Array.isArray(current) ? current.includes(val) : false
    } else {
      el.checked = current === val
    }
  })
}

export function addEvent(el, event, fn, opts) {
  if (!fn) return
  const batched = (e) => batch(() => fn(e))
  el.addEventListener(event, batched, opts)
  onCleanup(() => el.removeEventListener(event, batched, opts))
}

/**
 * <mesa:window|document|body on:event={fn}> — add listener to a global target.
 * target: 'window' | 'document' | 'body'
 */
export function addGlobalEvent(target, event, fn, opts) {
  if (!_isBrowser || !fn) return
  const el = target === 'window' ? window
           : target === 'document' ? document
           : document.body
  const batched = (e) => batch(() => fn(e))
  el.addEventListener(event, batched, opts)
  onCleanup(() => el.removeEventListener(event, batched, opts))
}

// ── Event Delegation ────────────────────────────────────────────────────────
// Instead of addEventListener on every element, delegated events are stored as
// __eventname properties on DOM nodes. A single listener per delegation root
// walks composedPath() and dispatches to matching __eventname handlers.
//
// Delegation roots are registered by mount() — one per mounted component tree.
// This means shadow DOM works correctly (delegate to the shadow root's host
// container, not document.body) and multiple Mesa apps on the same page get
// isolated delegation scopes.
//
// $$delegate(['click', 'input']) is called at module scope by compiled components.
// It records which event types the component uses. mount() then wires them up
// to the container it was given.

const _delegatedEventTypes = new Set()   // all event types across all components
const _delegateRoots = new Map()          // container → Set<eventType>

function _makeDelegatedHandler(root) {
  return function _delegatedHandler(event) {
    const prop = '__' + event.type
    const path = event.composedPath()
    for (let i = 0; i < path.length; i++) {
      const node = path[i]
      if (node === root) break
      const handler = node[prop]
      if (handler) {
        batch(() => handler(event))
        if (event.cancelBubble) break
      }
    }
  }
}

/**
 * Register event types used by a component module. Called at module scope by
 * compiled output — e.g. `$runtime.$$delegate(['click', 'input'])`.
 * Records the types; actual listeners are attached by mount() to its container.
 * Safe to call multiple times with overlapping sets.
 */
export function $$delegate(events) {
  if (!_isBrowser) return
  for (const type of events) {
    _delegatedEventTypes.add(type)
    // Also wire to any roots already registered (hot-reload / late-loaded modules)
    for (const [root, { attached, handler }] of _delegateRoots) {
      if (!attached.has(type)) {
        attached.add(type)
        root.addEventListener(type, handler)
      }
    }
  }
}

/**
 * Register a DOM node as a delegation root for a mounted component tree.
 * Called internally by mount(). Returns a cleanup fn that removes all listeners.
 * @param {Element|ShadowRoot} root
 */
export function _registerDelegateRoot(root) {
  if (!_isBrowser || !root) return () => {}
  if (_delegateRoots.has(root)) return () => {}

  const handler  = _makeDelegatedHandler(root)
  const attached = new Set()

  // Attach listeners for all event types registered so far
  for (const type of _delegatedEventTypes) {
    attached.add(type)
    root.addEventListener(type, handler)
  }

  _delegateRoots.set(root, { handler, attached })

  return () => {
    for (const type of attached) root.removeEventListener(type, handler)
    _delegateRoots.delete(root)
  }
}

/**
 * <mesa:portal to={expr}> — render children into a different DOM node.
 * `getTarget` is a reactive getter — if it changes, the portal moves.
 * `blockFactory` is a makeBlock factory — called once to produce the DOM.
 * Removes the inserted nodes on component destroy.
 */
export function portal(getTarget, blockFactory) {
  if (!_isBrowser) return
  let nodes = []
  let currentTarget = null

  createEffect(() => {
    const target = getTarget()
    if (!target) return
    if (target === currentTarget) return

    // Remove from old target
    nodes.forEach((n) => n.parentNode?.removeChild(n))

    // Build fresh DOM and insert into new target
    const $dom = blockFactory()
    nodes = $dom.nodeType === Node.DOCUMENT_FRAGMENT_NODE
      ? [...$dom.childNodes]
      : [$dom]
    target.appendChild($dom)
    currentTarget = target
  })

  onCleanup(() => nodes.forEach((n) => n.parentNode?.removeChild(n)))
}

// Window property → the event that updates it
const _windowPropEvent = {
  innerWidth:       'resize',
  innerHeight:      'resize',
  outerWidth:       'resize',
  outerHeight:      'resize',
  devicePixelRatio: 'resize',
  scrollX:          'scroll',
  scrollY:          'scroll',
  online:           ['online', 'offline'],
}

/**
 * <mesa:window bind:prop={var}> — sync a window property to a signal.
 * Reads the initial value immediately, then updates on the matching window event.
 * scrollX / scrollY are writable — assigning them calls window.scrollTo().
 */
export function bindWindow(prop, setter) {
  if (!_isBrowser) return
  // Initial read
  const read = () => prop === 'online' ? window.navigator.onLine : window[prop]
  setter(read())

  const events = _windowPropEvent[prop]
  if (!events) return
  const handler = () => setter(read())
  const evList = Array.isArray(events) ? events : [events]
  evList.forEach((ev) => window.addEventListener(ev, handler, { passive: true }))
  onCleanup(() => evList.forEach((ev) => window.removeEventListener(ev, handler)))
}

/**
 * <mesa:head> — insert a DOM fragment into document.head.
 * Removes all inserted nodes on component destroy.
 */
export function addToHead(domOrFragment) {
  if (!_isBrowser) return
  // template() may return a DocumentFragment (multiple children) or a single Element.
  // Collect the nodes before inserting (fragment empties on appendChild).
  const nodes = domOrFragment.nodeType === Node.DOCUMENT_FRAGMENT_NODE
    ? [...domOrFragment.childNodes]
    : [domOrFragment]
  nodes.forEach((n) => document.head.appendChild(n))
  onCleanup(() => nodes.forEach((n) => n.parentNode?.removeChild(n)))
}

/**
 * Debounce an event handler. If `ms` is a function (reactive getter),
 * it is called each time to get the current delay.
 */
export function debounce(fn, ms) {
  let timer
  return function(...args) {
    clearTimeout(timer)
    const delay = typeof ms === 'function' ? ms() : ms
    timer = setTimeout(() => fn.apply(this, args), delay)
  }
}

/**
 * Throttle an event handler. If `ms` is a function (reactive getter),
 * it is called each time to get the current interval.
 */
export function throttle(fn, ms) {
  let last = 0
  return function(...args) {
    const now = Date.now()
    const delay = typeof ms === 'function' ? ms() : ms
    if (now - last >= delay) {
      last = now
      fn.apply(this, args)
    }
  }
}

/**
 * {@attach expr} — element-level lifecycle function.
 *
 * Runs `getFn()` inside a reactive effect, passing the DOM node.
 * The attachment function may return a cleanup — called before re-run and on destroy.
 * Re-runs automatically when any reactive value read inside getFn() changes.
 *
 * @param {Element} el     The DOM element to attach to
 * @param {Function} getFn  () => attachmentFn  — evaluated in reactive context
 */
/**
 * {@attach expr} — element-level lifecycle function.
 *
 * Runs `getFn()` inside a reactive effect, passing the DOM node.
 * The attachment function may return:
 *   - A function: called as cleanup before re-run and on destroy
 *   - A Promise: element kept in DOM until promise resolves (deferred removal)
 *   - Nothing: no cleanup
 *
 * @param {Element} el     The DOM element to attach to
 * @param {Function} getFn  () => attachmentFn — evaluated in reactive context
 */
export function attach(el, getFn) {
  createEffect(() => {
    const fn = getFn()           // tracked — re-runs when expression deps change
    if (!fn) return
    // Run the attachment fn itself untracked so reads inside it (e.g. signal reads
    // in logging helpers) don't subscribe and cause the effect to re-fire.
    const result = untrack(() => fn(el))
    if (typeof result === 'function') {
      // Sync cleanup — runs on element exit, may start an exit animation.
      // If the cleanup returns a Promise, store it on the element so _removeBlock
      // can hold the DOM alive until the animation completes.
      onCleanup(() => {
        const exitResult = result()
        if (exitResult && typeof exitResult.then === 'function') {
          // Mark element as exiting — _removeBlock will re-insert it if needed
          // and wait for this Promise before doing final DOM removal.
          el.__mesa_exit = exitResult
        }
      })
    } else if (result && typeof result.then === 'function') {
      // attachment fn itself returned a Promise (less common pattern)
      el.__mesa_exit = result
    }
  })
}

/**
 * Apply component-level attachments from $option.attachments.
 */
export function applyAttachments(el, fns) {
  if (!fns?.length) return
  for (const fn of fns) {
    createEffect(() => {
      if (!fn) return
      const result = untrack(() => fn(el))
      if (typeof result === 'function') onCleanup(result)
      else if (result && typeof result.then === 'function') {
        onCleanup(() => {
          const parent = el.parentNode
          if (!parent) return
          result.then(() => { if (parent.contains(el)) parent.removeChild(el) })
        })
      }
    })
  }
}

/**
 * $.transition(fn) — wrap a state change in the View Transitions API.
 * Falls back to a plain batch() in browsers without View Transitions support.
 *
 *   $.transition(() => show = !show)
 *   $.transition(() => { tab = 'home'; items = newItems })
 */
export function transition(fn) {
  if (_isBrowser && document.startViewTransition) {
    document.startViewTransition(() => batch(fn))
  } else {
    batch(fn)
  }
}

/**
 * entrance({ in: inFn, out: outFn }) — enter/exit animation attachment factory.
 *
 * Designed to work with Motion's animate() or any Web Animations API call:
 *
 *   import { animate } from 'motion'
 *
 *   const fade = entrance({
 *     in:  (el) => animate(el, { opacity: [0, 1] }, { duration: 0.3 }),
 *     out: (el) => animate(el, { opacity: [1, 0] }, { duration: 0.3 }).finished
 *   })
 *
 *   {#if show}
 *     <div {@attach fade}>content</div>
 *   {/if}
 *
 * If `out` returns a Promise, the element stays in the DOM until it resolves.
 *
 * @param {{ in?: Function, out?: Function }} opts
 * @returns {Function}  Attachment function  (el) => cleanup
 */
export function entrance({ in: inFn, out: outFn } = {}) {
  return (el) => {
    inFn?.(el)
    if (outFn) return () => outFn(el)
  }
}

/**
 * CSS transition primitives — zero-dependency animations using CSS transitions.
 * Each returns an entrance()-compatible attachment function.
 * No WAAPI, no external library, works everywhere.
 *
 * $.fade({ duration?, easing? })
 * $.slide({ duration?, easing? })       — height collapse/expand
 * $.fly({ x?, y?, duration?, easing? }) — translate + fade
 *
 * Usage:
 *   const fade = $.fade()
 *   {#if show}<div {@attach fade}>content</div>{/if}
 */

function _cssTransition(el, inStyles, outStyles, { duration = 200, easing = 'ease' } = {}) {
  // Apply styles instantly then transition to target
  const applyInstant = (styles) => Object.assign(el.style, styles)
  const applyTransition = (styles) => {
    el.style.transition = `all ${duration}ms ${easing}`
    Object.assign(el.style, styles)
  }
  const cleanup = () => { el.style.transition = '' }

  return {
    enter() {
      applyInstant(inStyles.from)
      // Force layout so the browser registers the from state before transitioning
      void el.offsetHeight
      applyTransition(inStyles.to)
      const done = () => { cleanup(); el.removeEventListener('transitionend', done) }
      el.addEventListener('transitionend', done, { once: true })
    },
    exit() {
      return new Promise(resolve => {
        applyTransition(outStyles)
        const done = () => { cleanup(); resolve() }
        el.addEventListener('transitionend', done, { once: true })
        // Fallback in case transitionend doesn't fire (display:none, etc.)
        setTimeout(resolve, duration + 50)
      })
    }
  }
}

export function fade({ duration = 200, easing = 'ease' } = {}) {
  return entrance({
    in(el) {
      const t = _cssTransition(el,
        { from: { opacity: '0' }, to: { opacity: '' } },
        { opacity: '0' },
        { duration, easing }
      )
      t.enter()
    },
    out(el) {
      const t = _cssTransition(el,
        { from: { opacity: '1' }, to: { opacity: '1' } },
        { opacity: '0' },
        { duration, easing }
      )
      return t.exit()
    }
  })
}

export function slide({ duration = 250, easing = 'ease' } = {}) {
  return entrance({
    in(el) {
      // Measure natural height then animate from 0
      const h = el.scrollHeight + 'px'
      el.style.overflow = 'hidden'
      el.style.height = '0'
      el.style.opacity = '0'
      void el.offsetHeight
      el.style.transition = `height ${duration}ms ${easing}, opacity ${duration}ms ${easing}`
      el.style.height = h
      el.style.opacity = ''
      const done = () => {
        el.style.height = ''
        el.style.overflow = ''
        el.style.transition = ''
        el.removeEventListener('transitionend', done)
      }
      el.addEventListener('transitionend', done, { once: true })
    },
    out(el) {
      return new Promise(resolve => {
        const h = el.scrollHeight + 'px'
        el.style.height = h
        el.style.overflow = 'hidden'
        void el.offsetHeight
        el.style.transition = `height ${duration}ms ${easing}, opacity ${duration}ms ${easing}`
        el.style.height = '0'
        el.style.opacity = '0'
        const done = () => {
          el.style.transition = ''
          resolve()
        }
        el.addEventListener('transitionend', done, { once: true })
        setTimeout(resolve, duration + 50)
      })
    }
  })
}

export function fly({ x = 0, y = -12, duration = 220, easing = 'ease-out' } = {}) {
  const fromTransform = `translate(${x}px, ${y}px)`
  return entrance({
    in(el) {
      el.style.opacity = '0'
      el.style.transform = fromTransform
      void el.offsetHeight
      el.style.transition = `opacity ${duration}ms ${easing}, transform ${duration}ms ${easing}`
      el.style.opacity = ''
      el.style.transform = ''
      const done = () => { el.style.transition = ''; el.removeEventListener('transitionend', done) }
      el.addEventListener('transitionend', done, { once: true })
    },
    out(el) {
      return new Promise(resolve => {
        el.style.transition = `opacity ${duration}ms ${easing}, transform ${duration}ms ${easing}`
        el.style.opacity = '0'
        el.style.transform = fromTransform
        const done = () => { el.style.transition = ''; resolve() }
        el.addEventListener('transitionend', done, { once: true })
        setTimeout(resolve, duration + 50)
      })
    }
  })
}

export function makeEmitter($option) {
  // $emit('click', data) calls the onclick prop if provided.
  // The prop name is 'on' + capitalized event name — e.g. 'click' → 'onclick'.
  // Both camelCase (onClick) and lowercase (onclick) are checked.
  return (name, detail) => {
    const prop = $option.props?.[`on${name}`] ?? $option.props?.[`on${name[0].toUpperCase()}${name.slice(1)}`]
    if (typeof prop !== 'function') return
    prop(detail)
  }
}
export function mergeEvents(...cbs) {
  cbs = cbs.filter(Boolean)
  if (!cbs.length) return null
  if (cbs.length === 1) return cbs[0]
  return (e) => cbs.forEach((cb) => cb(e))
}
export function mergeAllEvents($events, local) {
  const result = Object.assign({}, $events)
  for (const e in local) {
    result[e] = result[e] ? mergeEvents(result[e], local[e]) : local[e]
  }
  return result
}

/**
 * Creates a delegated event system on a component's root node(s).
 *
 * @param {Node|Node[]} root  Component root — a fragment (pre-insertion, children intact),
 *                            a single element, or an explicit array of element nodes.
 *                            The compiler should prefer passing an explicit node array when
 *                            the fragment may already have been inserted into the DOM.
 */
export function makeRootEvent(root) {
  if (!_isBrowser) return () => {} // no-op on server — no DOM events
  const events = {},
    nodes = []

  if (Array.isArray(root)) {
    // Explicit array — compiler passed first/last or a collected node list.
    nodes.push(...root)
  } else if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    // Fragment: collect element children. Works correctly pre-insertion (children
    // are present) and post-insertion (children have moved — warn and bail cleanly).
    let n = root.firstElementChild
    if (!n) {
      // Fragment is empty — it was already inserted before makeRootEvent was called.
      // Event delegation will be a no-op. The compiler should call makeRootEvent
      // before returning $dom from the init function to avoid this.
      console.warn(
        '@frontierjs/mesa-runtime makeRootEvent(): fragment has no children — was it already inserted? Pass an explicit node array instead.'
      )
    }
    while (n) {
      nodes.push(n)
      n = n.nextElementSibling
    }
  } else {
    nodes.push(root)
  }

  onCleanup(() => {
    for (const name in events) nodes.forEach((n) => n.removeEventListener(name, events[name]))
  })

  return (target, eventName, cb) => {
    const key = `_$$${eventName}`
    if (!events[eventName]) {
      events[eventName] = ($e) => {
        const top = $e.currentTarget
        let el = $e.target
        while (el) {
          el[key]?.($e)
          if (el === top || $e.cancelBubble) break
          el = el.parentNode
        }
      }
      nodes.forEach((n) => n.addEventListener(eventName, events[eventName]))
    }
    target[key] = cb
  }
}

export function makeComponent(init) {
  return ($option = {}) => {
    const ctxMap = new Map()
    _contextStack.push(ctxMap)

    const prevOwner = _owner
    const prevListener = _listener
    const prevMount = _mountList
    const prevProps = _propRegistry

    const rootNode = {
      _fn: null,
      _deps: new Set(),
      _cleanups: [],
      _children: [],
      _owner: null,
      _notify() {},
      _run() {}
    }

    _owner = rootNode
    _listener = null
    _mountList = []
    _propRegistry = new Map() // filled by makeExternalProperty calls inside init

    let $dom
    try {
      $dom = init($option)
    } finally {
      _owner = prevOwner
      _listener = prevListener
      _contextStack.pop()
    }

    // Capture before restoring so $push/$apply close over this instance's map.
    const registry = _propRegistry
    _propRegistry = prevProps
    const mountList = _mountList
    _mountList = prevMount

    const component = {
      $dom,

      /**
       * Map<name, { get, set }> — one entry per `export let` prop.
       * Parents use this to wire the child→parent direction of bind:.
       *   createEffect(() => parentSignal.set(instance.$props.get('qty').get()))
       */
      $props: registry,

      /**
       * Push specific prop values into the child's reactive signals.
       * Called by the parent when a bound signal changes (parent→child).
       *
       * @param {object} props  { [propName]: newValue, … }
       */
      $push(props) {
        if (!props) return
        batch(() => {
          for (const name in props) {
            const p = registry.get(name)
            if (p) p.set(props[name])
          }
        })
      },

      /**
       * Re-sync all registered props from a plain props object.
       * Called by the parent when it re-renders and passes a new $option.props.
       * Only updates props that are actually registered (i.e. `export let`).
       *
       * @param {object} [props]  Defaults to $option.props ?? $option.
       */
      $apply(props) {
        const source = props ?? $option.props ?? $option
        if (!source) return
        batch(() => {
          for (const [name, p] of registry) {
            if (name in source) p.set(source[name])
          }
        })
      },

      destroy() {
        _disposeNode(rootNode, false)
        rootNode._cleanups = []
      }
    }

    // Flush mount callbacks. If a callback returns a function, register it as
    // a cleanup on the component's root node (runs on destroy).
    _resolved.then(() => {
      for (const fn of mountList) {
        const result = _safeCall(fn)
        if (typeof result === 'function') rootNode._cleanups.push(result)
      }

      // Apply parent-provided attachments to the component's root DOM element.
      // Attachments are passed via $option.attachments — an array of (el) => cleanup fns.
      if ($option.attachments?.length && $dom) {
        const el = $dom.nodeType === Node.DOCUMENT_FRAGMENT_NODE
          ? $dom.firstChild
          : $dom
        if (el) applyAttachments(el, $option.attachments)
      }
    })
    return component
  }
}

export function mount(label, component, option) {
  if (!_isBrowser)
    throw new Error(
      '@frontierjs/mesa-runtime: mount() called in a non-browser environment. ' +
        'Use renderToString() for SSR.'
    )
  if (!label.parentNode)
    throw new Error(
      '@frontierjs/mesa-runtime mount(): anchor node has no parentNode — ' +
        'attach the anchor comment to the DOM before calling mount()'
    )

  // Register delegation root (scopes event delegation to container)
  const delegateRoot = option?.root ?? label.parentNode
  const cleanupDelegation = _registerDelegateRoot(delegateRoot)

  // Register style root — if a shadow root is provided, styles are injected
  // there via adoptedStyleSheets instead of document.head
  const styleRoot = option?.root instanceof ShadowRoot ? option.root : null
  const cleanupStyles = styleRoot ? _registerStyleRoot(styleRoot) : () => {}

  const anchor = document.createComment('')
  label.parentNode.insertBefore(anchor, label.nextSibling)
  component(anchor, option?.props ?? {}, null)
  return {
    $dom: anchor,
    find(sel) { return anchor.parentNode?.querySelector(sel) },
    destroy() {
      anchor.remove()
      cleanupDelegation()
      cleanupStyles()
    }
  }
}

export function mountStatic(label, component, option) {
  if (!_isBrowser)
    throw new Error(
      '@frontierjs/mesa-runtime: mountStatic() called in a non-browser environment. ' +
        'Use renderToString() for SSR.'
    )
  const anchor = document.createComment('')
  label.appendChild(anchor)
  component(anchor, option?.props ?? {}, null)
  return { $dom: anchor }
}

export function makeBlock(fr, fn) {
  return (v) => {
    // fr may be a raw DOM fragment or a template() factory function.
    // Guard: if fr has no cloneNode and isn't a function, emit a clear error.
    let $dom
    if (typeof fr === 'function') {
      $dom = fr()
    } else if (fr && typeof fr.cloneNode === 'function') {
      $dom = fr.cloneNode(true)
    } else {
      // fr is null/undefined/invalid — log and return empty fragment
      if (typeof console !== 'undefined') {
        console.error('[Mesa] makeBlock: invalid template ref', fr,
          '— expected a template factory function or DOM node with cloneNode.')
      }
      return document.createDocumentFragment()
    }
    // svgToFragment() returns a DocumentFragment containing a single SVG element.
    // The compiler emits `let el0 = $parentElement` (no .firstChild descent) which
    // works fine for HTML fragments but breaks for SVG since DocumentFragment lacks
    // setAttribute. Unwrap single-child SVG fragments so fn receives the element.
    const SVG_NS = 'http://www.w3.org/2000/svg'
    const $el = ($dom && $dom.nodeType === 11 /* DOCUMENT_FRAGMENT_NODE */ &&
                 $dom.childNodes.length === 1 &&
                 $dom.firstChild?.namespaceURI === SVG_NS)
      ? $dom.firstChild
      : $dom
    fn?.($el, v)
    return $dom
  }
}
export function makeBlockBound(fr, fn) {
  const parentOwner = _owner
  return () => {
    const $dom = typeof fr === 'function' ? fr() : fr.cloneNode(true)
    const prevO = _owner
    const blockNode = {
      _fn: null,
      _deps: new Set(),
      _cleanups: [],
      _children: [],
      _owner: parentOwner,
      _notify() {},
      _run() {}
    }
    if (parentOwner) parentOwner._children.push(blockNode)
    _owner = blockNode
    try {
      fn($dom)
      return $dom
    } finally {
      _owner = prevO
    }
  }
}
export const attachBlock = (anchor, $dom) => {
  if (!$dom) return
  insertAfter(anchor, $dom.$dom ?? $dom)
}
export const addBlock = (parent, $dom) => {
  if (!$dom) return
  parent.appendChild($dom.$dom ?? $dom)
}
export const insertBlock = (anchor, $dom) => {
  if (!$dom) return
  anchor.parentNode.insertBefore($dom.$dom ?? $dom, anchor)
}

export const eachDefaultKey = (item) => item

/**
 * $$virtualEach — windowed virtual list renderer.
 *
 * Renders only the visible rows in a scrollable container plus an overscan
 * buffer, with spacer divs above/below to maintain correct scrollbar height.
 *
 * Requirements:
 *   - The anchor must be inside a fixed-height, overflow-y:auto/scroll container
 *   - All rows must have the same height (measures the first rendered item)
 *
 * @param {Comment}  anchor     — template anchor comment node
 * @param {Function} getArray   — reactive getter returning the full array
 * @param {Function} keyFn      — (item, i) => key, or null for index keying
 * @param {Function} makeRow    — makeBlock factory for one row
 */
export function $$virtualEach(anchor, getArray, keyFn, makeRow) {
  if (!_isBrowser) return

  const OVERSCAN    = 5     // extra rows to render above and below viewport
  const DEFAULT_ROW = 40    // fallback row height (px) before measurement
  // anchor is the scroll container element itself — rows render INSIDE it
  const parent = anchor
  if (!parent) return

  // The container IS the scroller (overflow:auto/scroll set by the user)
  // Find the nearest scrollable ancestor
  function getScroller() {
    // Check the container itself first, then walk up
    let el = parent
    while (el && el !== document.body) {
      const s = typeof getComputedStyle !== 'undefined' ? getComputedStyle(el) : { overflowY: '' }
      if (s.overflowY === 'auto' || s.overflowY === 'scroll') return el
      el = el.parentElement
    }
    return window
  }

  // Spacer elements maintain scroll height without rendering DOM
  const topSpacer = document.createElement('div')
  const botSpacer = document.createElement('div')
  topSpacer.style.cssText = 'pointer-events:none;'
  botSpacer.style.cssText = 'pointer-events:none;'
  // Spacers go inside the container, framing the rendered row range
  parent.appendChild(topSpacer)
  parent.appendChild(botSpacer)

  let rowHeight  = DEFAULT_ROW
  let measured   = false
  let renderedBlocks = new Map()  // key → { node, item }
  let prevStart  = -1
  let prevEnd    = -1
  let scroller   = null

  function measure(node) {
    if (measured) return
    const h = node.getBoundingClientRect?.()?.height
    if (h && h > 0) { rowHeight = h; measured = true }
  }

  function getScrollerMetrics() {
    if (!scroller) scroller = getScroller()
    if (scroller === window) {
      return { scrollTop: window.scrollY, viewHeight: window.innerHeight }
    }
    return {
      scrollTop: scroller.scrollTop,
      viewHeight: scroller.clientHeight,
    }
  }

  function render(arr) {
    if (!arr || arr.length === 0) {
      topSpacer.style.height = '0px'
      botSpacer.style.height = '0px'
      renderedBlocks.forEach(b => b.node.remove())
      renderedBlocks.clear()
      prevStart = prevEnd = -1
      return
    }

    const total = arr.length
    const { scrollTop, viewHeight } = getScrollerMetrics()

    // In test environments (happy-dom), viewHeight may be 0 — render initial window
    const effectiveViewHeight = viewHeight > 0 ? viewHeight : rowHeight * 10
    const visStart = Math.floor(scrollTop / rowHeight)
    const visEnd   = Math.ceil((scrollTop + effectiveViewHeight) / rowHeight)
    const start    = Math.max(0, visStart - OVERSCAN)
    const end      = Math.min(total, visEnd + OVERSCAN)

    if (start === prevStart && end === prevEnd) return
    prevStart = start; prevEnd = end

    // Keys for the new window
    const newKeys = new Set()
    for (let i = start; i < end; i++) {
      const item = arr[i]
      newKeys.add(keyFn ? keyFn(item, i) : i)
    }

    // Remove rows that scrolled out
    renderedBlocks.forEach((b, key) => {
      if (!newKeys.has(key)) {
        b.node.remove()
        renderedBlocks.delete(key)
      }
    })

    // Render rows in window — insert in order before botSpacer
    const frag = document.createDocumentFragment()
    for (let i = start; i < end; i++) {
      const item = arr[i]
      const key  = keyFn ? keyFn(item, i) : i
      if (!renderedBlocks.has(key)) {
        // Create item/index signals — same as $$eachBlock so compiled block
        // receives row (a getter function) and index getter.
        const [getItem]  = createSignal(item)
        const [getIndex] = createSignal(i)
        // makeRow() returns a factory; call it to get the DOM.
        // The factory calls fn($parentElement, getItem, getIndex) internally via makeBlock.
        // makeBlock factory takes a single value arg (the item getter)
        const $dom = makeRow(getItem)
        const node = $dom?.$dom ?? $dom
        if (node) frag.appendChild(node)
        renderedBlocks.set(key, { node, item })
        if (!measured && node?.getBoundingClientRect) measure(node)
      }
    }
    botSpacer.parentNode?.insertBefore(frag, botSpacer)

    // Update spacers
    topSpacer.style.height = (start * rowHeight) + 'px'
    botSpacer.style.height = Math.max(0, (total - end) * rowHeight) + 'px'
  }

  // Wire scroll listener
  let rafId = 0
  let detachScroll = null
  function onScroll() {
    if (rafId) return
    rafId = requestAnimationFrame(() => {
      rafId = 0
      render(getArray())
    })
  }

  function attachScroll() {
    if (detachScroll) return  // already attached
    scroller = getScroller()
    const target = scroller === window ? window : scroller
    target.addEventListener('scroll', onScroll, { passive: true })
    detachScroll = () => target.removeEventListener('scroll', onScroll)
  }

  // Reactive effect — re-renders when array changes
  const disposeEffect = createEffect(() => {
    const arr = getArray()
    render(arr)
    // Attach scroll listener lazily once the container is in the live DOM.
    // On first render the element is typically in a detached fragment (inside
    // makeBlock/ifBlock), so parent.isConnected is false. Retry via rAF —
    // by then ifBlock will have inserted the element into the live DOM.
    if (!detachScroll) {
      if (parent.isConnected) {
        attachScroll()
      } else {
        requestAnimationFrame(() => {
          if (!detachScroll && parent.isConnected) {
            attachScroll()
            render(getArray())  // re-render with real viewHeight now available
          }
        })
      }
    }
  })

  // Cleanup on component destroy via $onCleanup / owner
  const cleanup = () => {
    disposeEffect()
    detachScroll?.()
    topSpacer.remove()
    botSpacer.remove()
    renderedBlocks.forEach(b => { b.anchor?.remove(); b.node?.remove() })
    renderedBlocks.clear()
  }
  if (_owner) {
    _owner._cleanups = _owner._cleanups ?? []
    _owner._cleanups.push(cleanup)
  }
}

export function $$eachBlock(anchor, mode, getArray, keyFn, makeItem, elseBlock) {
  if (!_isBrowser)
    throw new Error(
      '@frontierjs/mesa-runtime: $$eachBlock() called in a non-browser environment. ' +
        'Use the Mesa SSR compiler target.'
    )
  if (!anchor) {
    console.warn('@frontierjs/mesa-runtime $$eachBlock(): anchor is null — check compiled output')
    return
  }

  const getParent  = () => mode === 1 ? anchor : anchor.parentNode
  const insertBefore = mode === 0 ? anchor : null
  const outerOwner = _owner

  // blocks: Map<key, block>
  // prevKeys: key[] — the last rendered key order, parallel to the DOM order
  let blocks   = new Map()
  let prevKeys = []
  let elseNode      = null
  let elseNodeFirst = null   // first DOM node of the else block (for removal)
  let elseNodeLast  = null   // last DOM node of the else block

  const _showElse = () => {
    if (!elseBlock || elseNode) return
    const parent = getParent()
    if (!parent) return  // anchor detached (e.g. inside a swapped-out {#if} branch)
    elseNode = elseBlock()
    const $d = elseNode.$dom ?? elseNode
    if ($d.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      elseNodeFirst = $d.firstChild
      elseNodeLast  = $d.lastChild
    } else {
      elseNodeFirst = elseNodeLast = $d
    }
    insertBefore ? parent.insertBefore($d, insertBefore) : parent.appendChild($d)
  }
  const _hideElse = () => {
    if (!elseNode) return
    removeElements(elseNodeFirst, elseNodeLast)
    elseNode?.dispose?.()
    elseNode = elseNodeFirst = elseNodeLast = null
  }

  // ── _makeBlock ────────────────────────────────────────────────────────────
  // Create a new reactive block for one array item. Does NOT insert into DOM.
  const _makeBlock = (item, index) => {
    const [getItem, setItem]   = createSignal(item)
    const [getIndex, setIndex] = createSignal(index)
    const prevOwner = _owner
    const blockOwner = {
      _fn: null, _deps: new Set(), _cleanups: [], _children: [],
      _owner: outerOwner, _notify() {}, _run() {}
    }
    if (outerOwner) outerOwner._children.push(blockOwner)
    _owner = blockOwner
    let result
    try { result = makeItem(getItem, getIndex) }
    finally { _owner = prevOwner }
    const $dom  = result?.$dom ?? result
    const isFrag = $dom?.nodeType === Node.DOCUMENT_FRAGMENT_NODE
    // Capture first/last BEFORE any insertion — fragments empty once inserted
    const $domFirst = isFrag ? $dom.firstChild : $dom
    const $domLast  = isFrag ? $dom.lastChild  : $dom
    return {
      $dom, $domFirst, $domLast,
      _item: item,
      rebind: (newItem, newIdx) => {
        // Always update signals first — effects re-run from the signal, not the
        // closure variable. The compiler no longer emits raw-assignment rebinds
        // for plain item/index; only destructure patterns return a custom rebind.
        setItem(newItem)
        setIndex(newIdx)
        result?.rebind?.(newItem, newIdx)
      },
      dispose() { _disposeNode(blockOwner, true) }
    }
  }

  // ── _insertBlock ──────────────────────────────────────────────────────────
  // Insert a block's DOM before `before` (null = append).
  const _insertBlock = (block, before) => {
    const parent = getParent()
    if (!parent) return  // anchor detached (branch disposed by ifBlock)
    const $d = block.$dom
    // Fragment may have been emptied by a prior insertion — use $domFirst
    const node = ($d?.nodeType === Node.DOCUMENT_FRAGMENT_NODE && !$d.firstChild)
      ? block.$domFirst
      : ($d ?? block.$domFirst)
    before ? parent.insertBefore(node, before) : parent.appendChild(node)
  }

  // ── _moveBlock ────────────────────────────────────────────────────────────
  // Move all DOM nodes in a block before `before`.
  // Checks position first — bail if already correct.
  // Explicit removeChild before insertBefore for cross-env safety.
  const _moveBlock = (block, before) => {
    const parent = getParent()
    if (block.$domFirst &&
        block.$domFirst.parentNode === parent &&
        block.$domLast.nextSibling === before) return
    if (block.$domFirst === block.$domLast) {
      const node = block.$domFirst
      if (node.parentNode) node.parentNode.removeChild(node)
      parent.insertBefore(node, before)
      return
    }
    // Multi-node: snapshot before any mutation
    const nodes = []
    let node = block.$domFirst
    while (true) {
      nodes.push(node)
      if (node === block.$domLast) break
      node = node.nextSibling
    }
    for (const n of nodes) {
      if (n.parentNode) n.parentNode.removeChild(n)
      parent.insertBefore(n, before)
    }
  }

  createEffect(() => {
    const array  = getArray() || []
    const newLen = array.length

    // ── Fast path: clear ────────────────────────────────────────────────────
    if (newLen === 0) {
      if (blocks.size > 0) {
        // Dispose reactive owners FIRST so their effects unsubscribe before
        // any other signals in this batch fire (e.g. selected = 0 after clear).
        // Without this, class:danger effects on all 10k rows re-run unnecessarily.
        for (const [, b] of blocks) b.dispose()
        blocks.clear()
        // Remove only the {#each} items — NOT parent.textContent = '' which would
        // destroy sibling anchors (e.g. a {#if} anchor after this {#each}).
        const parent = getParent()
        if (mode === 0) {
          // parent can be null if the {#each} anchor was inside an {#if} branch
          // that got swapped out before this effect ran (async + branch switch).
          if (parent) {
            // Remove all nodes that appear before the anchor — these are the {#each} items.
            // Sibling nodes after the anchor (other blocks' anchors) are left untouched.
            while (anchor.previousSibling) {
              parent.removeChild(anchor.previousSibling)
            }
          }
        } else {
          anchor.textContent = ''
        }
      }
      prevKeys = []
      _showElse()
      return
    }
    _hideElse()

    const newKeys = array.map((item, i) => keyFn(item, i))
    const oldLen  = prevKeys.length

    // Duplicate key check — fires in dev builds or when window.__MESA_DEV__ is set.
    // Duplicate keys corrupt the reconciler (Map overwrites, blocks claimed twice).
    if (typeof process === 'undefined' || process?.env?.NODE_ENV !== 'production') {
      const seen = new Set()
      for (let i = 0; i < newKeys.length; i++) {
        const k = newKeys[i]
        if (seen.has(k)) {
          console.warn(
            `[Mesa] {#each} duplicate key "${k}" at index ${i}. ` +
            `Each item must have a unique key — use a unique id instead of the value itself.`
          )
          break  // one warning is enough per render
        }
        seen.add(k)
      }
    }

    // ── Fast path: first render ─────────────────────────────────────────────
    if (oldLen === 0) {
      for (let i = 0; i < newLen; i++) {
        const b = _makeBlock(array[i], i)
        _insertBlock(b, insertBefore)
        blocks.set(newKeys[i], b)
      }
      prevKeys = newKeys
      return
    }

    // Build ordered array of old blocks for scanning
    const oldBlocks = new Array(oldLen)
    for (let i = 0; i < oldLen; i++) oldBlocks[i] = blocks.get(prevKeys[i])

    // newBlocks[i] = the block that should occupy new position i
    const newBlocks = new Array(newLen)

    // ── Head scan ───────────────────────────────────────────────────────────
    // Skip matching keys at the start — these blocks are already in place
    let j = 0
    while (j < oldLen && j < newLen && prevKeys[j] === newKeys[j]) {
      const b = oldBlocks[j]
      if (array[j] !== b._item) { b._item = array[j]; b.rebind?.(array[j], j) }
      newBlocks[j] = b
      j++
    }

    // ── Tail scan ───────────────────────────────────────────────────────────
    // Skip matching keys at the end — these blocks are already in place
    let a_end = oldLen - 1
    let b_end = newLen - 1
    while (a_end >= j && b_end >= j && prevKeys[a_end] === newKeys[b_end]) {
      const b = oldBlocks[a_end]
      if (array[b_end] !== b._item) { b._item = array[b_end]; b.rebind?.(array[b_end], b_end) }
      newBlocks[b_end] = b
      a_end--
      b_end--
    }

    // ── Destroy removed blocks ──────────────────────────────────────────────
    // Any old key not present in the new key set is removed now.
    // Build a Set of new keys for O(1) lookup.
    const newKeySet = new Set(newKeys)
    for (let i = j; i <= a_end; i++) {
      const key = prevKeys[i]
      if (!newKeySet.has(key)) {
        removeElements(oldBlocks[i].$domFirst, oldBlocks[i].$domLast)
        oldBlocks[i].dispose()
        blocks.delete(key)
      }
    }

    // ── Trivial: only additions ─────────────────────────────────────────────
    if (j > a_end) {
      // All old blocks matched — just insert new ones between j and b_end
      // Insert before the first tail block (or the anchor)
      const beforeNode = newBlocks[b_end + 1]?.$domFirst ?? insertBefore
      for (let i = j; i <= b_end; i++) {
        const b = _makeBlock(array[i], i)
        _insertBlock(b, beforeNode)
        blocks.set(newKeys[i], b)
        newBlocks[i] = b
      }
      blocks = new Map(newKeys.map((k, i) => [k, newBlocks[i]]))
      prevKeys = newKeys
      return
    }

    // ── Trivial: only removals ──────────────────────────────────────────────
    if (j > b_end) {
      // All new blocks matched — removals already handled above
      blocks = new Map(newKeys.map((k, i) => [k, newBlocks[i]]))
      prevKeys = newKeys
      return
    }

    // ── Middle reconciliation with LIS ──────────────────────────────────────
    // Handles the general case: the middle section [j..b_end] of the new array
    // may contain moves, additions, and removals.
    //
    // Build a map: old_key → old_index (within the middle section)
    const oldKeyIndex = new Map()
    for (let i = j; i <= a_end; i++) oldKeyIndex.set(prevKeys[i], i - j)

    // sources[i] = 1-based old index of the block now at new middle position i
    //              0 = new block (no old counterpart)
    const midLen  = b_end - j + 1
    const sources = new Int32Array(midLen)
    let moved   = false
    let pos     = 0
    let patched = 0

    for (let i = 0; i < midLen; i++) {
      const key     = newKeys[j + i]
      const oldIdx  = oldKeyIndex.get(key)
      if (oldIdx !== undefined) {
        const b = oldBlocks[j + oldIdx]
        if (array[j + i] !== b._item) { b._item = array[j + i]; b.rebind?.(array[j + i], j + i) }
        newBlocks[j + i] = b
        sources[i] = oldIdx + 1       // 1-based
        if (pos > oldIdx) moved = true
        else pos = oldIdx
        patched++
      }
      // sources[i] stays 0 for new blocks
    }

    // ── LIS — find which blocks DON'T need moving ───────────────────────────
    const seq = moved ? _lis(sources) : null
    let seqJ  = seq ? seq.length - 1 : -1

    // ── Right-to-left placement pass ────────────────────────────────────────
    // Process from b_end back to j.
    // `before` = first node of the block to our right (or anchor).
    let before = newBlocks[b_end + 1]?.$domFirst ?? insertBefore

    for (let i = midLen - 1; i >= 0; i--) {
      const newPos = j + i
      if (sources[i] === 0) {
        // New block — create and insert
        const b = _makeBlock(array[newPos], newPos)
        _insertBlock(b, before)
        blocks.set(newKeys[newPos], b)
        newBlocks[newPos] = b
        before = b.$domFirst
      } else if (seq && seqJ >= 0 && i === seq[seqJ]) {
        // In LIS — already in correct relative position, no DOM move needed
        seqJ--
        before = newBlocks[newPos].$domFirst
      } else {
        // Not in LIS — move to correct position
        _moveBlock(newBlocks[newPos], before)
        before = newBlocks[newPos].$domFirst
      }
    }

    blocks   = new Map(newKeys.map((k, i) => [k, newBlocks[i]]))
    prevKeys = newKeys
  })
}

// ── LIS (Longest Increasing Subsequence) ─────────────────────────────────────
// Returns the indices of the LIS within `arr` (1-based values, 0 = skip).
// Used by $$eachBlock to find the minimum set of DOM moves needed.
// O(n log n) — adapted from Ripple / Vue 3 / Inferno.

let _lisResult = new Int32Array(0)
let _lisP      = new Int32Array(0)
let _lisMaxLen = 0

function _lis(arr) {
  const len = arr.length
  if (len > _lisMaxLen) {
    _lisMaxLen = len
    _lisResult = new Int32Array(len)
    _lisP      = new Int32Array(len)
  }

  let k = 0
  for (let i = 0; i < len; i++) {
    const arrI = arr[i]
    if (arrI === 0) continue

    const j = _lisResult[k]
    if (arr[j] < arrI) {
      _lisP[i] = j
      _lisResult[++k] = i
      continue
    }

    // Binary search for insertion point
    let u = 0, v = k
    while (u < v) {
      const c = (u + v) >> 1
      if (arr[_lisResult[c]] < arrI) u = c + 1
      else v = c
    }

    if (arrI < arr[_lisResult[u]]) {
      if (u > 0) _lisP[i] = _lisResult[u - 1]
      _lisResult[u] = i
    }
  }

  // Reconstruct sequence
  let u = k + 1
  const seq = new Int32Array(u)
  let v = _lisResult[u - 1]
  while (u-- > 0) {
    seq[u] = v
    v = _lisP[v]
    _lisResult[u] = 0   // reset for next call
  }
  return seq
}

export function ifBlock(anchor, condFn, blocks, noAnchor) {
  if (!_isBrowser)
    throw new Error(
      '@frontierjs/mesa-runtime: ifBlock() called in a non-browser environment. ' +
        'Use the Mesa SSR compiler target.'
    )
  if (!anchor) {
    console.warn('@frontierjs/mesa-runtime ifBlock(): anchor is null — check compiled output')
    return
  }
  let current = -1,
    currentFirst = null,
    currentLast = null,
    currentBranchNode = null   // owner node for the active branch's effects

  const _removeBlock = () => {
    if (currentFirst == null) return
    // Before disposing, capture the parent and sibling for potential re-insertion.
    const parent = noAnchor ? anchor : anchor.parentNode
    const afterNode = noAnchor ? null : currentLast?.nextSibling ?? anchor

    // Dispose the branch owner — kills all effects ($$eachBlock, bindText, etc.)
    // created inside this branch before removing its DOM.
    // NOTE: attach cleanup runs here and may set el.__mesa_exit on elements
    // that have exit animations in flight.
    if (currentBranchNode) {
      _disposeNode(currentBranchNode, true)
      currentBranchNode = null
    }

    // Collect any elements with pending exit animations (__mesa_exit Promise).
    // Walk the full subtree between currentFirst and currentLast.
    const exitingEls = []
    if (parent) {
      const collectExiting = (node) => {
        if (!node || node.nodeType !== 1) return  // elements only
        if (node.__mesa_exit) exitingEls.push({ el: node, promise: node.__mesa_exit })
        for (let child = node.firstElementChild; child; child = child.nextElementSibling) {
          collectExiting(child)
        }
      }
      let node = currentFirst
      const stop = currentLast ? currentLast.nextSibling : anchor
      while (node && node !== stop) {
        collectExiting(node)
        node = node.nextSibling
      }
    }

    // Remove the branch DOM
    removeElements(currentFirst, noAnchor ? null : currentLast)
    currentFirst = currentLast = null

    // Re-insert exiting elements and schedule their removal after animation
    for (const { el, promise } of exitingEls) {
      el.__mesa_exit = null
      if (parent) {
        parent.insertBefore(el, afterNode)
        promise.then(() => { if (el.parentNode) el.parentNode.removeChild(el) })
      }
    }
  }

  createEffect(() => {
    const parent = noAnchor ? anchor : anchor.parentNode
    if (!parent) return

    const next = condFn() ?? null
    if (next === current) return
    _removeBlock()
    current = next
    if (next == null || !blocks[next]) return

    // Create a branch-scoped owner so all effects (eachBlock, bindText…)
    // are children of this node and get disposed when the branch is removed.
    const branchNode = {
      _fn: null,
      _deps: new Set(),
      _cleanups: [],
      _children: [],
      _owner: _owner,
      _notify() {},
      _run() {}
    }
    if (_owner) _owner._children.push(branchNode)
    currentBranchNode = branchNode

    const prevOwner = _owner
    _owner = branchNode
    let $dom
    try {
      const factory = blocks[next]
      $dom = factory.$dom ?? (typeof factory === 'function' ? factory() : factory)
    } finally {
      _owner = prevOwner
    }

    const node = $dom.$dom ?? $dom
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      currentFirst = node.firstChild
      currentLast = node.lastChild
    } else {
      currentFirst = currentLast = node
    }
    if (noAnchor) parent.appendChild(node)
    else parent.insertBefore(node, anchor)
  })
}

export const ifBlockReadOnly = ifBlock

/**
 * keyBlock — destroy and recreate content whenever `keyFn()` changes.
 *
 * Used for {#key expr}...{/key}. Every time the key expression produces
 * a new value the inner block is torn down (effects disposed, DOM removed)
 * and a fresh instance is mounted. Useful for resetting component state or
 * replaying CSS enter animations when a dependency changes.
 *
 * @param {Comment}  anchor    Anchor comment node
 * @param {Function} keyFn     () => key value — tracked reactively
 * @param {Function} makeBlock Block factory — called with no args, returns DOM
 * @param {boolean}  noAnchor  True when anchor is the parent element (root)
 */
export function keyBlock(anchor, keyFn, makeBlock, noAnchor) {
  if (!_isBrowser)
    throw new Error('@frontierjs/mesa-runtime: keyBlock() called in a non-browser environment.')
  if (!anchor) return

  let currentFirst = null
  let currentLast  = null
  let blockNode    = null
  // Track the last key value so we only remount when it actually changes.
  // Without this, if the key expression is a memo that re-runs due to an upstream
  // signal change (e.g. chain prop updating) but returns the same value (e.g. same
  // component function reference), keyBlock would still tear down and remount its
  // content — causing layout components to re-run their instance scripts on every nav.
  const _UNSET = Symbol()
  let prevKey = _UNSET

  const _remove = () => {
    if (!currentFirst) return
    if (blockNode) { _disposeNode(blockNode, true); blockNode = null }
    removeElements(currentFirst, noAnchor ? null : currentLast)
    currentFirst = currentLast = null
  }

  createEffect(() => {
    const key = keyFn()  // subscribe to key — track its value
    // Only remount if the key value actually changed (strict equality)
    if (prevKey !== _UNSET && key === prevKey) return
    prevKey = key
    const parent = noAnchor ? anchor : anchor.parentNode
    if (!parent) return

    _remove()

    // Scope all child effects to a fresh owner so they're disposed cleanly
    const owner = {
      _fn: null, _deps: new Set(), _cleanups: [], _children: [],
      _owner: _owner, _notify() {}, _run() {}
    }
    if (_owner) _owner._children.push(owner)
    blockNode = owner

    const prevOwner = _owner
    _owner = owner
    let $dom
    try { $dom = makeBlock() } finally { _owner = prevOwner }

    const node = $dom?.$dom ?? $dom
    if (!node) return
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      currentFirst = node.firstChild
      currentLast  = node.lastChild
    } else {
      currentFirst = currentLast = node
    }
    if (noAnchor) parent.appendChild(node)
    else parent.insertBefore(node, anchor)
  })
}



export function awaitBlock(anchor, getPromise, pendingBlock, thenBlock, catchBlock) {
  if (!_isBrowser)
    throw new Error(
      '@frontierjs/mesa-runtime: awaitBlock() called in a non-browser environment. ' +
        'Use the Mesa SSR compiler target.'
    )
  let currentDom = null

  // Resolve a block result to actual DOM.
  // Block factories may be:
  //   1. A wrapper fn: ($parentElement) => makeBlock($tpl) — call to get factory
  //   2. A makeBlock factory: (v) => DOM — call to get DOM
  //   3. A snippet wrapper: (anchor, ...args) => inserts before anchor
  //   4. A DOM node or {$dom} object — use directly
  const _resolve = (fn, ...args) => {
    if (!fn) return null
    // Call the outer wrapper fn (e.g. ($parentElement) => makeBlock(...))
    let result
    try { result = fn(...args) } catch (_) { result = undefined }
    // If result is still a factory function (e.g. makeBlock returns (v) => DOM), call it
    if (typeof result === 'function') {
      try { result = result() } catch (_) { result = undefined }
    }
    // Unwrap {$dom} wrapper
    if (result && result.$dom) result = result.$dom
    // If we got a DOM node/fragment, return it
    if (result && result.nodeType) return result
    // Snippet style — fn inserts before a temp anchor
    const frag = document.createDocumentFragment()
    const tempAnchor = document.createComment('')
    frag.appendChild(tempAnchor)
    try { fn(tempAnchor, ...args) } catch (_) {}
    frag.removeChild(tempAnchor)
    return frag.hasChildNodes() ? frag : null
  }

  const _swap = ($dom) => {
    const parent = anchor.parentNode
    if (!parent) return
    if (currentDom) {
      removeElements(currentFirst, currentLast)
    }
    currentDom = $dom ?? null
    currentFirst = null
    currentLast  = null
    if (currentDom) {
      if (currentDom.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        currentFirst = currentDom.firstChild
        currentLast  = currentDom.lastChild
      } else {
        currentFirst = currentLast = currentDom
      }
      parent.insertBefore(currentDom, anchor)
    }
  }
  let currentFirst = null
  let currentLast  = null
  createEffect(() => {
    const promise = getPromise()
    if (!promise?.then) {
      _swap(_resolve(thenBlock, promise))
      return
    }
    _swap(_resolve(pendingBlock))
    let active = true
    onCleanup(() => {
      active = false
    })
    promise.then(
      (value) => {
        if (active) _swap(_resolve(thenBlock, value))
      },
      (err) => {
        if (active) _swap(_resolve(catchBlock, err))
      }
    )
  })
}

// ─── MOUNTED / BOUNDARY BLOCKS ────────────────────────────────────────────────

/**
 * $onMounted(fn) — wraps an async function in a Promise that resolves after the
 * component mounts to the DOM. Used with <mesa:mounted> to gate the template.
 * Only one call per component is allowed — compiler error if used twice.
 */
export function $onMounted(fn) {
  return new Promise((resolve, reject) => {
    $onMount(() => {
      try {
        Promise.resolve(fn?.()).then(resolve, reject)
      } catch (err) {
        reject(err)
      }
    })
  })
}

/**
 * mountedBlock — gate the entire component template behind a mount Promise.
 *
 * Shows pendingBlock while the promise is in flight.
 * On rejection: calls onerror(err) if provided AND shows failedBlock(err) if
 * provided — both run independently.
 * On resolution: shows contentBlock().
 *
 * @param {Comment}   anchor        Anchor comment node
 * @param {Function}  getPromise    () => Promise — the $mounted() promise
 * @param {Function}  pendingBlock  () => DOM | null — shown while loading
 * @param {Function}  contentBlock  (v) => DOM | null — shown on success
 * @param {Function}  failedBlock   (err) => DOM | null — shown on rejection
 * @param {Function}  onerror       (err) => void — programmatic error side-effect
 */
export function mountedBlock(anchor, getPromise, pendingBlock, contentBlock, failedBlock, onerror) {
  const resolveSnippet = (fn, ...args) => {
    if (!fn) return null
    let result
    try { result = fn(...args) } catch (_) { result = undefined }
    if (result && (result.$dom || result.nodeType)) return result
    const frag = document.createDocumentFragment()
    const tempAnchor = document.createComment('')
    frag.appendChild(tempAnchor)
    fn(tempAnchor, ...args)
    frag.removeChild(tempAnchor)
    return frag.hasChildNodes() ? frag : null
  }
  // wrappedCatch is a factory-style function (returns DOM node, frag, or null).
  // It's passed directly to awaitBlock's catchBlock — NOT through _callSnippetBlock —
  // by wrapping it so it always returns a non-null sentinel (empty div) when there's
  // no failedBlock, preventing the snippet retry path from double-firing onerror.
  const wrappedCatch = (failedBlock || onerror)
    ? (err) => {
        onerror?.(err)
        return resolveSnippet(failedBlock, err) ?? document.createDocumentFragment()
      }
    : null

  // Wrap contentBlock to check the resolved value — only suppress if explicitly false.
  // undefined/null (plain $mounted with no return value) → show content as before.
  // false / 0 / '' → suppress — caller is explicitly gating.
  // Truthy → show content normally.
  const wrappedContent = contentBlock
    ? (value) => (value === false || value === 0 || value === '') ? null : contentBlock(value)
    : null

  awaitBlock(anchor, getPromise, pendingBlock, wrappedContent, wrappedCatch)
}

/**
 * boundaryBlock — reactively gate template content behind $async state objects.
 *
 * Reads .loading / .error / .status from each state object inside a createEffect
 * so the block re-evaluates whenever any async state changes. The state objects
 * are produced by makeAsyncState() and their properties are signal getters, so
 * accessing them here subscribes to the underlying signals automatically.
 *
 * States:
 *   - any state.error !== null  → failedBlock(err)  [error wins]
 *   - any state.loading === true → pendingBlock()   [first-load gate]
 *   - all resolved              → contentBlock()    [mounted once, stays]
 *
 * @param {Comment}   anchor        Anchor comment node
 * @param {Function}  getStates     () => makeAsyncState[] — reactive getter
 * @param {Function}  contentBlock  () => DOM | null
 * @param {Function}  pendingBlock  () => DOM | null
 * @param {Function}  failedBlock   (err) => DOM | null
 */
export function boundaryBlock(anchor, getStates, contentBlock, pendingBlock, failedBlock) {
  if (!_isBrowser)
    throw new Error('@frontierjs/mesa-runtime: boundaryBlock() called in a non-browser environment.')

  let currentDom = null
  let contentMounted = false

  // pendingBlock and failedBlock may be compiler-emitted snippet wrappers
  // (__anchor) => $$snippet_pending(__anchor) — or factory blocks returning DOM.
  // _callSnippetBlock handles both without double-invoking side-effect functions.
  const _callSnippetBlock = (fn, ...args) => {
    if (!fn) return null
    let result
    try {
      result = fn(...args)
    } catch (_) {
      result = undefined
    }
    if (result && (result.$dom || result.nodeType)) return result
    // Snippet style — call again with a temp anchor as first arg
    const frag = document.createDocumentFragment()
    const tempAnchor = document.createComment('')
    frag.appendChild(tempAnchor)
    fn(tempAnchor, ...args)
    frag.removeChild(tempAnchor)
    return frag.hasChildNodes() ? frag : null
  }

  const _swap = ($dom) => {
    const parent = anchor.parentNode
    if (!parent) return
    if (currentDom) removeElements(currentFirst, currentLast)
    currentDom = $dom ? $dom.$dom ?? $dom : null
    currentFirst = null
    currentLast  = null
    if (currentDom) {
      if (currentDom.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        currentFirst = currentDom.firstChild
        currentLast  = currentDom.lastChild
      } else {
        currentFirst = currentLast = currentDom
      }
      parent.insertBefore(currentDom, anchor)
    }
  }
  let currentFirst = null
  let currentLast  = null

  createEffect(() => {
    const states = getStates()
    // Error wins — show failed if any state has an error
    const errState = states.find(s => s.error !== null)
    if (errState) {
      contentMounted = false
      _swap(failedBlock ? _callSnippetBlock(failedBlock, errState.error) : null)
      return
    }
    // First-load gate — show pending while any state is still loading
    if (states.some(s => s.loading)) {
      _swap(pendingBlock ? _callSnippetBlock(pendingBlock) : null)
      return
    }
    // All resolved — mount content once and leave it
    if (!contentMounted) {
      contentMounted = true
      _swap(contentBlock ? contentBlock() : null)
    }
  })
}

export function attachNamedSlot(__block, name, fallbackFactory) {
  // __block is the 3rd argument to the component function — the slots object.
  // { default: makeBlock(...), sidebar: makeBlock(...) }
  // Returns the DOM node/fragment for addBlock() to insert at the right place.
  const slotFactory = __block?.[name] ?? fallbackFactory
  if (!slotFactory) return null
  return slotFactory()
}

// Legacy — kept for compatibility
export function attachNamedSlotLegacy($option, name, fallbackFactory) {
  return attachNamedSlot($option?.slots, name, fallbackFactory)
}

// Kept for old attachSlot tests / external callers
export function attachSlot(anchor, slotFn, fallbackFactory) {
  const factory = slotFn ?? fallbackFactory
  if (!factory) return
  const result = typeof factory === 'function' ? factory() : factory
  const node = result?.$dom ?? result
  if (!node) return
  if (anchor && anchor.parentNode) {
    anchor.parentNode.insertBefore(node, anchor)
    anchor.parentNode.removeChild(anchor)
  }
}

/**
 * makeSlots — create the $slots reactive object for a component.
 *
 * $slots.sidebar → true if the parent passed a 'sidebar' slot block
 * $slots.default → true if the parent passed default children
 *
 * Used in layout templates: {#if $slots.sidebar} ... {/if}
 *
 * @param {object|null} __block — the slots object passed as 3rd arg to Component()
 * @returns {object} — proxy-like object with boolean keys per slot name
 */
export function makeSlots(__block) {
  if (!__block) return {}
  const slots = {}
  for (const key of Object.keys(__block)) {
    slots[key] = true
  }
  return slots
}

export function spreadAttributes(el, fn) {
  const propDescs = Object.getOwnPropertyDescriptors(Object.getPrototypeOf(el))
  let prev = {}
  const _set = (k, v) => {
    if (k === 'style') el.style.cssText = v ?? ''
    else if (propDescs[k]?.set) el[k] = v
    else v == null ? el.removeAttribute(k) : el.setAttribute(k, '' + v)
  }
  createEffect(() => {
    const state = fn() ?? {}
    for (const k in state) {
      if (prev[k] !== state[k]) {
        _set(k, state[k])
        prev[k] = state[k]
      }
    }
    for (const k in prev) {
      if (!(k in state)) {
        _set(k, null)
        delete prev[k]
      }
    }
    prev = { ...state }
  })
}

/**
 * Ordered watch group — $: { dep, handler \n dep, handler }
 *
 * Entries subscribe individually so only changed-dep handlers run.
 * When any dep fires, the group schedules a microtask flush.
 * On flush: entries whose deps fired run in declared order, all inside batch().
 * Multiple dep changes in the same tick coalesce into one flush.
 *
 * Runs all entries immediately on creation (same as createEffect) so
 * subscriptions are established and initial values derived at mount.
 *
 * @param {Array<{ deps: Function[], handler: Function }>} entries
 */
export function orderedGroup(entries) {
  let scheduled = false
  const dirty = new Set()

  const flush = () => {
    scheduled = false
    if (!dirty.size) return
    const toRun = [...dirty]
    dirty.clear()
    batch(() => {
      for (const entry of toRun) {
        untrack(entry.handler)
      }
    })
  }

  const schedule = (entry) => {
    dirty.add(entry)
    if (!scheduled) {
      scheduled = true
      _resolved.then(flush)
    }
  }

  // Create one effect per entry. The effect reads each dep to subscribe,
  // then schedules the handler rather than running it inline.
  // On initial run we execute immediately (synchronous) to match createEffect
  // semantics — subsequent runs go through the microtask scheduler.
  let initialRun = true

  for (const entry of entries) {
    createEffect(() => {
      // Read all deps to subscribe this effect node to their signals
      for (const dep of entry.deps) dep()
      if (initialRun) {
        // Initial run: execute handler synchronously so values are
        // derived at mount, before the first dep change
        untrack(entry.handler)
      } else {
        schedule(entry)
      }
    })
  }

  initialRun = false
}

const _ROOT_PATH = '__root__'

// Two-level registry: WeakMap<rootObj, Map<path, Proxy>>
// Keyed by (rootObj, path) to prevent cross-component contamination.
const _nestedProxyCache = new WeakMap() // rootObj → Map<childPath, Proxy>
const _rootProxyCache   = new WeakMap() // rootObj → rootProxy
const _proxyToRoot      = new WeakMap() // proxy → rootObj (reverse, for unproxy)
const _signalRegistry   = new WeakMap() // rootObj → Map<path, [read, write]>

const _ARRAY_MUTATORS = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'copyWithin'
])

function _getNestedProxy(rootObj, path, target) {
  if (!_nestedProxyCache.has(rootObj)) _nestedProxyCache.set(rootObj, new Map())
  const cache = _nestedProxyCache.get(rootObj)
  if (cache.has(path)) return cache.get(path)
  const proxy = _buildProxy(target, rootObj, path)
  cache.set(path, proxy)
  return proxy
}

function _buildProxy(obj, rootObj, pathPrefix) {
  if (typeof obj !== 'object' || obj === null) return obj

  return new Proxy(obj, {
    get(target, key) {
      const value = target[key]
      if (Array.isArray(target) && _ARRAY_MUTATORS.has(key) && typeof value === 'function') {
        return (...args) => {
          const result = value.apply(target, args)
          _fireSignal(rootObj, pathPrefix || _ROOT_PATH)
          return result
        }
      }
      // Subscribe the current reactive effect to this property's watch signal.
      // This wires template bindings (e.g. bindText(() => $$proxy_store.count))
      // to re-run when the proxied property is mutated.
      if (_listener) {
        const accessPath = pathPrefix ? `${pathPrefix}.${String(key)}` : String(key)
        const sigs = _signalRegistry.get(rootObj)
        if (sigs) {
          // Subscribe to the exact property path if registered ($: obj.prop)
          const s = sigs.get(accessPath)
          if (s) {
            s[0]()
          } else {
            // Fall back to the root sentinel signal ($: obj — whole-object watch).
            // Without this fallback, reading obj.prop inside a template effect would
            // not subscribe to the root signal, so whole-object mutations would never
            // trigger re-renders even though $: obj is declared.
            const root = sigs.get(_ROOT_PATH)
            if (root) root[0]()
          }
        }
      }
      if (typeof value === 'object' && value !== null) {
        const childPath = pathPrefix ? `${pathPrefix}.${String(key)}` : String(key)
        return _getNestedProxy(rootObj, childPath, value)
      }
      return value
    },
    set(target, key, value) {
      target[key] = value
      const path = pathPrefix ? `${pathPrefix}.${String(key)}` : String(key)
      _fireSignal(rootObj, path)
      // Also fire the parent path so $: user.prefs watchers see user.prefs.theme changes.
      if (pathPrefix) _fireSignal(rootObj, pathPrefix)
      // Fire root sentinel so $: user (whole-object watch) always triggers.
      _fireSignal(rootObj, _ROOT_PATH)
      return true
    }
  })
}

function _fireSignal(rootObj, path) {
  const signals = _signalRegistry.get(rootObj)
  if (!signals) return
  const sig = signals.get(path)
  if (sig) sig[1]((v) => v) // trigger always-notify signal
}

export function watchProxy(obj) {
  if (!_isBrowser) return obj // Rule 19: path watches are no-ops on server
  if (typeof obj !== 'object' || obj === null) return obj
  if (_rootProxyCache.has(obj)) return _rootProxyCache.get(obj)
  if (!_signalRegistry.has(obj)) _signalRegistry.set(obj, new Map())
  const proxy = _buildProxy(obj, obj, '')
  _rootProxyCache.set(obj, proxy)
  _proxyToRoot.set(proxy, obj)   // reverse map for unproxy
  return proxy
}

export function watchPath(obj, path) {
  if (!_isBrowser) return [() => undefined, () => {}] // Rule 19: no-op on server
  // Normalize whole-object watch to the root sentinel.
  const key = path || _ROOT_PATH
  if (!_signalRegistry.has(obj)) _signalRegistry.set(obj, new Map())
  const signals = _signalRegistry.get(obj)
  if (!signals.has(key)) signals.set(key, createSignal(undefined, { equals: () => false }))
  return signals.get(key)
}

/**
 * Build a proxy for a LOCAL let variable's object that fires caller-supplied
 * setter functions when specific paths are mutated, and subscribes the
 * current reactive effect when paths are read.
 *
 * @param {object} obj       The object to proxy
 * @param {object} signalMap Map of dotPath → [readFn, fireFn].
 *                           '' means whole-object watch.
 * @returns {Proxy}
 */

/**
 * unproxy — unwrap a Mesa watch proxy to its underlying plain object.
 * Deep-clones the result so it can be safely logged without proxy interference.
 * Non-proxy values are returned as-is.
 */
export function unproxy(value) {
  if (value === null || typeof value !== 'object') return value
  // Walk the proxy chain to the root object
  const root = _proxyToRoot.get(value)
  const target = root ?? value
  // Deep clone via structuredClone if available, fallback to JSON round-trip
  try {
    return typeof structuredClone === 'function'
      ? structuredClone(target)
      : JSON.parse(JSON.stringify(target))
  } catch (_) {
    return target  // non-serializable — return raw target
  }
}

/**
 * $inspect — reactive dev-mode inspector.
 *
 * Auto-tracks its arguments and logs them whenever they change.
 * Unwraps Mesa proxies so the actual object is shown, not `Proxy {}`.
 * Stripped entirely in production builds (config.dev === false).
 *
 * Usage (compiler-injected, never manually called):
 *   $inspect(cart)
 *   $inspect(cart, count)
 *   $inspect(cart).with(console.trace)
 *
 * @param  {...any} args  Values to inspect (labels extracted from source by compiler)
 * @returns {{ with: (fn) => void }}
 */
export function $inspect(...args) {
  // args format from compiler: [label, ...getters]
  // label is the source expression string(s) joined, getters are () => value
  const last = args[args.length - 1]
  let label, getters
  if (typeof last === 'object' && last !== null && Array.isArray(last.getters)) {
    // Structured form from compiler: { label, getters: [() => val, ...] }
    label   = last.label
    getters = last.getters
  } else {
    // Fallback: raw values passed directly
    label   = 'inspect'
    getters = args.map(a => (typeof a === 'function' ? a : () => a))
  }

  let customFn = null
  let prevValues = null

  createEffect(() => {
    const values = getters.map(g => {
      const v = g()
      return unproxy(v)
    })

    const fn = customFn ?? _defaultInspect
    fn(label, values, prevValues)
    prevValues = values
  })

  return {
    with(fn) { customFn = fn }
  }
}

function _defaultInspect(label, values, prev) {
  const tag = `%c[Mesa $inspect]%c ${label}`
  const style1 = 'color:#EE380D;font-weight:bold'
  const style2 = 'color:inherit;font-weight:normal'
  if (values.length === 1) {
    console.log(tag, style1, style2, values[0])
  } else {
    console.group(tag, style1, style2)
    values.forEach((v, i) => console.log(`[${i}]`, v))
    console.groupEnd()
  }
}

export function localWatchProxy(obj, signalMap) {
  if (!_isBrowser) return obj
  if (typeof obj !== 'object' || obj === null) return obj
  return _buildLocalProxy(obj, signalMap, '')
}

function _buildLocalProxy(obj, signalMap, pathPrefix) {
  if (typeof obj !== 'object' || obj === null) return obj

  return new Proxy(obj, {
    get(target, key) {
      if (typeof key === 'symbol') return target[key]
      const value = target[key]

      // Array mutator interception
      if (Array.isArray(target) && _ARRAY_MUTATORS.has(key) && typeof value === 'function') {
        return (...args) => {
          const result = value.apply(target, args)
          _fireLocalSignals(signalMap, pathPrefix || '')
          return result
        }
      }

      // Subscribe current reactive effect to this path's signal
      if (_listener) {
        const accessPath = pathPrefix ? `${pathPrefix}.${String(key)}` : String(key)
        const callRead = (fns) => {
          const r = fns[0]
          // Support both raw function (old style) and track() object (new style)
          if (typeof r === 'function') r()
          else if (r?._read) r._read()
          else if (r?._isMemo) r._memo()
        }
        // Subscribe to exact match
        if (signalMap[accessPath]) callRead(signalMap[accessPath])
        // Subscribe to any registered ancestor path
        for (const [watchPath, fns] of Object.entries(signalMap)) {
          if (watchPath !== '' && accessPath.startsWith(watchPath + '.')) callRead(fns)
        }
        // Subscribe to whole-object watch
        if (signalMap['']) callRead(signalMap[''])
      }

      if (typeof value === 'object' && value !== null) {
        const childPath = pathPrefix ? `${pathPrefix}.${String(key)}` : String(key)
        return _buildLocalProxy(value, signalMap, childPath)
      }
      return value
    },
    set(target, key, value) {
      target[key] = value
      const path = pathPrefix ? `${pathPrefix}.${String(key)}` : String(key)
      _fireLocalSignals(signalMap, path)
      if (pathPrefix) _fireLocalSignals(signalMap, pathPrefix)
      _fireLocalSignals(signalMap, '') // always fire root
      return true
    }
  })
}

function _fireLocalSignals(signalMap, path) {
  // Fire exact match
  if (signalMap[path]) { signalMap[path][1](); return }
  // Fire any watch that is a prefix of the mutated path
  for (const [watchPath, fns] of Object.entries(signalMap)) {
    if (watchPath !== '' && path.startsWith(watchPath + '.')) fns[1]()
  }
}

// ─── ASYNC STATE ──────────────────────────────────────────────────────────────

export function makeAsyncState() {
  const [loading, setLoading] = createSignal(true)
  const [fetching, setFetching] = createSignal(true)
  const [error, setError] = createSignal(null)
  const [status, setStatus] = createSignal('pending')
  return {
    get loading() {
      return loading()
    },
    get fetching() {
      return fetching()
    },
    get error() {
      return error()
    },
    get status() {
      return status()
    },
    _update(phase, err = null) {
      if (phase === 'start') {
        setFetching(true)
        setError(null)
        setStatus('pending')
      } else if (phase === 'done') {
        setLoading(false)
        setFetching(false)
        setStatus('success')
      } else {
        setLoading(false)
        setFetching(false)
        setError(err)
        setStatus('error')
      }
    }
  }
}

export function asyncDerived(getAsyncState, fn, deps, setValue) {
  let controller = null
  createEffect(() => {
    deps.forEach((d) => d())
    controller?.abort()
    controller = new AbortController()
    const state = getAsyncState()
    state._update('start')
    const signal = controller.signal
    fn(signal).then(
      (value) => {
        if (signal.aborted) return
        setValue(value)
        state._update('done')
      },
      (err) => {
        if (signal.aborted) return
        state._update('error', err)
      }
    )
    onCleanup(() => controller?.abort())
  })
}

// ─── MISC ─────────────────────────────────────────────────────────────────────

export const noop = (x) => x
export const addClass = (el, cls) => el.classList.add(cls)

export function makeClassResolver($option, classMap, metaClass, mainName) {
  if (!$option.$class) $option.$class = {}
  if (!mainName && metaClass.main) mainName = 'main'
  return (line, defaults) => {
    const result = {}
    if (defaults) result[defaults] = 1
    line
      .trim()
      .split(/\s+/)
      .forEach((name) => {
        let meta
        if (name[0] === '$') {
          name = name.slice(1)
          meta = true
        }
        const h = metaClass[name] || meta
        if (h) {
          const override = ($option.$class[name === mainName ? '$$main' : name] || '').trim()
          if (override) result[override] = 1
          else if (h !== true) {
            result[name] = 1
            result[h] = 1
          }
        }
        const h2 = classMap[name]
        if (h2) {
          result[name] = 1
          result[h2] = 1
        } else if (!h) result[name] = 1
      })
    return Object.keys(result).join(' ')
  }
}

/**
 * Register an `export let` prop signal with the current component.
 * Called by compiler-generated code inside the component init function.
 * The returned { get, set } pair is also used directly by compiled bindings.
 *
 * @param {string}   name    Prop name as declared in source.
 * @param {function} getter  Signal read fn  — () => value
 * @param {function} setter  Signal write fn — (value) => void
 * @returns {{ get: function, set: function }}
 */
// makeExternalProperty and version are defined in the new API section below

// ─── NEW REACTIVE API ─────────────────────────────────────────────────────────
//
// track / get / set — unified signal/derived factory matching the new compiler
// output. child / sibling / pop — sequential DOM traversal. render — reactive
// block with __prev dirty-checking. template — cloning factory. append — mount.
// push_component / pop_component — scoped reactive ownership for named fns.//
// ── New runtime API ────────────────────────────────────────────────────────────
//
// track / get / set — unified signal/derived factory matching the compiler
// output. child / sibling / pop — sequential DOM traversal. render — reactive
// block with __prev dirty-checking. template — cloning factory. append — mount.
// push_component / pop_component — scoped reactive ownership for named fns.

// ── Component lifecycle ───────────────────────────────────────────────────────

// ── Dev instrumentation ───────────────────────────────────────────────────────
// Active only when the compiler emits dev:true — registration calls are only
// present in dev-compiled output, so these structures stay empty in production.
// __dev is always exported; the overhead in prod is a single Map.size check in
// set() and a couple of assignments in push/pop_component.

let _devCompId    = null   // current component instance id during setup
let _devInstCount = 0
let _devSigCount  = 0
const _MAX_LOG    = 200

function _serializeValue(v) {
  if (v === null || v === undefined) return v
  if (typeof v === 'function')  return '[Function]'
  if (typeof v === 'symbol')    return v.toString()
  if (typeof v !== 'object')    return v
  // Shallow clone — avoid circular refs
  try {
    if (Array.isArray(v)) return v.slice(0, 20).map(_serializeValue)
    const out = {}
    let n = 0
    for (const k in v) {
      if (n++ > 10) { out['…'] = true; break }
      out[k] = _serializeValue(v[k])
    }
    return out
  } catch { return '[Object]' }
}

function _readSignalValue(sig) {
  if (!sig) return undefined
  if (sig.__v !== undefined || '_isMemo' in sig) return sig.__v
  if (typeof sig === 'function') {
    try { return untrack(sig) } catch { return undefined }
  }
  return undefined
}

export const __dev = {
  _signals:    new Map(),   // sig → { id, name, kind, componentId }
  _components: new Map(),   // instanceId → { id, name, file, signals: Set, mountTime }
  _log:        [],
  _listeners:  new Set(),

  /** Register a signal. Called by compiler-emitted __dev.r() calls in dev builds. */
  r(sig, name, kind) {
    if (!sig) return
    const id = ++_devSigCount
    const record = { id, name, kind, componentId: _devCompId }
    this._signals.set(sig, record)
    if (_devCompId !== null) {
      const comp = this._components.get(_devCompId)
      if (comp) comp.signals.add(sig)
    }
  },

  /** Called from set() when a registered signal changes. */
  _onUpdate(sig, value) {
    const record = this._signals.get(sig)
    if (!record) return
    const entry = {
      ts:          Date.now(),
      signalId:    record.id,
      name:        record.name,
      kind:        record.kind,
      componentId: record.componentId,
      value:       _serializeValue(value),
    }
    if (this._log.length >= _MAX_LOG) this._log.shift()
    this._log.push(entry)
    this._emit({ type: 'update', data: entry })
  },

  _emit(event) {
    for (const fn of this._listeners) {
      try { fn(event) } catch { /* listener errors must not break reactive graph */ }
    }
  },

  subscribe(fn)   { this._listeners.add(fn) },
  unsubscribe(fn) { this._listeners.delete(fn) },

  /** Full state snapshot for devtools page on load. */
  snapshot() {
    const signals = []
    for (const [sig, rec] of this._signals) {
      signals.push({ ...rec, value: _serializeValue(_readSignalValue(sig)) })
    }
    const components = []
    for (const [, comp] of this._components) {
      components.push({
        id:        comp.id,
        name:      comp.name,
        file:      comp.file,
        mountTime: comp.mountTime,
        signals:   [...comp.signals].map(s => this._signals.get(s)?.id).filter(Boolean),
      })
    }
    return { signals, components, log: [...this._log] }
  },
}

// Expose on window so the injected devtools client can access it without
// re-importing the module (avoids duplicate module instance issues).
if (typeof window !== 'undefined') window.__MESA_DEV__ = __dev

const _compStack = []

export function push_component(devName, devFile) {
  const rootNode = {
    _fn: null, _deps: new Set(), _cleanups: [],
    _children: [], _owner: _owner, _notify() {}, _run() {}
  }
  if (_owner) _owner._children.push(rootNode)
  _compStack.push({
    owner: _owner, listener: _listener,
    mounts: _mountList, props: _propRegistry,
    ctx: null, rootNode,
    devCompId: _devCompId,   // save caller's component id for restore in pop
  })
  const ctxMap = new Map()
  _compStack[_compStack.length - 1].ctx = ctxMap
  _contextStack.push(ctxMap)
  _owner       = rootNode
  _listener    = null
  _mountList   = []
  _propRegistry = new Map()

  // Dev registration — only when compiler emitted name (dev: true build)
  if (devName) {
    const id = ++_devInstCount
    _devCompId = id
    __dev._components.set(id, {
      id, name: devName, file: devFile ?? '',
      signals: new Set(), mountTime: Date.now(),
    })
    __dev._emit({ type: 'mount', data: { id, name: devName, file: devFile ?? '' } })
    // Cleanup fires when the component is destroyed
    rootNode._cleanups.push(() => {
      __dev._components.delete(id)
      // Remove all signal registrations belonging to this instance
      const comp = __dev._components.get(id)
      if (comp) for (const sig of comp.signals) __dev._signals.delete(sig)
      __dev._emit({ type: 'unmount', data: { id } })
    })
  } else {
    _devCompId = null
  }
}

export function pop_component() {
  const frame = _compStack.pop()
  if (!frame) return
  const mountList = _mountList
  const rootNode  = _owner
  const registry  = _propRegistry
  _owner        = frame.owner
  _listener     = frame.listener
  _mountList    = frame.mounts
  _propRegistry = frame.props
  _devCompId    = frame.devCompId   // restore enclosing component's id
  _contextStack.pop()
  _resolved.then(() => {
    for (const fn of mountList) {
      const result = _safeCall(fn)
      if (typeof result === 'function') rootNode._cleanups.push(result)
    }
  })
  rootNode._registry = registry
}

// ── Component prop registry — keyed by anchor comment node ────────────────────
// When a parent mounts a child with reactive props, it needs to push new values
// into the child's prop signals. The child registers its prop signals via
// makeExternalProperty into _propRegistry, which pop_component stores on
// rootNode._registry. We map anchor → registry so the parent can call pushProps.

const _componentRegistry = new WeakMap()

export function registerComponentAnchor(anchor) {
  // Called immediately after ComponentFn(anchor, props, null) returns.
  // At that point _owner is back to the parent, and the child rootNode is the
  // last child of the current owner (added by push_component's rootNode setup).
  const parentOwner = _owner
  const childNode = parentOwner?._children?.[parentOwner._children.length - 1]
  if (childNode?._registry) {
    _componentRegistry.set(anchor, childNode._registry)
  }
}

export function pushProps(anchor, newProps) {
  if (!newProps) return
  const registry = _componentRegistry.get(anchor)
  if (!registry) return
  batch(() => {
    for (const name in newProps) {
      const p = registry.get(name)
      if (!p) continue
      // Use directWrite when available — it bypasses the compiled setter's
      // "function as updater" logic (typeof v === 'function' ? v(cur) : v).
      // That logic is correct for user mutations (count++) but wrong here:
      // pushProps always delivers a plain value, never an updater function.
      // Without this, passing a snippet function as a prop calls it with the
      // current signal value as __anchor → TypeError: can't read before.
      if (p.directWrite) p.directWrite(newProps[name])
      else p.set(newProps[name])
    }
  })
}

// Remove the old mountComponent helper — no longer needed


export function track(value, _getInterceptor, _setInterceptor, _block, _alwaysNotify) {
  // Only treat the value as a reactive derivation if it is a zero-argument function.
  // The Mesa compiler always emits derivations as `() => expr` (length === 0).
  // Snippet functions are always `(__anchor, ...args) => {}` (length >= 1).
  // Callback / plain function values passed as props must be stored as signal values,
  // not memoized — calling them without their required arguments would throw.
  if (typeof value === 'function' && value.length === 0) {
    const memo = createMemo(value)
    return {
      _isMemo: true,
      _memo: memo,
      get __v() { return untrack(memo) },
    }
  }
  const [read, write] = createSignal(value, _alwaysNotify ? { equals: () => false } : undefined)
  // _directWrite is now identical to write since createSignal no longer has an
  // updater-function check. Kept for API compatibility with pushProps.
  const _directWrite = write
  return {
    _isMemo: false,
    _read: read,
    _write: write,
    _directWrite,
    get __v() { return untrack(read) },
  }
}

export function get(tracked) {
  if (tracked == null) return tracked
  if (tracked._isMemo) return tracked._memo()
  if (tracked._read)   return tracked._read()
  if (typeof tracked === 'function') return tracked()  // raw createSignal/createMemo getter
  return tracked
}

export function set(tracked, value) {
  if (!tracked || tracked._isMemo) return
  if (tracked._write) {
    // Direct write — the compiler now emits the full expression for compound ops
    // (count++ → set(sig, get(sig) + 1)) so the value passed here is always the
    // final value, never an updater function. Calling a function value would
    // accidentally invoke snippet functions stored in signals (e.g. sidebarFn).
    tracked._write(value)
    // Dev instrumentation — zero cost in prod (signals map stays empty)
    if (__dev._signals.size) __dev._onUpdate(tracked, value)
  }
  // tracked is a raw setter fn (e.g. from createWritableSignal)
}

// ── DOM traversal ─────────────────────────────────────────────────────────────

export function child(node, _isText) { return node.firstChild }
export function sibling(node)        { return node.nextSibling }
export function pop(_node)           {}   // no-op client-side; SSR hydration uses this

// ── template() factory ────────────────────────────────────────────────────────

const TEMPLATE_FRAGMENT = 1

export function template(html, flags) {
  const isFragment = flags & TEMPLATE_FRAGMENT
  let parsed = null
  return function () {
    if (!parsed) parsed = htmlToFragment(html, isFragment ? 2 : 1)
    return parsed.cloneNode(true)
  }
}

// ── append() ─────────────────────────────────────────────────────────────────

export function append(anchor, dom) { anchor.before(dom) }

// ── render() — reactive block with __prev dirty-checking ─────────────────────

export function render(fn, init) {
  const prev = Object.assign({}, init)
  createEffect(() => fn(prev))
}

// ── set_text / set_attribute ─────────────────────────────────────────────────

export function set_text(node, value) {
  const str = value == null ? '' : typeof value === 'object' ? '' + value : value
  if (str !== node.__t) { node.__t = str; node.textContent = str }
}

// {@html expr} — inserts raw HTML before the anchor comment.
// Replaces previously injected nodes on each reactive re-run.
export function setInnerHTML(anchor, html) {
  // Remove previously injected nodes (tracked via anchor.__htmlNodes)
  if (anchor.__htmlNodes) {
    anchor.__htmlNodes.forEach(n => n.remove())
  }
  if (html == null || html === '') { anchor.__htmlNodes = []; return }
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const nodes = [...tpl.content.childNodes]
  anchor.__htmlNodes = nodes
  nodes.forEach(n => anchor.before(n))
}

// HTML boolean attributes: presence = true, absence = false.
// Setting disabled="false" still disables the element — must removeAttribute instead.
const _BOOL_ATTRS = new Set([
  'disabled', 'readonly', 'required', 'checked', 'multiple', 'open',
  'hidden', 'selected', 'autofocus', 'autoplay', 'controls', 'default',
  'defer', 'formnovalidate', 'ismap', 'loop', 'muted', 'nomodule',
  'novalidate', 'playsinline', 'reversed', 'scoped',
])

export function set_attribute(el, name, value) {
  if (value == null || value === false) {
    el.removeAttribute(name)
  } else if (_DOM_PROPS.has(name)) {
    el[name] = value
  } else if (_BOOL_ATTRS.has(name)) {
    // Boolean attribute: any truthy value → set as empty string (canonical form)
    el.setAttribute(name, '')
  } else {
    el.setAttribute(name, '' + value)
  }
}

// ── Updated makeExternalProperty — accepts track() objects or v1 fn getters ──

export function makeExternalProperty(name, getter, setter) {
  const readFn = typeof getter === 'function'
    ? getter
    : getter?._isMemo ? () => getter._memo() : () => getter._read()
  // directWrite bypasses the compiled setter's "function as updater" logic.
  // Uses directWrite to bypass any signal equality checks for raw function values.
  // for pushProps, which passes raw values (including snippet functions) from parent to child.
  // directWrite writes the value straight to the signal without calling it as an updater.
  // directWrite: write the raw prop value, bypassing the compiled setter's
  // "function as updater" logic. Uses track()'s _directWrite if available —
  // that wraps function values in () => v so createSignal stores them correctly.
  const directWrite = getter?._directWrite ?? ((v) => setter(v))
  const prop = { get: readFn, set: (v) => setter(v), directWrite }
  if (_propRegistry) _propRegistry.set(name, prop)
  return prop
}

export const version = '1.1.0'
