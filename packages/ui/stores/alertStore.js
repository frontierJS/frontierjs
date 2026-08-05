// alertStore.js — the app-level alert banner.
//
// Components watch specific paths with `$:`. The writes go through `_w`
// because that is what notifies them: a bare `this.visible = true` updates the
// object and re-renders nothing (see toastStore.js).
//
// Usage in a component:
//   import { alert } from '../stores/alertStore.js'
//   $: alert.visible
//   alert.show('Saved!', 'success')

import { watchProxy } from '@frontierjs/mesa/runtime'

export const alert = {
  visible: false,
  message: '',
  type: 'info',       // 'info' | 'success' | 'warning' | 'error'
  duration: 4000,     // ms — 0 means persistent until manually closed

  show(message, type = 'info', duration = 4000) {
    _w.message  = message
    _w.type     = type
    _w.duration = duration
    _w.visible  = true
    if (duration > 0) setTimeout(() => this.hide(), duration)
  },

  hide() {
    _w.visible = false
  },

  success(message, duration) { this.show(message, 'success', duration) },
  error(message, duration)   { this.show(message, 'error', duration) },
  warning(message, duration) { this.show(message, 'warning', duration) },
  info(message, duration)    { this.show(message, 'info', duration) },
}

const _w = watchProxy(alert)
