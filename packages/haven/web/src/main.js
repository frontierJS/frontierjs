// web/src/main.js — the browser Haven's side-effect imports. index.html loads
// virtual:sierra, which boots the router and the Junction client and registers
// the schemas from ../db/schema.lite, then imports this file and mounts
// App.mesa. The terminal never reads it: `fli haven` mounts the routes through
// Sierra's terminal shell instead.

// `.surface` is what makes a bubble hide the art under it, on this target as
// in the terminal (`FJS-D979`).
import '@frontierjs/css'
