/*
 * clock.js — the one clock every timer Mesa owns reads (`FJS-D2059`).
 *
 * A timer that reads `setTimeout` or `Date.now()` directly cannot be held
 * still, so a test or a drive waits on real time and a debounce, a transition
 * fallback or a chord deadline lands between two steps — the flake this
 * exists to remove. Each host supplies a source; `clock.use()` installs one.
 *
 * A source is `{ now, after, every, frame }`. `after`, `every` and `frame`
 * return a CANCEL FUNCTION, never an id, so a cancel cannot reach a timer of
 * another source. A trailing label names a timer for `settle()`.
 *
 * The DOM source reads the globals at the call, not at load: happy-dom and a
 * test's fake timers are installed after this module is.
 *
 * A drive that holds the page's clock (`newPage({ clock: true })`) installs
 * `globalThis.__fjsClock` before any page script, and `clock` dispatches to it
 * unless a source was installed explicitly — so a timer's label (`'$.after'`,
 * `'transition'`) reaches the drive's `settle` instead of a faked
 * `setTimeout` that knows no name. The drive evaluates this file's TEXT in the
 * page, which is why it imports nothing.
 */

const domSource = {
  now: () => Date.now(),
  after(ms, fn) {
    const id = setTimeout(fn, ms)
    return () => clearTimeout(id)
  },
  every(ms, fn) {
    const id = setInterval(fn, ms)
    return () => clearInterval(id)
  },
  frame(fn) {
    // Node and a happy-dom without rAF: a frame is a 16 ms timer.
    if (typeof requestAnimationFrame !== 'function') return domSource.after(16, fn)
    const id = requestAnimationFrame(fn)
    return () => cancelAnimationFrame(id)
  },
}

let _source = domSource

const source = () => _source !== domSource ? _source
  : typeof globalThis.__fjsClock === 'object' && globalThis.__fjsClock ? globalThis.__fjsClock
  : domSource

export const clock = {
  now: () => source().now(),
  after: (ms, fn, label) => source().after(ms, fn, label),
  every: (ms, fn, label) => source().every(ms, fn, label),
  frame: (fn, label) => source().frame(fn, label),
  /** Install `source` (nullish: the DOM's); answers the one it replaced. */
  use(source) {
    const prev = _source
    _source = source ?? domSource
    return prev
  },
}

const noop = () => {}

/** A server render arms nothing: a timer there would fire into a page that
 *  was already serialized, and hold the process open after the render. A
 *  `$.sleep` is the exception, answered at once: the render waits on every
 *  `{#await}`, so one behind a sleep that never resolved held the render queue
 *  forever. A transition's fallback is a timer and stays unarmed. */
export const quietSource = {
  now: () => Date.now(),
  after: (ms, fn, label) => { if (label === '$.sleep') fn(); return noop },
  every: () => noop,
  frame: () => noop,
}

// A nested `setTimeout(0)` is clamped to 4 ms, so a held clock yields on a
// MessageChannel task, as Playwright's does.
function yieldTask() {
  if (typeof MessageChannel === 'function') {
    return new Promise((resolve) => {
      const { port1, port2 } = new MessageChannel()
      port1.onmessage = () => { port1.close(); resolve() }
      port2.postMessage(0)
    })
  }
  return new Promise((resolve) => setTimeout(resolve))
}

/**
 * A source that holds time still until `advance(ms)` moves it. Every timer due
 * on the way fires at its own virtual time, in fire-time-then-creation order;
 * an `every` re-arms from its scheduled time; delay 0 armed inside a callback
 * lands at `now + 1`, which keeps zero-delay recursion finite; a frame lands
 * on the 16 ms grid. Fakes no page global — that is the drive's (`FJS-D2061`).
 */
export function virtualClock(startMs = Date.now()) {
  let now = startMs
  let seq = 0
  let firing = false
  const timers = new Map()

  function arm(kind, delay, fn, label, interval) {
    const id = ++seq
    const ms = Math.max(0, Number(delay) || 0)
    const at = now + (ms || (firing ? 1 : 0))
    timers.set(id, { id, kind, at, fn, label, interval })
    return () => { timers.delete(id) }
  }

  function next(to, kinds) {
    let first = null
    for (const t of timers.values()) {
      if (t.at > to || (kinds && !kinds.has(t.kind))) continue
      if (!first || t.at < first.at || (t.at === first.at && t.id < first.id)) first = t
    }
    return first
  }

  function fire(t) {
    now = t.at
    if (t.kind === 'every') t.at += t.interval
    else timers.delete(t.id)
    firing = true
    try { t.fn(now) } finally { firing = false }
  }

  // A thrown callback does not stop the timers after it; the first throw is
  // the answer once the run ends.
  async function runTo(to, count) {
    let error = null
    for (let t = next(to); t; t = next(to)) {
      try { fire(t) } catch (e) { error ??= e }
      count?.()
      await yieldTask()
    }
    if (error) throw error
  }

  const name = (t) => t.label ?? (t.kind === 'frame' ? 'frame' : `${t.kind}(${t.interval ?? t.at - now}ms)`)

  return {
    now: () => now,
    after: (ms, fn, label) => arm('after', ms, fn, label),
    // An interval of 0 would fire forever at one instant.
    every: (ms, fn, label) => arm('every', Math.max(1, Number(ms) || 0), fn, label, Math.max(1, Number(ms) || 0)),
    frame: (fn, label) => arm('frame', 16 - (((now % 16) + 16) % 16), fn, label),
    async advance(ms) {
      const to = now + Math.max(0, Number(ms) || 0)
      try { await runTo(to) } finally { now = Math.max(now, to) }
    },
    /** Run `after` timers and frames until none is armed. An `every` never
     *  settles: it fires on the way and is named in `armed`, not spun on. */
    async settle({ limit = 1000 } = {}) {
      const finite = new Set(['after', 'frame'])
      let fired = 0
      await yieldTask()
      for (;;) {
        const t = next(Infinity, finite)
        if (!t) break
        if (fired >= limit) break
        await runTo(t.at, () => { fired++ })
        await yieldTask()
      }
      const armed = [...timers.values()].sort((a, b) => a.at - b.at || a.id - b.id).map(name)
      return { settled: armed.length === 0, armed }
    },
  }
}
