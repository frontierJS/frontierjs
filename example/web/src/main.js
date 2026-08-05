// Importing virtual:sierra boots the router, the Junction client and — because
// db/schema.lite exists — registerSchemas(). All three are generated from the
// config; read what Vite serves at /@id/__x00__virtual:sierra to see the module.
import 'virtual:sierra'

// The design system. One import, no build step, no config. Nothing in this app
// defines a colour, a radius or a spacing scale of its own.
import '@frontierjs/css'

import { mount } from '@frontierjs/mesa/runtime'
import App from './App.mesa'

// The theme is a class on <body>, so it is applied before the first render
// rather than by a component — a component that themed the page would flash
// the default theme first and re-theme on mount.
import { applyTheme } from './prefs.js'
applyTheme()

// mount()'s first argument is an anchor NODE, not an element id — Mesa inserts
// the component immediately after it, so the anchor must already be in the tree.
const root   = document.getElementById('app')
const anchor = document.createTextNode('')
root.appendChild(anchor)

mount(anchor, App, { root })
