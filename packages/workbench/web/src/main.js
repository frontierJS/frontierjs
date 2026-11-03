// The app's side-effect imports. index.html loads virtual:sierra, which boots
// the router, the Junction client and -- because ../db/schema.lite exists --
// registerSchemas(), then imports this file, then mounts App.mesa.

// The design system. One import, no build step, no config; nothing in this app
// defines a color, a radius or a spacing scale of its own (repo invariant 13).
import '@frontierjs/css'
