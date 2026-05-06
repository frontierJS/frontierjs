import { mount } from '@frontierjs/mesa/runtime.js'
import App from './App.mesa'

// ── Standard mount (no shadow DOM) ──────────────────────────────────────────
// mount(label, component, option)
//   label     — DOM node already in the document; mount inserts after it
//   component — the default export of a .mesa file
//   option    — { props, root }
//                 props  — initial prop values passed to the component
//                 root   — explicit delegation root (default: label.parentNode)

const app = mount(document.body, App, {
  props: {},
})

// app.find(selector) — querySelector scoped to the mounted tree
// app.destroy()      — unmounts and removes all delegation listeners

// ── Shadow DOM mount ─────────────────────────────────────────────────────────
// Uncomment to mount inside a shadow root. Event delegation will be scoped
// to the shadow root's container — on:click etc. work correctly inside shadow DOM.
//
// const host   = document.getElementById('app')
// const shadow = host.attachShadow({ mode: 'open' })
// const target = document.createElement('div')
// shadow.appendChild(target)
//
// const app = mount(target, App, {
//   props: {},
//   root:  shadow,   // delegates to shadow root, not document.body
// })
