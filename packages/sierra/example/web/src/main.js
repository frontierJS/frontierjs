// The app's side-effect imports. index.html loads virtual:sierra, which boots
// the router, the Junction client and — because db/schema.lite exists —
// registerSchemas(), then imports this file, then mounts App.mesa (FJS-D1085).
// Read what Vite serves at /@id/__x00__virtual:sierra/boot to see the boot.

// The design system. One import, no build step, no config — every component
// class used below this line comes from it, and nothing in this app defines a
// color, a radius or a spacing scale of its own.
import '@frontierjs/css'
