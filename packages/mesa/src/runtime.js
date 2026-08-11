/**
 * @frontierjs/mesa-runtime  v0.1.0
 */

const _resolved = Promise.resolve()
/** True in any browser environment. False in Node/Deno/workers without DOM.
 *  Can be set to true by renderToHTML when a virtual DOM (happy-dom) is active. */
let _isBrowser = typeof document !== 'undefined'

/** True only in a real client runtime.
 *
 *  Distinct from _isBrowser, which means no more than "a DOM is reachable".
 *  renderToHTML installs happy-dom and must set _isBrowser so compiled
 *  components can call htmlToFragment() and document.createElement() — but a
 *  server render is emphatically not a client, and RULE 19 says so: no reactive
 *  graph, $onMount a no-op, path watches inert.
 *
 *  One flag could not express both, so turning the DOM on turned client
 *  behaviour on with it and every RULE 19 guard became dead code. $onMount then
 *  ran once per render on the server — with a happy-dom `window` available, so
 *  addEventListener and friends silently succeeded against a global that
 *  outlived the request — and watchProxy built real proxies and signals that
 *  nothing ever disposed. */
let _isClient = typeof document !== 'undefined'

/**
 * Override the browser environment flag.
 * Called by @frontierjs/mesa-render before mounting components in a happy-dom Window.
 * This unlocks htmlToFragment and other DOM-dependent functions in Node.js.
 */
export function setRenderEnvironment(isBrowser, isClient = isBrowser) {
  _isBrowser = isBrowser
  _isClient = isClient
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

// Drain all pending nodes. Run in a loop so that effects triggered by other
// effects in this batch are also flushed before control returns.
//
// Within each pass, everything that builds the DOM runs BEFORE user effects.
// Renders, control flow and user effects are all the same kind of node, so
// without this split the order fell out of creation order — and because the
// compiler emits the <script> before the template, a `$:` effect ran before the
// DOM it was reacting to had been updated:
//
//   $: items, () => { count = el.childNodes.length }   // always one update stale
//
// Both Solid and Svelte run user effects after the DOM updates (Solid's
// createEffect explicitly, with createRenderEffect as the during-render tier;
// Svelte's $effect, with $effect.pre as the opt-out). This makes Mesa agree with
// them, so an effect observes the DOM as it is after the change it is reacting
// to, not before.
//
// Effects that queue further work are picked up by the next pass, which applies
// the same ordering — so a render triggered by an effect still lands before any
// effects it in turn triggers.
//
// Ahead of both tiers, the derived layer is settled to a fixpoint. Memos
// propagate from their recompute rather than from their invalidation (see
// createMemo), so a memo whose value actually moved can dirty another memo.
// Draining that to quiescence first means renders and user effects in this
// generation read derivations that have stopped moving, and a chain of memos
// resolves within one generation instead of one link per generation.
function _flush() {
  _microtaskPending = false
  let passes = 0
  while (_queue.size > 0) {
    if (++passes > _MAX_FLUSH_PASSES) return _reportCycle()

    // Collected in a single scan that allocates nothing in the common case
    // where no derivation is pending — this runs on every flush, including the
    // 10k-row ones.
    for (;;) {
      let derived = null
      for (const node of _queue) if (node._isDerived) (derived ??= []).push(node)
      if (!derived) break
      if (++passes > _MAX_FLUSH_PASSES) return _reportCycle()
      for (const node of derived) _queue.delete(node)
      for (const node of derived) _runNode(node)
    }

    const pending = [..._queue]
    _queue.clear()
    for (const node of pending) if (!node._isUserEffect) _runNode(node)
    for (const node of pending) if (node._isUserEffect)  _runNode(node)
  }
}

// Run one node, containing any error it throws.
//
// _flush drains _queue into a snapshot before running anything, so an exception
// that escapes here does not merely skip the effect that threw — every node
// after it in the snapshot is dropped, and because those nodes were already
// removed from _queue they are never re-notified for this write. They stay
// stale until some unrelated later change happens to wake them. Containing the
// error per node keeps one broken effect from silently desynchronising the rest
// of the page, which is the same choice Solid, Svelte and Vue make.
function _runNode(node) {
  const comps = _compStack.length
  const ctxs = _contextStack.length
  try {
    node._run()
  } catch (e) {
    // Component setup runs inside effects — a child render, an {#if} branch, an
    // {#each} row. The compiler emits push_component()/…/pop_component() as
    // straight-line code, so a throw in between skips the pop and strands the
    // component's frame and context map forever: every component mounted
    // afterwards then inherits the dead one's context provides. Unwind to the
    // depth we entered at. (_owner and _listener need no repair — _run restores
    // those in its own finally.)
    _unwindComponents(comps, ctxs)
    console.error(e)
  }
}

// Truncate the component and context stacks back to a known-good depth after a
// throw, restoring the module-globals that pop_component would have restored.
function _unwindComponents(compDepth, ctxDepth) {
  if (_compStack.length > compDepth) {
    // The outermost frame being discarded holds the values that were live
    // before any of the abandoned components pushed.
    const frame = _compStack[compDepth]
    _compStack.length = compDepth
    _mountList      = frame.mounts
    _propRegistry   = frame.props
    _exportRegistry = frame.exports
    _devCompId      = frame.devCompId
  }
  if (_contextStack.length > ctxDepth) _contextStack.length = ctxDepth
}

// A reactive graph that never settles would otherwise spin inside _flush
// forever, freezing the tab with no output at all — the worst possible failure
// mode, since there is nothing to search for. Bail out loudly instead. The cap
// is far above any legitimate graph: settling normally takes a handful of
// passes, and the memo fixpoint collapses derivation chains into one.
const _MAX_FLUSH_PASSES = 1000

function _reportCycle() {
  const pending = [..._queue]
  _queue.clear()
  const sample = pending
    .slice(0, 3)
    .map((n) => n._fn?.name || (n._isDerived ? '<derivation>' : '<anonymous effect>'))
    .join(', ')
  console.error(
    `[Mesa] Update cycle detected — the reactive graph did not settle after ${_MAX_FLUSH_PASSES} ` +
    `passes, so ${pending.length} pending node(s) were dropped to keep the page responsive. ` +
    `This almost always means two reactive statements write each other's signals, ` +
    `e.g. \`$: a = b + 1\` alongside \`$: b = a + 1\`. Still pending: ${sample}`
  )
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
  const write = (next, force) => {
    // Direct write — no updater-function pattern. The compiler emits final values
    // directly (count++ → set(sig, get(sig)+1)). Calling function values here would
    // accidentally invoke snippets/callbacks stored in signals.
    //
    // `force` skips the equality guard for ONE write. It exists for the
    // self-assignment idiom `x = x` — "I mutated this in place, notify anyway" —
    // which is otherwise a no-op precisely because the reference is unchanged.
    // Per-write, never per-signal: making a signal always-notify would discard
    // the equality optimisation for every ordinary write to it.
    if (!force && eq(value, next)) return
    value = next
    for (const sub of [...self._subs]) sub._notify()
  }
  return [read, write]
}

export function createEffect(fn, opts) {
  const node = _makeNode(fn)
  // User effects — the bodies of `$:` forms — are tagged so the flush can drain
  // them AFTER everything that builds the DOM. Untagged is the default because
  // control flow (ifBlock, keyBlock, awaitBlock…) and render blocks are all
  // DOM-building work and must keep their existing relative order: an ifBlock's
  // condition has to run before the renders inside its branch, or those renders
  // fire against a branch that is about to be disposed. See _flush.
  if (opts && opts.user) node._isUserEffect = true
  // Effects that exist only to move a value through the derivation layer opt
  // into the derived tier, so they settle in the same fixpoint as memos rather
  // than racing the renders and user effects that read what they write.
  if (opts && opts.derived) node._isDerived = true
  // The first run happens here rather than through the flush, and it is where
  // component setup usually lands — a child render, an {#if} branch factory. The
  // error still propagates (a failure during setup is the caller's to see), but
  // the component stacks must not be left stranded on the way out.
  const comps = _compStack.length
  const ctxs = _contextStack.length
  try {
    node._run()
  } catch (e) {
    _unwindComponents(comps, ctxs)
    throw e
  }
  return () => _disposeNode(node, true)
}

/**
 * createRoot(fn) — run `fn` inside an owner scope that ends when you say so.
 *
 * `fn` receives a `dispose` function; whatever it returns is returned. Every
 * effect, memo and block created inside becomes a child of the root, so one
 * `dispose()` tears the whole tree down.
 *
 *   const html = createRoot((dispose) => { … ; dispose(); return out })
 *
 * This is what the top of a lifetime looks like when there is no enclosing
 * effect to own it. Without it a component rendered at the top level parents
 * its effects to nothing: they subscribe to whatever they read and no disposal
 * path can ever reach them. That is unnoticeable in a browser that mounts one
 * app and keeps it, and unbounded in a build tool that renders a thousand pages
 * against the same imported store modules — each page leaves its render effects
 * subscribed, and every later write re-runs all of them against detached DOM.
 *
 * Reads inside the root do NOT subscribe the caller's effect: `_listener` is
 * cleared for the duration. A root is ownership, not tracking.
 */
export function createRoot(fn) {
  const node = {
    _fn: null,
    _deps: new Set(),
    _cleanups: [],
    _children: [],
    _owner: _owner,
    _disposed: false,
    _notify() {},
    _run() {}
  }
  if (_owner) _owner._children.push(node)
  const prevOwner = _owner,
    prevListener = _listener
  _owner = node
  _listener = null
  try {
    return fn(() => _disposeNode(node, true))
  } finally {
    _owner = prevOwner
    _listener = prevListener
  }
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
  // opts reaches both halves. Passing it only to the memo meant the two paths
  // into the same binding compared values differently: a recompute producing an
  // `equals`-equal value stayed silent, while a manual write of that same value
  // notified, because the signal half had fallen back to Object.is.
  const [read, write] = createSignal(memo(), opts)
  // When memo recomputes (deps changed), push derived value into signal.
  // Manual writes hold until the next dep change — then derivation takes over.
  //
  // This bridge runs in the derived tier. As an ordinary effect it was ordered
  // against the renders and user effects that read this very signal, so a
  // consumer reading both the source and the derived `let` could run before the
  // bridge had pushed the new value and observe a torn pair — `src` already 2
  // while the value derived from it was still 10. Settling it with the memos
  // means everything downstream sees the derivation layer whole.
  createEffect(() => write(memo()), { derived: true })
  return [read, write]
}

export function createMemo(fn, opts) {
  const eq = opts?.equals ?? Object.is
  let value
  let dirty = true
  let computed = false // has fn() ever run?
  let moved = false    // value changed since we last told ownSubs about it
  const ownSubs = new Set()

  // Recompute now; report whether the value actually moved.
  //
  // `dirty` is cleared BEFORE fn() runs, not after. A write to one of our own
  // dependencies from inside fn() has to be able to mark us dirty again —
  // clearing afterwards erased that invalidation, and since _notify early-returns
  // while dirty is set, nothing had been propagated either. The memo then served
  // a value computed from pre-write state forever, while direct subscribers of
  // the same signal saw the new one.
  const _recompute = () => {
    for (const sig of memoNode._deps) sig._subs.delete(memoNode)
    memoNode._deps.clear()
    const prevL = _listener
    _listener = memoNode
    dirty = false
    try {
      const next = fn()
      const first = !computed
      computed = true
      // First computation: nobody has seen a previous value, so there is
      // nothing to have moved away from. Note that on later runs a truthy `eq`
      // keeps the existing value rather than the new one — for a custom
      // comparator that is the point, the old identity is the stable one.
      if (first) {
        value = next
        return false
      }
      if (eq(value, next)) return false
      value = next
      return true
    } catch (e) {
      dirty = true
      throw e
    } finally {
      _listener = prevL
    }
  }

  const memoNode = {
    _deps: new Set(),
    _cleanups: [],
    _children: [],
    _owner: _owner,
    _isDerived: true,
    _disposed: false,
    // A dependency moved. Queue ourselves, but do NOT touch ownSubs yet.
    // Whether consumers need to re-run is not knowable until fn() has run and
    // the result has been compared — and suppressing that re-run when the
    // derivation lands on the same value is the entire purpose of a memo.
    // Notifying from here instead made every `const` derivation a pass-through:
    // it cached the value but could never cut off propagation, so a memo like
    // `count > 0` re-rendered every consumer on each increment.
    _notify() {
      if (dirty || this._disposed) return
      dirty = true
      _queue.add(this)
      _scheduleFlush()
    },
    _run() {
      if (this._disposed) return
      // Nobody is listening. Stay lazy: leave `dirty` set so the next read
      // recomputes on demand, and drop any pending `moved` since there is no
      // one it could be owed to. Without this, a memo whose only consumer was
      // torn down — or one only ever read outside a reactive scope — would
      // recompute on every dependency change for the life of the page.
      if (ownSubs.size === 0) {
        moved = false
        return
      }
      if (dirty && _recompute()) moved = true
      if (!moved) return
      moved = false
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
    // Still a pull: a read that arrives before the flush reaches us recomputes
    // on demand. Remember that the value moved so _run() still propagates to
    // everyone who did not read us directly.
    if (dirty && _recompute()) moved = true
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
  if (_owner) { _owner._cleanups.push(fn); return }

  // No owner — the callback is dropped. This happens when onCleanup (or
  // $onDestroy, which forwards here) is called outside component setup and
  // outside any effect: at module scope, after an `await`, or inside a
  // callback that ran later. Silently discarding teardown is how subscriptions
  // and timers leak for the lifetime of the page, so say so.
  //
  // Reactive code outside a component is supported but deliberately
  // unadvertised — createEffect works there and returns a disposer, and nested
  // effects are owned by it. If you need cleanup at module scope, that effect
  // is the owner you're missing.
  if (typeof console !== 'undefined' && console.warn) {
    console.warn(
      '[Mesa] onCleanup() called with no owning scope — the callback will never run. ' +
      'Call it during component setup, or inside a createEffect() whose disposer you keep.'
    )
  }
}
let _mountList = null // $onMount callbacks collected during component init
let _propRegistry = null // prop signal map collected during component init
let _exportRegistry = null // `export function` methods collected during component init
export function $onMount(fn) {
  if (!_isClient) return // Rule 19: $onMount is a no-op on server
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

/**
 * Remove live siblings from `from` (inclusive) up to but not including `stop`
 * (null = to the end of the parent). `nextSibling` is read before each removal
 * so the walk survives detaching.
 *
 * This is how every block that owns a DOM *range* must remove it. Holding the
 * range's first and last nodes does not survive an inner block editing its own
 * content: inner blocks insert before their anchor, so when that anchor is the
 * outer range's first node, everything the inner block renders lands *outside*
 * the recorded range and is left on screen forever. Walking from a marker the
 * outer block owns to a stop node it also owns has no such hole.
 */
const _removeRange = (from, stop) => {
  let n = from
  while (n && n !== stop) {
    const next = n.nextSibling
    n.remove()
    n = next
  }
}

/**
 * Bound a block's DOM so its recorded [first, last] range cannot be escaped.
 * Returns [dom, first, last].
 *
 * {#each} rows and the {:else} block are removed by node range rather than by
 * the marker walk above, because rows interleave with one another and each one
 * needs its own bounds. The one way content escapes such a range is an inner
 * block whose anchor is the range's *first* node — inner blocks insert before
 * their anchor, so their content lands ahead of `first` and survives removal.
 * Anchors are always comments, so prepending a marker when the first node is a
 * comment closes that hole, and costs nothing for ordinary rows, whose first
 * node is an element or a text node.
 */
const _guardRange = (dom) => {
  if (!dom) return [dom, null, null]
  const isFrag = dom.nodeType === Node.DOCUMENT_FRAGMENT_NODE
  // Capture first/last BEFORE any insertion — fragments empty once inserted.
  let first  = isFrag ? dom.firstChild : dom
  const last = isFrag ? dom.lastChild  : dom
  if (first && first.nodeType === 8 /* COMMENT_NODE */) {
    const marker = document.createComment('')
    if (isFrag) {
      dom.insertBefore(marker, first)
    } else {
      const frag = document.createDocumentFragment()
      frag.appendChild(marker)
      frag.appendChild(dom)
      dom = frag
    }
    first = marker
  }
  return [dom, first, last]
}
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
    const v = fn()
    // `null` means "do not set this property" — every conditional style in the
    // repo is written `style:position={float ? 'absolute' : null}`. Handing
    // that null to setProperty leaves the answer to the DOM implementation:
    // happy-dom wrote the literal string for some properties and dropped it
    // for others, so one element rendered `style="position: null; z-index:
    // null;"` on the server and nothing on the client — which is exactly what
    // hydration compares.
    if (v == null || v === '') el.style.removeProperty(name)
    else el.style.setProperty(name, v)
  })
}
/**
 * The JS value an <option> stands for.
 *
 * `<option value={obj}>` stashes the real value on the element as `__value`,
 * because an attribute can only hold a string — writing an object there gives
 * you "[object Object]" and no way back. Falls back to the attribute for a
 * plain `<option value="a">`.
 */
const optionValue = (o) => ('__value' in o ? o.__value : o.value)

export function bindInput(el, name, get, set) {
  // ── <select> ───────────────────────────────────────────────────────────────
  // A select is not a property bind. `el.value` is a single string, so a
  // multi-select bound this way wrote `el.value = ['a','c']` — coerced to
  // "a,c", matching no option, clearing the selection — and read back a string
  // that replaced the caller's array, so the next render of it threw
  // `picked.join is not a function`. Both directions go through the options.
  if (name === 'value' && el.tagName === 'SELECT') {
    const handler = () => {
      const chosen = [...el.options].filter((o) => o.selected)
      set(el.multiple ? chosen.map(optionValue) : (chosen.length ? optionValue(chosen[0]) : null))
    }
    addEvent(el, 'input', handler)
    addEvent(el, 'change', handler)
    createEffect(() => {
      const v = get()
      // The options may not exist yet — an {#each} inside the select renders in
      // the same flush, and a select in a detached fragment reports none at all.
      // `_resolved.then` re-applies once they are there; with static options the
      // first pass already did the work and the second is a no-op.
      const apply = () => {
        // Snapshot: el.options is a LIVE collection and writing `selected`
        // re-derives it, so iterating it directly reads entries that have
        // already moved.
        const opts = [...el.options]
        if (el.multiple) {
          const wanted = Array.isArray(v) ? v : v == null ? [] : [v]
          for (const o of opts) o.selected = wanted.includes(optionValue(o))
        } else {
          // selectedIndex, not per-option flags: a single select must always
          // have exactly one selection, so clearing the old one and setting the
          // new one as two writes is a state the element quietly repairs.
          // -1 is the documented way to select nothing.
          const idx = opts.findIndex((o) => optionValue(o) === v)
          el.selectedIndex = idx
          // Nothing matched and the value is a plain string — let the DOM have
          // its own say, which also covers options added by other means.
          if (idx === -1 && typeof v === 'string') el.value = v
        }
      }
      apply()
      _resolved.then(apply)
    })
    return
  }

  // ── bind:files ─────────────────────────────────────────────────────────────
  // `input.files` is settable — the IDL attribute is `FileList?`, not readonly —
  // but it accepts a FileList or null and NOTHING else. The generic path wrote
  // `el.files = get() ?? ''`, so an unset `let f` assigned the empty string and
  // Chrome threw on mount with "Failed to convert value to 'FileList'". It went
  // unseen because happy-dom's setter takes any value at all.
  if (name === 'files') {
    const handler = () => set(el.files)
    addEvent(el, 'input', handler)
    addEvent(el, 'change', handler)
    createEffect(() => {
      const v = get()
      // Undefined is "the variable has no value yet", not "clear the input" —
      // clearing here would wipe a selection the user just made.
      if (v === undefined) return

      const arrayLike = v !== null && typeof v === 'object' && typeof v.length === 'number'
      // Duck-typed, not `instanceof FileList`: a FileList from another realm
      // (an iframe) fails instanceof, and so does a shimmed DOM's.
      const isFileList = arrayLike && typeof v.item === 'function'

      // Clearing. `el.files = null` is accepted by Chrome and then ignored — a
      // two-file input still holds both. Emptying the value is what clears.
      if (v === null || (arrayLike && v.length === 0)) {
        if (el.files?.length) el.value = ''
        return
      }
      if (isFileList) { el.files = v; return }

      // An array of File objects is the natural thing to reach for and the DOM
      // will not take it — `el.files = [file]` throws "Failed to convert value
      // to 'FileList'". A DataTransfer is the only way to build one, so do it
      // here rather than making every caller learn that.
      if (arrayLike && typeof DataTransfer !== 'undefined') {
        try {
          const dt = new DataTransfer()
          for (const f of v) dt.items.add(f)
          el.files = dt.files
          return
        } catch { /* not Files — fall through to the warning */ }
      }

      console.warn(
        '[Mesa] bind:files takes a FileList, an array of File objects, or null ' +
        `to clear — got ${typeof v}. The input was left alone.`
      )
    })
    return
  }

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

    // The NEAREST registered root owns the event. Roots nest whenever two
    // mounted trees sit at different depths — one island directly in <main>,
    // another inside a <div> in that <main> — and the event bubbles through
    // both, so without this every handler in the deeper tree ran once per
    // ancestor root: one click, two increments. Found by a Sierra island in a
    // scroll container; the same shape is ordinary on any real page.
    for (let i = 0; i < path.length; i++) {
      const node = path[i]
      if (node === root) break
      if (_delegateRoots.has(node)) return
    }

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

  // Registrations are counted. document.body is a delegation root for every
  // open portal at once (a menu and a toast stack, say), so the first one to
  // close must not take the listener away from the others — it used to return
  // a no-op cleanup for the second caller, which made teardown order decide
  // whether the remaining overlay still responded to clicks.
  const existing = _delegateRoots.get(root)
  if (existing) {
    existing.refs++
    return () => _releaseDelegateRoot(root)
  }

  const handler  = _makeDelegatedHandler(root)
  const attached = new Set()

  // Attach listeners for all event types registered so far
  for (const type of _delegatedEventTypes) {
    attached.add(type)
    root.addEventListener(type, handler)
  }

  _delegateRoots.set(root, { handler, attached, refs: 1 })

  return () => _releaseDelegateRoot(root)
}

function _releaseDelegateRoot(root) {
  const entry = _delegateRoots.get(root)
  if (!entry) return
  if (--entry.refs > 0) return
  for (const type of entry.attached) root.removeEventListener(type, entry.handler)
  _delegateRoots.delete(root)
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
  let unregisterRoot = null

  createEffect(() => {
    const target = getTarget()
    if (!target) return
    if (target === currentTarget) return

    // Remove from old target
    nodes.forEach((n) => n.parentNode?.removeChild(n))
    unregisterRoot?.()

    // Build fresh DOM and insert into new target
    const $dom = blockFactory()
    nodes = $dom.nodeType === Node.DOCUMENT_FRAGMENT_NODE
      ? [...$dom.childNodes]
      : [$dom]
    target.appendChild($dom)
    currentTarget = target

    // The portal target is a delegation root of its own.
    //
    // Delegated handlers are `__click` properties found by walking up from the
    // event target to a REGISTERED root, and mount() only registers the app's
    // own container. Portalled content is appended to document.body, outside
    // it, so no root ever sees the event: every menu item, command-palette row
    // and toast dismiss button in @frontierjs/ui was inert. Clicking did
    // nothing at all — no error, correct markup, correct ARIA.
    unregisterRoot = _registerDelegateRoot(target)
  })

  onCleanup(() => {
    nodes.forEach((n) => n.parentNode?.removeChild(n))
    unregisterRoot?.()
  })
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
  // An attachment runs when the element MOUNTS, and a server render has no
  // mount — the same rule that already keeps $onMount off the SSR path
  // (render.js, RULE 19). Running it there hands the function a happy-dom
  // element, which implements no Web Animations API: an attachment that
  // animates threw `el.animate is not a function` and took the WHOLE render
  // with it, so a component could not be server-rendered at all.
  if (!_isClient) return

  createEffect(() => {
    const fn = getFn()           // tracked — re-runs when expression deps change
    if (!fn) return

    let result
    let disposed = false

    const invoke = () => {
      if (disposed) return
      // Run the attachment fn itself untracked so reads inside it (e.g. signal
      // reads in logging helpers) don't subscribe and cause the effect to re-fire.
      result = untrack(() => fn(el))
      // attachment fn itself returned a Promise (less common pattern)
      if (result && typeof result.then === 'function') el.__mesa_exit = result
    }

    // Cleanup is registered SYNCHRONOUSLY, whether or not the attachment has run
    // yet: it must land on this effect's owner, and the deferral below can
    // outlive the effect body.
    onCleanup(() => {
      disposed = true
      if (typeof result !== 'function') return
      // Sync cleanup — runs on element exit, may start an exit animation.
      // If the cleanup returns a Promise, store it on the element so _removeBlock
      // can hold the DOM alive until the animation completes.
      const exitResult = result()
      if (exitResult && typeof exitResult.then === 'function') {
        // Mark element as exiting — _removeBlock will re-insert it if needed
        // and wait for this Promise before doing final DOM removal.
        el.__mesa_exit = exitResult
      }
    })

    // ── The attachment runs when the element MOUNTS (VISION §10.6) ──────────
    //
    // It used to run the moment the element was BUILT, which is before anything
    // inserts it: a component builds its tree and appends it afterwards, so
    // `el.isConnected` was false and `el.parentNode` was null in every
    // attachment in the repo. Everything an attachment is for needs a connected
    // node — `focus()` is a no-op, `getBoundingClientRect()` is all zeros, an
    // IntersectionObserver never fires — and one case is worse than useless:
    //
    //   el.animate([{ opacity: 0 }, { opacity: 1 }], { fill: 'forwards' })
    //
    // on a detached element returns an animation with `startTime: null` that
    // NEVER starts, even once the element is connected, and is not even listed
    // in `el.getAnimations()`. The element is then painted at keyframe 0 —
    // opacity 0 — forever. That is what `@frontierjs/ui`'s CommandPalette was:
    // a `position: fixed; inset: 0; z-index: 9000` backdrop, fully invisible,
    // swallowing every click on the page. ⌘K "did nothing" and froze the app.
    //
    // Deferred on a microtask, which is the same queue `$onMount` uses, so an
    // attachment now sees exactly what `$onMount` sees. An element that is
    // already connected keeps running synchronously, so nothing that was
    // ordered correctly before is reordered now — and a detached element that
    // never gets inserted still runs, one tick later, rather than silently
    // never running at all.
    if (!_isClient || el.isConnected) invoke()
    else _resolved.then(invoke)
  })
}

/**
 * Apply component-level attachments from $option.attachments.
 */
export function applyAttachments(el, fns) {
  if (!fns?.length) return
  if (!_isClient) return   // same rule as attach() above — no mount, no attachment
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

    // Capture before restoring so $push/$apply close over this instance's map.
    // Both captures and both restores live in the try/finally: an init() that
    // threw used to skip the restores below it, leaving _mountList and
    // _propRegistry pointing at the dead instance for every component that
    // mounted afterwards.
    let $dom, registry, mountList
    try {
      $dom = init($option)
      registry = _propRegistry
      mountList = _mountList
    } finally {
      _owner = prevOwner
      _listener = prevListener
      _mountList = prevMount
      _propRegistry = prevProps
      _contextStack.pop()
    }

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
  // A root mount runs outside any effect, so the flush loop's unwind cannot see
  // it. The error still propagates to the caller — it is theirs to handle — but
  // the stacks must not be left corrupted for the next mount.
  const comps = _compStack.length
  const ctxs = _contextStack.length
  try {
    component(anchor, option?.props ?? {}, null)
  } catch (e) {
    _unwindComponents(comps, ctxs)
    throw e
  }
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
  // (v, i) — an {#each} row factory is called by $$eachBlock as
  // makeItem(getItem, getIndex); the compiler emits ($parentElement, item, i)
  // for `{#each xs as x, i}`. Taking only `v` here dropped the index getter and
  // every indexed each threw "i is not a function" on first render.
  return (v, i) => {
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
    fn?.($el, v, i)
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
export function $$virtualEach(anchor, getItems, keyFn, makeRow) {
  if (!_isBrowser) return
  // Same contract as {#each} — see eachItems().
  const getArray = () => eachItems(getItems())

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
        // makeBlock factory takes (item getter, index getter)
        const $dom = makeRow(getItem, getIndex)
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

/**
 * What an {#each} may iterate.
 *
 * The block used to call `.map()` on whatever it was handed, so anything that
 * was not a real array died as `array.map is not a function` — no block name,
 * no expression, nothing to search for. An array-LIKE is the case that bit:
 * `{#each { length: 6 } as _, i}` is how a fixed-size grid gets written, and
 * `@frontierjs/ui`'s DatePicker used it in both panes, so the component threw
 * on first render and had never rendered at all.
 *
 * Anything iterable (a Set, a Map, a NodeList, a string) or array-like is
 * taken. A number or a plain object is refused BY NAME rather than converted:
 * both are typos with an obvious intent, and guessing at one produces an empty
 * list where the author expected rows.
 */
function eachItems(v) {
  if (Array.isArray(v)) return v
  if (v == null) return []
  if (typeof v === 'object' || typeof v === 'string') {
    if (typeof v[Symbol.iterator] === 'function') return Array.from(v)
    if (typeof v.length === 'number') return Array.from(v)
  }
  throw new TypeError(
    `[Mesa] {#each} needs an array, an iterable or an array-like, got ${typeof v === 'object' ? 'a plain object' : typeof v}. ` +
    (typeof v === 'number'
      ? `Write {#each { length: ${v} } as _, i} to repeat something ${v} times.`
      : `Iterate Object.entries(obj) or Object.keys(obj) to walk an object.`)
  )
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
  let elseOwner     = null   // owner node for the else block's effects

  const _showElse = () => {
    if (!elseBlock || elseNode) return
    const parent = getParent()
    if (!parent) return  // anchor detached (e.g. inside a swapped-out {#if} branch)
    // Scope the else block's effects to their own owner, the same way
    // _makeBlock does for rows.
    //
    // This used to run with whatever _owner was ambient — the eachBlock effect —
    // and teardown relied on `elseNode?.dispose?.()`, which is dead code: the
    // compiler passes a plain makeBlock factory that returns DOM and has no
    // dispose method. Since an effect never disposes its own children on re-run,
    // every empty→non-empty toggle stranded another live copy of the else
    // block's effects, growing without bound for the life of the page.
    const owner = {
      _fn: null, _deps: new Set(), _cleanups: [], _children: [],
      _owner: outerOwner, _disposed: false, _notify() {}, _run() {}
    }
    if (outerOwner) outerOwner._children.push(owner)
    elseOwner = owner
    const prevOwner = _owner
    _owner = owner
    try {
      elseNode = elseBlock()
    } finally {
      _owner = prevOwner
    }
    const [$d, first, last] = _guardRange(elseNode.$dom ?? elseNode)
    elseNodeFirst = first
    elseNodeLast  = last
    insertBefore ? parent.insertBefore($d, insertBefore) : parent.appendChild($d)
  }
  const _hideElse = () => {
    if (!elseNode) return
    removeElements(elseNodeFirst, elseNodeLast)
    elseNode?.dispose?.()
    if (elseOwner) {
      _disposeNode(elseOwner, true)
      elseOwner = null
    }
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
    const [$dom, $domFirst, $domLast] = _guardRange(result?.$dom ?? result)
    return {
      $dom, $domFirst, $domLast,
      _item: item,
      _index: index,
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

  // ── _sync ─────────────────────────────────────────────────────────────────
  // Re-point an existing block at its new (item, index).
  //
  // This used to test the item alone. A pure reorder — a keyed move, a reverse,
  // a splice — hands every surviving block the SAME item object at a new
  // position, so the test said "unchanged" and the index signal was never
  // written: `{#each xs as x, i}` rendered stale indices after any move, and
  // two rows could end up displaying the same i. The index is a signal in its
  // own right, so it has to be part of the comparison.
  const _sync = (block, item, index) => {
    if (item === block._item && index === block._index) return
    block._item = item
    block._index = index
    block.rebind?.(item, index)
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
    const array  = eachItems(getArray())
    const newLen = array.length

    // ── Fast path: clear ────────────────────────────────────────────────────
    if (newLen === 0) {
      if (blocks.size > 0) {
        // Snapshot each block's DOM range before disposing anything, so the
        // removal below knows exactly which nodes belong to this {#each}.
        const ranges = []
        for (const [, b] of blocks) if (b.$domFirst) ranges.push([b.$domFirst, b.$domLast])
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
            // Remove exactly the ranges this {#each} owns. Walking backwards
            // from the anchor with `while (anchor.previousSibling)` instead
            // assumed the block was the only thing before it in the parent, so
            // emptying the array also destroyed any static markup or other
            // blocks' content that happened to precede it — a `<h2>` and a
            // toolbar `<div>` above an {#each} both vanished on clear.
            for (const [first, last] of ranges) removeElements(first, last)
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
      _sync(b, array[j], j)
      newBlocks[j] = b
      j++
    }

    // ── Tail scan ───────────────────────────────────────────────────────────
    // Skip matching keys at the end — these blocks are already in place
    let a_end = oldLen - 1
    let b_end = newLen - 1
    while (a_end >= j && b_end >= j && prevKeys[a_end] === newKeys[b_end]) {
      const b = oldBlocks[a_end]
      _sync(b, array[b_end], b_end)
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
        _sync(b, array[j + i], j + i)
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
    // A comment inserted immediately before the branch content, marking where
    // this branch starts. The branch used to be tracked by holding its first and
    // last DOM nodes, but an inner block that swaps its own content — {#await}
    // replacing the pending node when the promise resolves — removes exactly
    // those nodes. Removal then walked from a detached node whose nextSibling is
    // null, removed nothing, and the branch stayed on screen forever.
    //
    // The marker is created and owned by ifBlock, so nothing inside the branch
    // can remove it, and removal walks live siblings from it to the anchor —
    // whatever the branch did to its own contents in between.
    startMarker = null,
    currentBranchNode = null   // owner node for the active branch's effects

  const _removeBlock = () => {
    if (startMarker == null) return
    // Before disposing, capture the parent and sibling for potential re-insertion.
    const parent = noAnchor ? anchor : anchor.parentNode
    const afterNode = noAnchor ? null : anchor
    const stop = noAnchor ? null : anchor

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
      let node = startMarker.nextSibling
      while (node && node !== stop) {
        collectExiting(node)
        node = node.nextSibling
      }
    }

    // Remove the branch DOM — marker included.
    _removeRange(startMarker, stop)
    startMarker = null

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
    const marker = document.createComment('')
    if (noAnchor) {
      parent.appendChild(marker)
      parent.appendChild(node)
    } else {
      parent.insertBefore(marker, anchor)
      parent.insertBefore(node, anchor)
    }
    startMarker = marker
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

  // A comment inserted immediately before the keyed content, owned by keyBlock.
  // Removal walks live siblings from it to the anchor, so an inner block that
  // rewrites its own content between mount and teardown — an {#await} swapping
  // its pending node for the resolved one — cannot strand anything. Holding the
  // content's first/last nodes left the resolved content on screen and appended
  // the new key's copy beside it.
  let startMarker = null
  let blockNode   = null
  // Track the last key value so we only remount when it actually changes.
  // Without this, if the key expression is a memo that re-runs due to an upstream
  // signal change (e.g. chain prop updating) but returns the same value (e.g. same
  // component function reference), keyBlock would still tear down and remount its
  // content — causing layout components to re-run their instance scripts on every nav.
  const _UNSET = Symbol()
  let prevKey = _UNSET

  const _remove = () => {
    // Dispose effects before removing DOM — cleanups may touch the nodes.
    if (blockNode) { _disposeNode(blockNode, true); blockNode = null }
    if (startMarker == null) return
    _removeRange(startMarker, noAnchor ? null : anchor)
    startMarker = null
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
    const marker = document.createComment('')
    if (noAnchor) {
      parent.appendChild(marker)
      parent.appendChild(node)
    } else {
      parent.insertBefore(marker, anchor)
      parent.insertBefore(node, anchor)
    }
    startMarker = marker
  })
}



export function awaitBlock(anchor, getPromise, pendingBlock, thenBlock, catchBlock) {
  if (!_isBrowser)
    throw new Error(
      '@frontierjs/mesa-runtime: awaitBlock() called in a non-browser environment. ' +
        'Use the Mesa SSR compiler target.'
    )

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

  // The branch is delimited by a marker comment awaitBlock owns, not by the
  // branch's own first/last nodes — a nested block whose anchor is the first
  // node of this branch renders *before* that anchor, i.e. outside a
  // first/last range, and the old branch stayed on screen beside the new one.
  const _swap = ($dom) => {
    const parent = anchor.parentNode
    if (!parent) return
    if (startMarker) {
      _removeRange(startMarker, anchor)
      startMarker = null
    }
    if ($dom) {
      const marker = document.createComment('')
      parent.insertBefore(marker, anchor)
      parent.insertBefore($dom, anchor)
      startMarker = marker
    }
  }
  let startMarker = null
  let contentNode = null   // owner for the effects inside the mounted branch

  const _disposeContent = () => {
    if (!contentNode) return
    _disposeNode(contentNode, true)
    contentNode = null
  }

  // Build a branch under its own owner, tearing down the previous branch's
  // owner first.
  //
  // {:then} and {:catch} content is created inside promise callbacks, where the
  // module-global _owner is whatever happens to be running at microtask time —
  // normally null, occasionally an unrelated component mid-setup. Effects
  // created there were parented to nothing, so no disposal path could ever
  // reach them: they survived the component that created them and kept
  // responding to signal writes for the life of the page.
  const _mount = (outerOwner, factory, ...args) => {
    _disposeContent()
    if (!factory) { _swap(null); return }
    const node = {
      _fn: null, _deps: new Set(), _cleanups: [], _children: [],
      _owner: outerOwner, _disposed: false, _notify() {}, _run() {}
    }
    if (outerOwner) outerOwner._children.push(node)
    contentNode = node
    const prev = _owner
    _owner = node
    try { _swap(_resolve(factory, ...args)) } finally { _owner = prev }
  }

  createEffect(() => {
    // The enclosing effect node — branch owners hang off it, and are removed
    // from its children on swap so re-runs cannot accumulate them.
    const outerOwner = _owner
    const promise = getPromise()
    if (!promise?.then) {
      _mount(outerOwner, thenBlock, promise)
      return
    }
    _mount(outerOwner, pendingBlock)
    let active = true
    onCleanup(() => {
      active = false
      _disposeContent()
    })
    promise.then(
      (value) => {
        if (active) _mount(outerOwner, thenBlock, value)
      },
      (err) => {
        if (active) _mount(outerOwner, catchBlock, err)
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

  let contentMounted = false
  let startMarker  = null   // comment delimiting the mounted branch, owned here
  let branchNode   = null   // owner node for the mounted branch's effects

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
    if (startMarker) {
      _removeRange(startMarker, anchor)
      startMarker = null
    }
    const node = $dom ? $dom.$dom ?? $dom : null
    if (node) {
      const marker = document.createComment('')
      parent.insertBefore(marker, anchor)
      parent.insertBefore(node, anchor)
      startMarker = marker
    }
  }

  // Build a branch under its own owner, disposing the previous branch's owner
  // first.
  //
  // Branch content used to be built with whatever _owner was ambient — the
  // boundary's own effect node — and an effect never disposes its own children
  // on re-run. So every swap (pending → content, content → failed, …) left the
  // outgoing branch's effects alive: they kept re-running on every write to
  // anything they read, rendering into DOM that had already been detached, for
  // the life of the page, one more set per swap.
  const _mountBranch = (outerOwner, factory, ...args) => {
    if (branchNode) {
      _disposeNode(branchNode, true)
      branchNode = null
    }
    if (!factory) { _swap(null); return }
    const node = {
      _fn: null, _deps: new Set(), _cleanups: [], _children: [],
      _owner: outerOwner, _disposed: false, _notify() {}, _run() {}
    }
    if (outerOwner) outerOwner._children.push(node)
    branchNode = node
    const prev = _owner
    _owner = node
    try { _swap(_callSnippetBlock(factory, ...args)) } finally { _owner = prev }
  }

  createEffect(() => {
    // The enclosing effect node — branch owners hang off it, and are removed
    // from its children on swap so re-runs cannot accumulate them.
    const outerOwner = _owner
    const states = getStates()
    // Error wins — show failed if any state has an error
    const errState = states.find(s => s.error !== null)
    if (errState) {
      contentMounted = false
      _mountBranch(outerOwner, failedBlock, errState.error)
      return
    }
    // First-load gate — show pending while any state is still loading
    if (states.some(s => s.loading)) {
      _mountBranch(outerOwner, pendingBlock)
      return
    }
    // All resolved — mount content once and leave it
    if (!contentMounted) {
      contentMounted = true
      _mountBranch(outerOwner, contentBlock)
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

/**
 * restProps — everything the caller passed that the component did not declare.
 *
 * Backs `$attributes`. A component kit cannot enumerate every attribute a
 * caller might need — `id`, `aria-label`, `title`, `data-*`, `form` — and
 * before this, `$attributes` was `$option.props` unfiltered, so spreading it
 * put `tone="danger" variant="ghost"` on the DOM node beside them.
 *
 * `class` never comes through: it arrives as the `$class` prop and is applied
 * by bindClassPassthrough, which MERGES. Spreading it here would replace the
 * element's own classes — including the scope class — instead.
 *
 * @param {object} props     — $option.props
 * @param {string[]} declared — prop names the component declared
 */
export function restProps(props, declared) {
  const out = {}
  if (!props) return out
  const skip = new Set([...(declared ?? []), 'class', '$class'])
  for (const k in props) if (!skip.has(k)) out[k] = props[k]
  return out
}

/**
 * Settable property descriptors for an element, from its WHOLE prototype chain.
 *
 * One level is not enough and the difference is not academic: `value` is on
 * HTMLInputElement.prototype, but `onclick` is on HTMLElement.prototype and
 * `id` on Element.prototype. Reading only getPrototypeOf(el) found the first
 * and missed the other two, so spread sent them down the setAttribute path.
 * Cached per prototype — the chain never changes for a given element type.
 */
const _protoDescCache = new WeakMap()
function _protoDescs(el) {
  const proto = Object.getPrototypeOf(el)
  let descs = _protoDescCache.get(proto)
  if (!descs) {
    descs = {}
    for (let o = proto; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(o))) {
        if (!(k in descs)) descs[k] = d
      }
    }
    _protoDescCache.set(proto, descs)
  }
  return descs
}

export function spreadAttributes(el, fn) {
  const propDescs = _protoDescs(el)
  let prev = {}
  const _set = (k, v) => {
    if (k === 'style') { el.style.cssText = v ?? ''; return }
    // A function is never a meaningful attribute string. `<Btn onclick={fn}>`
    // forwarded through {...$attributes} used to reach the DOM as
    // onclick="() => $$set_clicks(…)" — the handler stringified into an inline
    // attribute, where it silently never fires.
    if (typeof v === 'function' || typeof prev[k] === 'function' || propDescs[k]?.set) {
      el[k] = v ?? null
      return
    }
    v == null ? el.removeAttribute(k) : el.setAttribute(k, '' + v)
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
      // Read all deps to subscribe this effect node to their signals.
      // A dep is a read function (watchPath) or a tracked object (track) —
      // the compiler emits both shapes, so read through get(), which handles
      // each. Calling dep() directly threw "dep is not a function" on mount
      // for every `$: { dep, () => … }` group with a local signal dep.
      for (const dep of entry.deps) get(dep)
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

// ─── Watch trie ───────────────────────────────────────────────────────────────
//
// A watch declared at path P covers P and everything beneath it:
//
//   $: page                     → the whole object opts into deep reactivity
//   $: page.user.preferences    → that subtree only
//   $: page.user.name           → unaffected by writes under .preferences
//
// The declared paths are stored as a trie of key segments rather than as
// dot-joined strings. Strings looked simpler but could not express the rule
// correctly:
//
//   * A key containing a dot was indistinguishable from a path. Writing
//     `obj['a.real'] = 1` produced the path "a.real", whose textual parent is
//     "a" — so it woke a watcher on `obj.a`, an unrelated property. i18n
//     catalogs, API payloads and CSS-ish maps all hit this.
//   * Resolving a read to its covering watch meant slicing the string once per
//     level, inside a get trap that already runs once per level — quadratic in
//     nesting depth.
//
// Segments fix both by construction: a key is one segment whatever it contains,
// ancestry is a parent pointer, and `cover` is precomputed so a read resolves in
// constant time.
//
// Each node holds:
//   sig      the watch declared exactly here, or null
//   cover    the nearest watch at or above here — what a read subscribes to
//   children Map<segment, node>
//   parent   for the ancestor walk on write
function _watchNode(parent) {
  return { sig: null, cover: parent ? parent.cover : null, children: new Map(), parent }
}

function _watchChild(node, key) {
  return node ? node.children.get(key) ?? null : null
}

// Descending into a property nobody declared a watch for still has to remember
// where it is: a write down there must notify the ancestors that cover it. The
// trie is not grown to record it — every read would allocate a node — so the
// position is an off-trie marker that carries the ancestor's cover and points
// back at it. All unwatched siblings resolve identically, so one marker per
// parent is enough, and descending further reuses it rather than chaining.
const _NO_CHILDREN = new Map()
function _watchDescend(node, key) {
  const child = _watchChild(node, key)
  if (child) return child
  if (!node || node.children === _NO_CHILDREN) return node
  return node._off ??
    (node._off = { sig: null, cover: node.cover, children: _NO_CHILDREN, parent: node })
}

function _watchEnsure(root, segments) {
  let n = root
  for (const seg of segments) {
    let c = n.children.get(seg)
    if (!c) { c = _watchNode(n); n.children.set(seg, c) }
    n = c
  }
  return n
}

// Declaring a watch changes what everything beneath it resolves to, so `cover`
// is recomputed for the affected subtree. Only nodes without their own `sig`
// inherit — a finer watch already covering itself keeps winning. Registration
// happens during component init; reads happen on every render, which is why the
// cost lives here rather than in the get trap.
function _watchRefreshCover(node) {
  node.cover = node.sig ?? (node.parent ? node.parent.cover : null)
  if (node._off) node._off.cover = node.cover
  for (const child of node.children.values()) _watchRefreshCover(child)
}

// A read of node[key] subscribes to the nearest watch covering it: the child's
// own cover when that segment is declared, otherwise the container's.
function _watchSubscribe(node, key) {
  const child = _watchChild(node, key)
  const sig = child ? child.cover : node && node.cover
  if (sig) sig.read()
}

// A write at node[key] notifies every watch that covers it — the exact segment
// if declared, then each ancestor up to the root. Firing only the immediate
// parent, as the string version did, meant `$: a` saw `a.e` but not `a.b.c`: a
// subtree watch that worked at depth one and silently stopped at depth two.
function _watchFire(node, key) {
  let n = _watchChild(node, key) || node
  while (n) {
    if (n.sig) n.sig.fire()
    n = n.parent
  }
}

// Two-level registry: WeakMap<rootObj, Map<path, Proxy>>
// Keyed by (rootObj, path) to prevent cross-component contamination.
const _nestedProxyCache = new WeakMap() // rootObj → Map<childPath, { target, node, proxy }>
const _rootProxyCache   = new WeakMap() // rootObj → rootProxy
const _proxyToRoot      = new WeakMap() // proxy → rootObj (reverse, for unproxy)
const _signalRegistry   = new WeakMap() // rootObj → root watch node

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

function _getNestedProxy(rootObj, path, target, node) {
  if (!_nestedProxyCache.has(rootObj)) _nestedProxyCache.set(rootObj, new Map())
  const cache = _nestedProxyCache.get(rootObj)

  // Keyed by path AND the object that path currently holds. Caching on path
  // alone meant that replacing an object-valued property left the old child
  // proxy in place forever:
  //
  //   cart.items = ['c']
  //   cart.items        // → ['c']        (raw object, correct)
  //   proxy.items       // → ['a','b']    (stale child proxy)
  //
  // so a template reading `{cart.items}` rendered the previous value after any
  // reassignment. Primitives were unaffected, which made it look intermittent.
  // Comparing the cached target self-heals however the value changed, including
  // writes that bypassed the proxy, and covers descendants too — their targets
  // differ as soon as the parent is replaced.
  // `node` is part of the identity too: the same object reachable at two paths
  // needs a proxy per path, because each carries a different watch node.
  const hit = cache.get(path)
  if (hit && hit.target === target && hit.node === node) return hit.proxy

  const proxy = _buildProxy(target, rootObj, node, path)
  cache.set(path, { target, node, proxy })
  return proxy
}

// proxy → the raw object it wraps. Used to strip proxies back out on write; the
// existing _proxyToRoot only covers root proxies, not nested ones.
const _proxyTarget = new WeakMap()

// Objects that carry internal slots break when their methods are invoked with
// `this` bound to a Proxy — `p.when.getTime()` threw "this is not a Date
// object", `p.tags.add(x)` threw "incompatible receiver". Wrapping them bought
// nothing anyway: their contents live in slots the get/set traps never observe,
// so they could never have been reactive. Hand them through untouched, where
// they work normally and are simply inert state.
//
// A class instance with private fields has the same problem and is NOT excluded
// here — excluding it would silently drop reactivity for ordinary classes, which
// do work. Private-field classes remain unsupported inside watched state.
function _isOpaque(v) {
  const c = v.constructor
  if (c === Object || c === Array || c === undefined) return false // fast path
  return (
    v instanceof Date || v instanceof Map || v instanceof Set ||
    v instanceof RegExp || v instanceof Promise ||
    v instanceof WeakMap || v instanceof WeakSet || v instanceof Error ||
    v instanceof ArrayBuffer || ArrayBuffer.isView(v)
  )
}

// True for a plain object or array — something that cannot have private fields,
// so its accessors are safe to invoke with the proxy as `this`. Computed once
// per proxy rather than per read.
function _isPlainContainer(o) {
  if (Array.isArray(o)) return true
  const p = Object.getPrototypeOf(o)
  return p === Object.prototype || p === null
}

// Strip watch proxies out of a value on its way into raw state.
//
// Reading an object-valued property hands back a proxy, so the ordinary
// patterns write proxies into the user's plain object:
//
//   state.selected = state.items[0]        // stores a Proxy
//   state.items    = state.items.filter(…) // stores an array OF proxies
//
// after which `items.indexOf(selected)` is -1, structuredClone throws, and the
// store the producing module is supposed to own is no longer plain JavaScript.
// Fresh containers built by user code are cleaned too, since filter/map/spread
// carry proxies out element-wise. Nothing is allocated unless something
// actually needs replacing.
function _unwrapValue(v, seen) {
  if (v === null || typeof v !== 'object') return v
  const raw = _proxyTarget.get(v)
  if (raw !== undefined) return raw // a proxy's target is already clean
  if (_isOpaque(v)) return v
  if (seen) { if (seen.has(v)) return v } else seen = new Set()
  seen.add(v)
  if (Array.isArray(v)) {
    let out = null
    for (let i = 0; i < v.length; i++) {
      const c = _unwrapValue(v[i], seen)
      if (c !== v[i]) { if (!out) out = v.slice(); out[i] = c }
    }
    return out ?? v
  }
  if (!_isPlainContainer(v)) return v
  let out = null
  for (const k of Object.keys(v)) {
    const c = _unwrapValue(v[k], seen)
    if (c !== v[k]) { if (!out) out = { ...v }; out[k] = c }
  }
  return out ?? v
}

function _buildProxy(obj, rootObj, node, pathPrefix) {
  if (typeof obj !== 'object' || obj === null) return obj

  // Accessors must run with the proxy as `this` so their own reads subscribe —
  // `get full() { return this.first + ' ' + this.last }` was invoked against the
  // raw object, so nothing inside it was ever tracked and the value froze.
  // Restricted to plain containers: a class instance reached through Reflect
  // with a proxy receiver cannot touch its private fields.
  const viaReceiver = _isPlainContainer(obj)

  const proxy = new Proxy(obj, {
    get(target, key, receiver) {
      // Symbols are protocol lookups (Symbol.iterator, Symbol.toPrimitive…),
      // never watchable state — they must not create subscriptions or paths.
      if (typeof key === 'symbol') return target[key]
      const value = viaReceiver ? Reflect.get(target, key, receiver) : target[key]
      if (Array.isArray(target) && _ARRAY_MUTATORS.has(key) && typeof value === 'function') {
        return (...args) => {
          const result = target[key].apply(target, args)
          // A mutator changes the container itself, so fire from this node up.
          let n = node
          while (n) { if (n.sig) n.sig.fire(); n = n.parent }
          return result
        }
      }
      // Subscribe the current reactive effect to the watch covering this
      // property. This wires template bindings (bindText(() => proxy.count))
      // to re-run when a covering watch fires.
      if (_listener) _watchSubscribe(node, key)
      if (typeof value === 'object' && value !== null && !_isOpaque(value)) {
        const childPath = pathPrefix ? `${pathPrefix}.${key}` : key
        return _getNestedProxy(rootObj, childPath, value, _watchDescend(node, key))
      }
      return value
    },
    set(target, key, value) {
      target[key] = _unwrapValue(value)
      if (typeof key !== 'symbol') _watchFire(node, key)
      return true
    },
    // Without this trap `delete obj.k` reached the raw object directly and fired
    // nothing, so a whole-object watch — which is supposed to catch any change —
    // kept rendering the deleted value.
    deleteProperty(target, key) {
      const had = Object.prototype.hasOwnProperty.call(target, key)
      delete target[key]
      if (had && typeof key !== 'symbol') _watchFire(node, key)
      return true
    }
  })
  _proxyTarget.set(proxy, obj)
  return proxy
}

export function watchProxy(obj) {
  if (!_isClient) return obj // Rule 19: path watches are no-ops on server
  if (typeof obj !== 'object' || obj === null) return obj

  // Already a watch proxy — hand it straight back.
  //
  // Wrapping a proxy again used to build a second layer, and the result failed
  // silently: watchPath would key its signal by the OUTER proxy while the inner
  // set trap fires signals keyed by the raw object, so a write never reached a
  // watcher and nothing re-rendered. That happens whenever a module exports
  // `watchProxy(state)` rather than the plain object — an easy and reasonable
  // thing to write. Idempotent is the only safe behaviour here.
  if (_proxyToRoot.has(obj)) return obj

  if (_rootProxyCache.has(obj)) return _rootProxyCache.get(obj)
  if (!_signalRegistry.has(obj)) _signalRegistry.set(obj, _watchNode(null))
  const proxy = _buildProxy(obj, obj, _signalRegistry.get(obj), '')
  _rootProxyCache.set(obj, proxy)
  _proxyToRoot.set(proxy, obj)   // reverse map for unproxy
  return proxy
}

// A watch whose final segment is a getter can never fire: no write ever targets
// that path, because the value is derived. Since getters now run against the
// proxy, watching what the getter *reads* works — so the fix is always to hand.
// Silently inert reactivity is the failure mode this whole design is trying to
// avoid, so say so rather than let it look like a runtime bug.
const _warnedAccessors = new WeakSet()
function _warnAccessorWatch(target, path) {
  if (!path || typeof console === 'undefined' || !console.warn) return
  const segs = path.split('.')
  let o = target
  for (let i = 0; i < segs.length - 1; i++) {
    o = o?.[segs[i]]
    if (o === null || typeof o !== 'object') return
  }
  if (o === null || typeof o !== 'object') return
  const last = segs[segs.length - 1]
  for (let proto = o; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    const d = Object.getOwnPropertyDescriptor(proto, last)
    if (!d) continue
    // A setter means the path really is written, so the watch is meaningful.
    if (d.get && !d.set && !_warnedAccessors.has(d.get)) {
      _warnedAccessors.add(d.get)
      console.warn(
        `[Mesa] $: ${path} watches a getter, so it will never fire — nothing ever ` +
        `writes that path. Watch what the getter reads instead (e.g. the properties ` +
        `it derives from), or watch the whole object.`
      )
    }
    return
  }
}

export function watchPath(obj, path) {
  if (!_isClient) return [() => undefined, () => {}] // Rule 19: no-op on server

  // Normalize a proxy to its root. The signal registry is keyed by the raw
  // object because that is what the proxy's set trap fires against — registering
  // against a proxy instead would create a signal nothing ever notifies.
  const target = _proxyToRoot.get(obj) ?? obj

  _warnAccessorWatch(target, path)
  if (!_signalRegistry.has(target)) _signalRegistry.set(target, _watchNode(null))
  // An empty path is the whole-object watch, which is simply the root node —
  // no sentinel key needed once paths are segments.
  const node = _watchEnsure(_signalRegistry.get(target), path ? path.split('.') : [])
  if (!node.sig) {
    // equals:()=>false makes every write notify, so the value carried is
    // irrelevant — these signals are pure edge triggers.
    const [read, write] = createSignal(undefined, { equals: () => false })
    node.sig = { read, fire: () => write(undefined), tuple: [read, write] }
    _watchRefreshCover(node)
  }
  return node.sig.tuple
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
  if (!_isClient) return obj // Rule 19: path watches are no-ops on server
  if (typeof obj !== 'object' || obj === null) return obj
  return _buildLocalProxy(obj, signalMap, _localTrie(signalMap))
}

// The compiler hands local watches over as a flat { dotPath: [read, fire] } map
// with '' for the whole object. Compiling it into the same trie the imported
// path watches use means one set of subtree rules for both, instead of two
// engines with the same intent and different edge cases. The old prefix-match
// version had the depth bug in its own shape: _fireLocalSignals returned as soon
// as it found an exact match, so declaring `$: a.b.c` alongside `$: a` stopped
// the write at a.b.c from ever reaching `a`.
const _localTrieCache = new WeakMap() // signalMap → root watch node

function _callLocalRead(r) {
  // Either a raw getter (old style) or a track() wrapper (new style).
  if (typeof r === 'function') r()
  else if (r?._read) r._read()
  else if (r?._isMemo) r._memo()
}

function _localTrie(signalMap) {
  let root = _localTrieCache.get(signalMap)
  if (root) return root
  root = _watchNode(null)
  for (const [path, fns] of Object.entries(signalMap)) {
    const node = _watchEnsure(root, path ? path.split('.') : [])
    node.sig = { read: () => _callLocalRead(fns[0]), fire: fns[1] }
  }
  _watchRefreshCover(root)
  _localTrieCache.set(signalMap, root)
  return root
}

function _buildLocalProxy(obj, signalMap, node) {
  if (typeof obj !== 'object' || obj === null) return obj

  // Same reasoning as _buildProxy — see the comments there.
  const viaReceiver = _isPlainContainer(obj)

  const proxy = new Proxy(obj, {
    get(target, key, receiver) {
      if (typeof key === 'symbol') return target[key]
      const value = viaReceiver ? Reflect.get(target, key, receiver) : target[key]

      if (Array.isArray(target) && _ARRAY_MUTATORS.has(key) && typeof value === 'function') {
        return (...args) => {
          const result = target[key].apply(target, args)
          let n = node
          while (n) { if (n.sig) n.sig.fire(); n = n.parent }
          return result
        }
      }

      if (_listener) _watchSubscribe(node, key)

      if (typeof value === 'object' && value !== null && !_isOpaque(value)) {
        return _buildLocalProxy(value, signalMap, _watchDescend(node, key))
      }
      return value
    },
    set(target, key, value) {
      target[key] = _unwrapValue(value)
      if (typeof key !== 'symbol') _watchFire(node, key)
      return true
    },
    deleteProperty(target, key) {
      const had = Object.prototype.hasOwnProperty.call(target, key)
      delete target[key]
      if (had && typeof key !== 'symbol') _watchFire(node, key)
      return true
    }
  })
  _proxyTarget.set(proxy, obj)
  return proxy
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
    mounts: _mountList, props: _propRegistry, exports: _exportRegistry,
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
  _exportRegistry = null   // stays null unless the component declares a method

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
  const exports   = _exportRegistry
  _owner          = frame.owner
  _listener       = frame.listener
  _mountList      = frame.mounts
  _propRegistry   = frame.props
  _exportRegistry = frame.exports
  _devCompId      = frame.devCompId   // restore enclosing component's id
  _contextStack.pop()
  _resolved.then(() => {
    for (const fn of mountList) {
      const result = _safeCall(fn)
      if (typeof result === 'function') rootNode._cleanups.push(result)
    }
  })
  rootNode._registry = registry
  rootNode._exports  = exports
}

/**
 * registerExports — the child half of `bind:this` on a component.
 *
 * Emitted once per component that declares `export function`, with the methods
 * as a plain object. Props are not passed here: they are already in the prop
 * registry, and reading them through it is what keeps `ref.count` live rather
 * than a copy taken at mount.
 */
export function registerExports(methods) {
  _exportRegistry = _exportRegistry ? { ..._exportRegistry, ...methods } : methods
}

// ── Component prop registry — keyed by anchor comment node ────────────────────
// When a parent mounts a child with reactive props, it needs to push new values
// into the child's prop signals. The child registers its prop signals via
// makeExternalProperty into _propRegistry, which pop_component stores on
// rootNode._registry. We map anchor → registry so the parent can call pushProps.

const _componentRegistry = new WeakMap()
const _componentExports  = new WeakMap()

export function registerComponentAnchor(anchor) {
  // Called immediately after ComponentFn(anchor, props, null) returns.
  // At that point _owner is back to the parent, and the child rootNode is the
  // last child of the current owner (added by push_component's rootNode setup).
  const parentOwner = _owner
  const childNode = parentOwner?._children?.[parentOwner._children.length - 1]
  if (childNode?._registry) {
    _componentRegistry.set(anchor, childNode._registry)
  }
  if (childNode?._exports) {
    _componentExports.set(anchor, childNode._exports)
  }
}

/**
 * componentApi — what `bind:this={ref}` on a component resolves to (VISION
 * §10.2, RULE 36): the child's exported interface, never a DOM node.
 *
 * Props are accessors onto the child's own signals, so `ref.count` is the
 * current value and `ref.count = 2` writes it — a snapshot taken at mount would
 * be stale by the first interaction. Methods come from `export function`.
 *
 * The anchor is a comment node the parent owns, so a component that exports
 * nothing still answers an object rather than a node the caller would then try
 * to call `.focus()` on.
 */
export function componentApi(anchor) {
  const registry = _componentRegistry.get(anchor)
  const methods  = _componentExports.get(anchor)
  const api = {}
  if (registry) {
    for (const [name, prop] of registry) {
      Object.defineProperty(api, name, {
        enumerable: true,
        get: () => prop.get(),
        set: (v) => prop.set(v),
      })
    }
  }
  if (methods) for (const name in methods) api[name] = methods[name]
  return api
}

/**
 * bindProp — the child→parent half of `<Child bind:value={x} />`.
 *
 * `pushProps` already carries parent→child. This subscribes to the child's own
 * prop signal and writes changes back out, which is what makes the binding
 * two-way. No loop: the write lands on the parent's signal, whose equality check
 * stops it when the value is the one that came from the child.
 *
 * Emitted by the compiler immediately after `registerComponentAnchor`, so the
 * child's registry exists by the time this runs.
 *
 * @param {Comment}  anchor    — the child's anchor node
 * @param {string}   name      — prop name, without the `bind:` prefix
 * @param {Function} setParent — the parent's setter for the bound variable
 */
export function bindProp(anchor, name, setParent) {
  const registry = _componentRegistry.get(anchor)
  if (!registry) return
  const prop = registry.get(name)
  if (!prop) {
    console.warn(
      `[Mesa] bind:${name} — the child component does not declare \`export let ${name}\`. ` +
      `Two-way binding needs a writable prop on both sides (RULE 22).`
    )
    return
  }
  createEffect(() => { setParent(prop.get()) })
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

// ── Islands — server-render markers for client:* components ───────────────────
//
// A prerendered page is inert HTML. A client loader that wants to make one
// island interactive has to find it, and the markup alone does not say which
// nodes came from which component — `<article><p>x</p><button>0</button></article>`
// carries nothing to distinguish the island from the static text beside it.
// These markers are that missing identity.
//
// Why comments and not a `<mesa-island>` element. An element wrapper is easier
// to query, and it is what SSR_SPEC W3 originally sketched, but it is wrong in
// two ways that fail silently:
//
//   - HTML parsing. An element between `<table>` and `<td>` is foster-parented
//     out of the table by the real parser, so an island rendering rows would
//     have its wrapper — and the association it carries — relocated before any
//     loader ran. Comments are legal wherever content is.
//   - Layout and selectors. A wrapper element takes part in `>` selectors and
//     in flex/grid layout, so a page would style differently prerendered than
//     it does client-rendered. `display: contents` fixes the layout half and
//     nothing fixes the selector half.
//
// Comments cost the loader a TreeWalker instead of querySelectorAll, and buy
// output that is byte-for-byte the same shape the client runtime produces.
// They also fit Mesa's own convention: every block directive already delimits
// itself with comment anchors, and `renderToHTML({ keepAnchors: true })` exists
// to preserve them.
//
// Shape:
//   <!--mesa-island {"component":"Counter","directive":"load","props":{…}}-->
//   …prerendered markup…
//   <!--/mesa-island-->
//
// Mounting one on the client needs no new protocol, because the markers are
// ordinary comment nodes: remove everything between them, then
//
//   mount(openComment, Comp, { props })
//
// `mount` inserts its anchor immediately after the node it is given and the
// component renders before that, so the component lands exactly in the range
// the prerendered markup vacated. It must be `mount` and not a bare
// `Comp(anchor, props, null)`: a direct call produces the right markup and
// registers no delegation root, so the island comes back inert. Pinned by a
// click in render-ssr.test.js.

const ISLAND_OPEN  = 'mesa-island '
const ISLAND_CLOSE = '/mesa-island'

function islandPayload(props, meta) {
  const payload = {
    component: meta?.component ?? null,
    directive: meta?.directive ?? 'load',
  }
  if (meta?.media) payload.media = meta.media
  if (props && typeof props === 'object' && Object.keys(props).length) payload.props = props

  const dropped = []
  let json
  try {
    json = JSON.stringify(payload, (key, value) => {
      if (typeof value === 'function' || typeof value === 'symbol') { dropped.push(key); return undefined }
      return value
    })
  } catch (e) {
    // Circular reference, BigInt, or a throwing toJSON. The island is still
    // worth marking — a loader can mount it with its own defaults — so degrade
    // to identity only rather than losing the marker altogether.
    console.warn(
      `[Mesa island] <${payload.component}> props could not be serialized (${e.message}). ` +
      `The marker is emitted without props; a client loader will mount this island with none.`
    )
    delete payload.props
    json = JSON.stringify(payload)
  }
  if (dropped.length) {
    console.warn(
      `[Mesa island] <${payload.component}> — ${dropped.join(', ')} dropped from the island marker. ` +
      `Functions and symbols do not survive JSON, so a client loader remounts this island without them. ` +
      `Pass serializable props to an island, or mount it from the client instead.`
    )
  }
  // Escape every `-` and `>` out of the payload.
  //
  // Only `-->` (and `--!>`) actually terminates a comment per the HTML spec, so
  // escaping `--` would be enough for a conforming parser. It is not enough in
  // practice: happy-dom 14.12.3 — the parser this package's own SSR tests use —
  // ends a comment at the FIRST `>`, so a prop value containing one truncated
  // the marker into two, and `JSON.parse` then threw on a fragment. Leaving no
  // `>` in the payload at all makes it read identically under both rules, which
  // is worth six bytes per occurrence.
  //
  // Both substitutions are inside JSON strings by construction — a number
  // cannot contain `-` except a leading minus or an exponent, neither of which
  // can produce `--`, and `>` occurs nowhere else in JSON — so `-` and
  // `>` parse back to exactly the original characters.
  return json.replace(/--/g, '\\u002d\\u002d').replace(/>/g, '\\u003e')
}

/**
 * Mount a component that carries a `client:*` directive.
 *
 * Emitted by the compiler in place of a direct component call, and only when
 * compiling with `{ islands: true }` (VISION RULE 26). Behaviour splits on the
 * environment, not on the flag:
 *
 *   - Real client: identical to the direct call the compiler used to emit. The
 *     component is already live there, and a marker would put comment nodes
 *     into a DOM no loader ever reads.
 *   - Server render: the output is wrapped in island markers.
 *
 * @param {Comment}  anchor — the call site's anchor node
 * @param {Function} Comp   — the component factory
 * @param {object}   props
 * @param {object|null} block — slots object, as passed to a normal component call
 * @param {{component: string, directive: string, media?: string}} meta
 */
export function island(anchor, Comp, props, block, meta) {
  if (_isClient || !_isBrowser) return Comp(anchor, props, block)

  const parent = anchor?.parentNode
  // Block directives already bail when an anchor is detached; matching that
  // means a marker can never be the thing that breaks a render.
  if (!parent) return Comp(anchor, props, block)

  const open  = document.createComment(ISLAND_OPEN + islandPayload(props, meta))
  const close = document.createComment(ISLAND_CLOSE)
  parent.insertBefore(open, anchor)
  parent.insertBefore(close, anchor)

  // Render against the closing marker. Components append before their anchor,
  // and any block content queued during setup appends at anchors that are
  // themselves already inside this range, so the whole subtree lands between
  // the two markers — including content that only materializes at flushSync.
  return Comp(close, props, block)
}


/**
 * Store a value in a signal. The value is stored as-is — including functions.
 *
 * This used to decide value-vs-derivation at runtime from `value.length === 0`,
 * on the reasoning that the compiler always emits derivations as `() => expr`
 * while snippets are `(__anchor, …) => {}`. But a zero-argument function is
 * exactly what a user writes for a callback:
 *
 *   <Child ondone={() => n++} />        // arrow, length 0
 *   <Child handler={bump} />            // named fn, length 0
 *
 * and the child's `export let ondone` compiles to track($option.props.ondone).
 * Both were therefore memoised and *invoked during setup*, so `on:click={ondone}`
 * bound the callback's return value instead of the callback. `let f = () => …`
 * had the same problem. Arity cannot distinguish a derivation the compiler
 * generated from a callback the user passed — both are `() => …` — so the
 * compiler now says which it means by calling trackDerived() instead.
 */
export function track(value, _getInterceptor, _setInterceptor, _block, _alwaysNotify) {
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

/**
 * Store a derivation — a compiler-generated `() => expr` — as a memo.
 * The counterpart to track(): the caller states the intent rather than the
 * runtime guessing it from the shape of the value.
 */
export function trackDerived(fn, _getInterceptor, _setInterceptor, _block) {
  const memo = createMemo(fn)
  return {
    _isMemo: true,
    _memo: memo,
    get __v() { return untrack(memo) },
  }
}

export function get(tracked) {
  if (tracked == null) return tracked
  if (tracked._isMemo) return tracked._memo()
  if (tracked._read)   return tracked._read()
  if (typeof tracked === 'function') return tracked()  // raw createSignal/createMemo getter
  return tracked
}

export function set(tracked, value, force) {
  if (!tracked || tracked._isMemo) return
  if (tracked._write) {
    // Direct write — the compiler now emits the full expression for compound ops
    // (count++ → set(sig, get(sig) + 1)) so the value passed here is always the
    // final value, never an updater function. Calling a function value would
    // accidentally invoke snippet functions stored in signals (e.g. sidebarFn).
    tracked._write(value, force)
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

/**
 * Parse a template's HTML afresh, with no cache and no clone.
 *
 * Used on the SERVER only. happy-dom's `cloneNode` does not copy an element's
 * attributes — it re-derives some of them from default PROPERTIES, and gets it
 * wrong for `<input>`: every cloned input gains `formaction="<the page's own
 * URL>"` and `formmethod=""`, and an authored relative `formaction="/search"`
 * comes back absolutised to `http://localhost:5274/search`.
 *
 * That is not cosmetic. `formaction` on a submit control OVERRIDES its form's
 * action, so a prerendered form shipped by `target: 'static'` posted to
 * whatever origin built it — and the localhost URL of the build machine went
 * into a public file. Found in `example/`'s prerendered catalogue, where a
 * search box that never submits anything still carried both attributes.
 *
 * Parsing is the same path that produced the original, so what ships is what
 * was written. The cost is one parse per template INSTANCE instead of one per
 * template, which is a build-time cost on a page that is rendered once.
 */
function parseTemplateFresh(html, asFragment) {
  const t = document.createElement('template')
  t.innerHTML = html.replace(/<>/g, '<!---->')
  const content = t.content
  if (!asFragment && content.firstChild === content.lastChild) return content.firstChild
  return content
}

export function template(html, flags) {
  const isFragment = flags & TEMPLATE_FRAGMENT
  let parsed = null
  return function () {
    if (!_isClient) return parseTemplateFresh(html, !!isFragment)
    if (!parsed) parsed = htmlToFragment(html, isFragment ? 2 : 1)
    return parsed.cloneNode(true)
  }
}

// ── dynamicElement() — the template factory behind <mesa:element> ────────────

/**
 * Build one instance of `<mesa:element this={tag}>`.
 *
 * A tag cannot be interpolated into a template string: the string is parsed
 * once, and the parse is what decides the element. So the compiler emits the
 * element under a placeholder tag, and this transplants it — attributes copied,
 * children moved — onto an element created from the live expression. The block
 * source that follows then binds against the real element, so every directive
 * (`class`, `on:`, `style:`, `bind:`, `{@attach}`) works as it does anywhere.
 *
 * Wrapped in a keyBlock by the compiler, so a tag that changes rebuilds rather
 * than mutating — an element's tag is not writable, and the alternative is a
 * `<h2>` that keeps reporting itself as an `<h3>` to every selector on the page.
 *
 * The placeholder is a custom-element name so nothing is foster-parented out of
 * it during parse and no user agent gives it default properties. It is never in
 * the document: the parse happens inside a detached <template>.
 */
export function dynamicElement(tagFn, tplFn) {
  return () => {
    const tag = tagFn()
    if (typeof tag !== 'string' || !tag) {
      throw new Error(
        `[Mesa] <mesa:element this={…}> — expected a tag name, got ${
          typeof tag === 'string' ? "''" : String(tag)
        }. A dynamic element always has a tag; render nothing with {#if} instead.`
      )
    }
    const proto = tplFn()
    const el = document.createElement(tag)
    // Attributes first: moving children invalidates nothing, but a live
    // NamedNodeMap read after the node is emptied is one more thing to reason
    // about for no gain.
    for (const a of [...proto.attributes]) el.setAttribute(a.name, a.value)
    while (proto.firstChild) el.appendChild(proto.firstChild)
    return el
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
  // `<option value={obj}>` — keep the real value beside the attribute.
  // An attribute is a string, so an object became "[object Object]" and the
  // binding could never hand it back. bindInput() reads __value first.
  if (name === 'value' && el.tagName === 'OPTION') el.__value = value

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

/*
 * The `{class}` passthrough — MERGE, never replace.
 *
 * `<button class="btn primary" {class}>` has to end up with all three of the
 * component's own classes and the consumer's. Routing it through
 * set_attribute() overwrote the whole attribute instead: with no class prop
 * the element lost `btn primary` entirely, and with one it kept only the
 * consumer's. Every component that combined a base class with the passthrough
 * rendered unstyled, which is invisible until you look at the DOM — the
 * component still renders, it just has no classes.
 *
 * Only the tokens this function added are removed on update, so an element's
 * own classes (and anything another binding added) survive.
 */
export function bindClassPassthrough(el, fn) {
  let applied = []
  const update = () => {
    const raw = fn()
    const next = raw == null || raw === false
      ? []
      : ('' + raw).split(/\s+/).filter(Boolean)
    for (const c of applied) if (!next.includes(c)) el.classList.remove(c)
    for (const c of next) if (!applied.includes(c)) el.classList.add(c)
    applied = next
  }
  // Same shape as bindAttribute: subscribe so a changing prop re-applies.
  createEffect(update)
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
