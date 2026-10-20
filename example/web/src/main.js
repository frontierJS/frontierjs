// The app's side-effect imports. index.html loads virtual:sierra, which boots
// the router, the Junction client and — because db/schema.lite exists —
// registerSchemas(), then imports this file, then mounts App.mesa (FJS-D1085).
// Read what Vite serves at /@id/__x00__virtual:sierra/boot to see the boot.

// The design system. One import, no build step, no config. Nothing in this app
// defines a color, a radius or a spacing scale of its own.
import '@frontierjs/css'

// The screens that have to work in a stockroom, imported at BOOT rather than on
// the first visit to them. A resource's `offlineQuery` is registered when its
// module is evaluated, and a route's modules are code-split — so a resource
// nothing has imported yet declares nothing, and the whole point of the
// declaration is the screen nobody has opened (`FJS-D307`).
//
// The boot has already built the Junction client every resource is created
// against. Which resources are worth the entry chunk is the app's decision and
// not the framework's, which is why this is a line here rather than a glob over
// `src/resources/` (`FJS-1178`).
import './resources/InventoryMovement.mesa'
import './resources/ProductVariant.mesa'

import { getClient }        from '@frontierjs/sierra/resource'
import { useCartClient }    from './stores/cart.js'
import './displays.js'

// The basket takes its client rather than importing one, so that the same store
// can run on the storefront — where importing sierra's junction module into an
// island hangs the prerender (`FJS-550`). Here it is the app-wide singleton
// the boot built.
useCartClient(getClient)
