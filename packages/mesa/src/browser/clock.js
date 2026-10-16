/*
 * clock.js — #2, the time as a signal: `now({ every })`.
 *
 * The hand-written version is `now = Date.now()` plus a `setInterval` per
 * component and a cleanup somebody forgets, so a page of twenty "3 min ago"
 * labels runs twenty timers and keeps them firing in a tab nobody is looking at.
 *
 * ─── One timer per resolution ────────────────────────────────────────────
 *
 * Every reader of `every: 1000` shares one clock: started by its first reader,
 * stopped a microtask after its last (`subscribe`). Readers of one clock read
 * one instant, so two labels on a page never disagree by a tick.
 *
 * Ticks land on multiples of `every` since the epoch — a clock showing minutes
 * turns over with the wall clock rather than up to a minute after it.
 *
 * ─── Parked while the tab is hidden ──────────────────────────────────────
 *
 * The timer is cleared when `tab.visible` goes false and, when it comes back,
 * the clock ticks at once before re-aligning, so a tab brought to the front
 * shows no stale minute. A browser only throttles a background timer; it does
 * not stop one.
 *
 * Under a server render `.value` is `Date.now()` at the render and nothing is
 * started. On a terminal or a phone the call throws (`host.js`). Read outside
 * an effect, `.value` is the clock's instant when one is running and
 * `Date.now()` when none is.
 */
import { subscribe, createRoot, createEffect, untrack, watchPath } from '../runtime.js'
import { live } from './host.js'
import { tab } from './tab.js'

const _clocks = new Map()

function clockFor(every) {
  let clock = _clocks.get(every)
  if (clock) return clock
  clock = { at: 0, running: false }
  clock.track = subscribe((update) => {
    let align, interval
    const tick = () => { clock.at = Date.now(); update() }
    const park = () => {
      clearTimeout(align)
      clearInterval(interval)
      align = interval = undefined
    }
    const run = () => {
      align = setTimeout(() => {
        align = undefined
        tick()
        interval = setInterval(tick, every)
      }, every - (Date.now() % every))
    }
    // No update() on the first run: start runs inside the first reader's
    // read, which takes `at` as soon as start returns.
    clock.at = Date.now()
    clock.running = true
    let first = true
    const unwatch = createRoot((dispose) => {
      const [visibleMoved] = watchPath(tab, 'visible')
      createEffect(() => {
        visibleMoved()
        const visible = tab.visible
        untrack(() => {
          park()
          if (!visible) return
          if (!first) tick()
          run()
        })
        first = false
      })
      return dispose
    })
    return () => {
      clock.running = false
      unwatch()
      park()
    }
  })
  _clocks.set(every, clock)
  return clock
}

/**
 * The time in ms since the epoch, tracked: an effect reading `.value` re-runs
 * every `every` ms while the tab is visible. Server render: `Date.now()`,
 * nothing started; on a terminal or a phone the call throws.
 */
export function now({ every = 1000 } = {}) {
  if (!(typeof every === 'number' && every > 0 && Number.isFinite(every)))
    throw new Error(`now({ every: ${every} }): every is a positive number of milliseconds`)
  live('now()')
  return {
    get value() {
      if (!live('now()')) return Date.now()
      const clock = clockFor(every)
      clock.track()
      return clock.running ? clock.at : Date.now()
    },
  }
}
