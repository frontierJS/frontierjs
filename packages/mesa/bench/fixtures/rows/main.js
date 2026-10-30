import { mount, trackOwners } from '@frontierjs/mesa/runtime'
import App from './App.mesa'

// The bench's leak gate reads this count; it must start before the first root.
window.__owners = trackOwners()

// mount() inserts AFTER its label, so the label has to be inside <body>: the
// body itself as the label puts the app beside it, in <html>.
const label = document.body.appendChild(document.createComment('mesa'))
mount(label, App, { props: {} })
