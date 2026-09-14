// Importing virtual:sierra boots the router, the Junction client and — because
// db/schema.lite exists — registerSchemas(). All three are generated from the
// config; read what Vite serves at /@id/__x00__virtual:sierra to see the module.
import 'virtual:sierra'

// The design system. One import, no build step, no config. Nothing in this app
// defines a color, a radius or a spacing scale of its own.
import '@frontierjs/css'

import { getClient }        from '@frontierjs/sierra/junction'
import { useCartClient }    from './cart.js'
import { loadShopCalendar } from './datetime.js'
import './money-control.js'
import './displays.js'

import { mount } from '@frontierjs/mesa/runtime'
import App from './App.mesa'

// The basket takes its client rather than importing one, so that the same store
// can run on the storefront — where importing sierra's junction module into an
// island hangs the prerender (`FJS-550`). Here it is the app-wide singleton
// `virtual:sierra` built on the line above.
useCartClient(getClient)

// mount()'s first argument is an anchor NODE, not an element id — Mesa inserts
// the component immediately after it, so the anchor must already be in the tree.
const root   = document.getElementById('app')
const anchor = document.createTextNode('')
root.appendChild(anchor)

// Which calendar the shop keeps, before anything renders a date in it — a date
// that re-rendered once the answer arrived would show the wrong day first. A
// failure still mounts: the app is more use than a blank page, and `day()` then
// reads UTC, which is what a shop that set nothing is billed in.
loadShopCalendar()
  .catch((err) => console.warn(`[example] the shop's calendar did not load, so dates read in UTC: ${err?.message ?? err}`))
  .finally(() => mount(anchor, App, { root }))
