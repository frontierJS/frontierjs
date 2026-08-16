// toastStore.js — the toast queue.
//
// Toaster.mesa watches toasts.items via $: and renders the list.
//
// Usage anywhere:
//   import { toasts } from '@frontierjs/ui/stores/toastStore.js'
//   toasts.add('File saved', 'success')
//
// A long action holds a HANDLE and settles it when it knows the answer:
//
//   const t = toasts.loading('Sending…')
//   try   { await send(); t.update('success', 'Sent') }
//   catch (e) { t.update('error', e.message) }
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

/*
 * The pending auto-dismiss timers, by toast id.
 *
 * Kept because a toast's lifetime is now editable: settling a loading toast
 * gives it a duration it did not have, and settling it TWICE — a retry that
 * fails, then succeeds — must not leave the first timer running to remove the
 * second message early. Removing a toast clears its timer for the same reason.
 */
const _timers = new Map()

// The lifetime a settled toast gets. Named because `update()` has to state one
// — a toast that arrived with `duration: 0` because it was loading would
// otherwise stay on screen for ever once it succeeded.
const DEFAULT_DURATION = 3500

function _schedule(id, duration) {
  clearTimeout(_timers.get(id))
  _timers.delete(id)
  if (duration > 0) _timers.set(id, setTimeout(() => toasts.remove(id), duration))
}

export const toasts = {
  items: [],   // { id, message, type, duration }

  add(message, type = 'info', duration = DEFAULT_DURATION) {
    const id = ++_nextId
    _w.items = [...this.items, { id, message, type, duration }]
    _schedule(id, duration)
    return id
  },

  /**
   * Change a toast that is already on screen.
   *
   * Answers false for an id that is gone — a long action whose toast the
   * reader dismissed is the ordinary case, not an error, and it must not
   * resurrect the message they closed.
   */
  update(id, patch = {}) {
    const current = this.items.find(t => t.id === id)
    if (!current) return false

    const next = { ...current, ...patch }
    _w.items = this.items.map(t => (t.id === id ? next : t))
    // Only when the caller stated one: an update that changes the message and
    // nothing else must not silently restart a timer that is already running.
    if ('duration' in patch) _schedule(id, next.duration)
    return true
  },

  remove(id) {
    clearTimeout(_timers.get(id))
    _timers.delete(id)
    _w.items = this.items.filter(t => t.id !== id)
  },

  clear() {
    for (const t of _timers.values()) clearTimeout(t)
    _timers.clear()
    _w.items = []
  },

  /**
   * A handle over one toast: the thing the id was never enough for.
   *
   * `add()` returns an id and `remove(id)` was the only thing that ever took
   * one back, so a long action could announce that it had STARTED or that it
   * had finished, but not both on one toast — every caller either said nothing
   * until the end or left a "Sending…" on screen for good.
   */
  handle(id) {
    return {
      id,
      /** Settle it: a tone, a message, and a lifetime that follows from them. */
      update: (type, message, duration = DEFAULT_DURATION) =>
        toasts.update(id, {
          ...(type !== undefined ? { type } : {}),
          ...(message !== undefined ? { message } : {}),
          duration,
        }),
      dismiss: () => toasts.remove(id),
    }
  },

  /**
   * A toast for work in flight. It carries a spinner instead of an icon and
   * does NOT dismiss itself — nothing knows how long the work will take, and a
   * progress bar that drains to nothing while the request is still open is a
   * lie about the state of the system.
   */
  loading(message) {
    return this.handle(this.add(message, 'loading', 0))
  },

  success(message, duration) { return this.add(message, 'success', duration) },
  error(message, duration)   { return this.add(message, 'error',   duration) },
  warning(message, duration) { return this.add(message, 'warning', duration) },
  info(message, duration)    { return this.add(message, 'info',    duration) },
}

const _w = watchProxy(toasts)
