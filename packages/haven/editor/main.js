// editor/main.js — the scene editor's entry, which index.html loads.
import '@frontierjs/css'
import { mount } from '@frontierjs/mesa/runtime'
import Editor from './Editor.mesa'

const root   = document.getElementById('app')
const anchor = document.createTextNode('')
root.appendChild(anchor)

mount(anchor, Editor, { root })
