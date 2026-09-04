// Importing virtual:sierra boots the router, the Junction client, and — because
// db/schema.lite exists — registerSchemas(). All three are generated from the
// config; read what Vite serves at /@id/__x00__virtual:sierra to see the module.
import 'virtual:sierra'

// The design system. One import, no build step, no config — every component
// class used below this line comes from it, and nothing in this app defines a
// color, a radius or a spacing scale of its own.
import '@frontierjs/css'

import { mount } from '@frontierjs/mesa/runtime'
import App from './App.mesa'

// mount()'s first argument is an anchor NODE, not an element id: Mesa inserts
// the component immediately after it, so the anchor must already be a child of
// whatever you want to mount into. Passing the string 'app' fails with
// "anchor node has no parentNode", which is what it says but not why.
const root   = document.getElementById('app')
const anchor = document.createTextNode('')
root.appendChild(anchor)

mount(anchor, App, { root })
