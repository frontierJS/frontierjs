// web/src/main.js — the browser Haven's entry, which index.html loads. The
// terminal never reads it: `fli haven` mounts the routes through Sierra's
// terminal shell instead.
//
// virtual:sierra first: it boots the router and the Junction client from
// config/sierra.config.js and registers the schemas from ../db/schema.lite,
// and a resource module evaluated before that has no field rules.
import 'virtual:sierra'

// `.surface` is what makes a bubble hide the art under it, on this target as
// in the terminal (`FJS-D979`).
import '@frontierjs/css'

import { mount } from '@frontierjs/mesa/runtime'
import App from './App.mesa'

const root   = document.getElementById('app')
const anchor = document.createTextNode('')
root.appendChild(anchor)

mount(anchor, App, { root })
