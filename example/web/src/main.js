// Importing virtual:sierra boots the router, the Junction client and — because
// db/schema.lite exists — registerSchemas(). All three are generated from the
// config; read what Vite serves at /@id/__x00__virtual:sierra to see the module.
import 'virtual:sierra'

// The design system. One import, no build step, no config. Nothing in this app
// defines a color, a radius or a spacing scale of its own.
import '@frontierjs/css'

// The screens that have to work in a stockroom, imported at BOOT rather than on
// the first visit to them. A resource's `offlineQuery` is registered when its
// module is evaluated, and a route's modules are code-split — so a resource
// nothing has imported yet declares nothing, and the whole point of the
// declaration is the screen nobody has opened (`FJS-D307`).
//
// After `virtual:sierra`, which is what builds the Junction client every
// resource is created against. Which resources are worth the entry chunk is the
// app's decision and not the framework's, which is why this is a line here
// rather than a glob over `src/resources/` (`FJS-1178`).
// Variants FIRST: the movements below reference them, and on a device that
// relation is a real foreign key — the warm fills the tables in the order the
// resources registered, so this order is the one that keeps the batch writable.
import './resources/ProductVariant.mesa'
import './resources/InventoryMovement.mesa'

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
