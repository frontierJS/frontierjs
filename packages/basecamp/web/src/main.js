// The app's side-effect imports. index.html loads virtual:sierra, which boots
// the router, the Junction client and — because ../db/schema.lite exists —
// registerSchemas(), then imports this file, then mounts App.mesa (FJS-D1085).

// The design system. One import, no build step, no config. Every class used
// below this line comes from it, and nothing in this app defines a color, a
// radius or a spacing scale of its own (repo invariant 13).
import '@frontierjs/css'

// How this console renders a column, where it differs from the kit's default.
import './displays.js'
