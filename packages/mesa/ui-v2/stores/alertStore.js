// alertStore.js — plain JavaScript, no Mesa awareness required.
// Components watch specific paths with $: to react to mutations.
//
// Usage in a component:
//   import { alert } from '../stores/alertStore.js'
//   $: alert.visible
//   alert.show('Saved!', 'success')

export const alert = {
  visible: false,
  message: '',
  type: 'info',       // 'info' | 'success' | 'warning' | 'error'
  duration: 4000,     // ms — 0 means persistent until manually closed

  show(message, type = 'info', duration = 4000) {
    this.message  = message
    this.type     = type
    this.duration = duration
    this.visible  = true
    if (duration > 0) setTimeout(() => this.hide(), duration)
  },

  hide() {
    this.visible = false
  },

  success(message, duration) { this.show(message, 'success', duration) },
  error(message, duration)   { this.show(message, 'error', duration) },
  warning(message, duration) { this.show(message, 'warning', duration) },
  info(message, duration)    { this.show(message, 'info', duration) },
}
