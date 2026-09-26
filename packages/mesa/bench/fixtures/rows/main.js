import { mount } from '@frontierjs/mesa/runtime.js'
import App from './App.mesa'

// mount() inserts AFTER its label, so the label has to be inside <body>: the
// body itself as the label puts the app beside it, in <html>.
const label = document.body.appendChild(document.createComment('mesa'))
mount(label, App, { props: {} })
