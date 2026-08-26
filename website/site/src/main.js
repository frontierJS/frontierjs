// site/src/main.js — the DEV entry, and nothing in the built output imports it.
// A built page ships HTML plus one chunk per island; this file exists so the
// routes can be served as a client-routed app while a page is being written.
import 'virtual:sierra'

import '@frontierjs/css'

import { mount } from '@frontierjs/mesa/runtime'
import { RouterView } from '@frontierjs/sierra/router'

const root   = document.getElementById('app')
const anchor = document.createTextNode('')
root.appendChild(anchor)

mount(anchor, RouterView, { root })
