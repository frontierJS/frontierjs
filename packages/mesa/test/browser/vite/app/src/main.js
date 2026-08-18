/*
 * main.js — the fixture app's entry.
 *
 * Mounted rather than called: `mount()` registers the delegation root, so a
 * page that calls the component directly renders and handles nothing
 * (Invariant 11). The drive clicks real buttons, so this has to be right or
 * every spec reads as a broken plugin.
 */
import { mount } from '@frontierjs/mesa/runtime.js'
import App from './App.mesa'

const host   = document.getElementById('app')
const anchor = document.createComment('app')
host.appendChild(anchor)

mount(anchor, App, { root: host })

window.__appReady = true
