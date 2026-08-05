// toastStore.js — the toast queue.
//
// Toaster.mesa watches toasts.items via $: and renders the list.
//
// Usage anywhere:
//   import { toasts } from '@frontierjs/ui/stores/toastStore.js'
//   toasts.add('File saved', 'success')
//
// ── Why the writes go through `_w` ──────────────────────────────────────
//
// A component watches a plain object through `watchProxy`, and ONLY a write
// through that proxy notifies. `this.items = […]` updates the object and tells
// nobody: every toast was queued correctly, the array grew, and the Toaster
// never re-rendered — verified in a browser, where two queued toasts sat in
// `toasts.items` with an empty `.toast-stack` on screen.
//
// `watchProxy` is idempotent and cached per object, so this handle and the one
// a component builds are the same proxy over the same signals.
import { watchProxy } from '@frontierjs/mesa/runtime'

let _nextId = 0

export const toasts = {
  items: [],   // { id, message, type, duration }

  add(message, type = 'info', duration = 3500) {
    const id = ++_nextId
    _w.items = [...this.items, { id, message, type, duration }]
    if (duration > 0) setTimeout(() => this.remove(id), duration)
    return id
  },

  remove(id) {
    _w.items = this.items.filter(t => t.id !== id)
  },

  clear() {
    _w.items = []
  },

  success(message, duration) { return this.add(message, 'success', duration) },
  error(message, duration)   { return this.add(message, 'error',   duration) },
  warning(message, duration) { return this.add(message, 'warning', duration) },
  info(message, duration)    { return this.add(message, 'info',    duration) },
}

const _w = watchProxy(toasts)
