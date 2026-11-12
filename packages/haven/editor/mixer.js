// editor/mixer.js — the band mixer's entry, which mixer.html loads.
import '@frontierjs/css'
import { mount } from '@frontierjs/mesa/runtime'
import Mixer from './Mixer.mesa'

const root   = document.getElementById('app')
const anchor = document.createTextNode('')
root.appendChild(anchor)

mount(anchor, Mixer, { root })
