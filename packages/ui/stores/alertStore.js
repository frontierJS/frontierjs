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
    // `alert.error(message, detail)` is the wrong call, and a string here made
    // `duration > 0` false -- an alert nothing would ever hide.
    if (typeof duration !== 'number') {
      throw new TypeError(`alert: duration must be a number of ms, got ${JSON.stringify(duration)} -- an alert is one message`)
    }
    // The previous alert's timer would otherwise hide this one early, and a
    // persistent alert (0) would vanish with it.
    clearTimeout(_timer)
    _w.message  = message
    _w.type     = type
    _w.duration = duration
    _w.visible  = true
    if (duration > 0) _timer = setTimeout(() => this.hide(), duration)
  },

  hide() {
    clearTimeout(_timer)
    _w.visible = false
  },

  success(message, duration) { this.show(message, 'success', duration) },
  error(message, duration)   { this.show(message, 'error', duration) },
  warning(message, duration) { this.show(message, 'warning', duration) },
  info(message, duration)    { this.show(message, 'info', duration) },
}

const _w = watchProxy(alert)
let _timer
