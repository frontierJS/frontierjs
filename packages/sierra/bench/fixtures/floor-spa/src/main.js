// The scaffold's entry without `@frontierjs/css`: the stylesheet is its own
// row in the byte table, and counted here it would hide Sierra's own growth.
import 'virtual:sierra'

import { mount } from '@frontierjs/mesa/runtime'
import App from './App.mesa'

const root   = document.getElementById('app')
const anchor = document.createTextNode('')
root.appendChild(anchor)

mount(anchor, App, { root })
