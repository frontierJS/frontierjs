// toastStore.js — plain JavaScript.
// Toaster.mesa watches toasts.items via $: and renders the list.
//
// Usage anywhere:
//   import { toasts } from '../stores/toastStore.js'
//   toasts.add('File saved', 'success')

let _nextId = 0

export const toasts = {
  items: [],   // { id, message, type, duration }

  add(message, type = 'info', duration = 3500) {
    const id = ++_nextId
    this.items = [...this.items, { id, message, type, duration }]
    if (duration > 0) setTimeout(() => this.remove(id), duration)
    return id
  },

  remove(id) {
    this.items = this.items.filter(t => t.id !== id)
  },

  success(message, duration) { return this.add(message, 'success', duration) },
  error(message, duration)   { return this.add(message, 'error',   duration) },
  warning(message, duration) { return this.add(message, 'warning', duration) },
  info(message, duration)    { return this.add(message, 'info',    duration) },
}
