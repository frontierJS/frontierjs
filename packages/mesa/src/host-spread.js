// A `{...attrs}` spread on a host node, for every runtime that is not the DOM:
// the terminal and native runtimes each pass their own event table and node
// writers. An `on*` key binds one listener per event and swaps the handler
// behind it, so a spread that changes its handler never stacks a second one;
// an event the host has no way to fire is dropped, not written as an attribute.

import { createEffect } from './runtime.js'

export function spreadOnto(node, fn, { events, on, setAttribute }) {
  const live = {}
  let prev = {}
  const put = (k, v) => {
    const event = k.length > 2 && k.startsWith('on') ? k.slice(2) : null
    if (event && (typeof v === 'function' || event in live)) {
      if (!events[event]) return
      if (!(event in live)) on(node, event, (e) => live[event]?.(e))
      live[event] = typeof v === 'function' ? v : null
      return
    }
    if (typeof v !== 'function') setAttribute(node, k, v)
  }
  createEffect(() => {
    const state = fn() ?? {}
    for (const k in state) if (prev[k] !== state[k]) put(k, state[k])
    for (const k in prev) if (!(k in state)) put(k, null)
    prev = { ...state }
  })
}
