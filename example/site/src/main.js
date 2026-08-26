// site/src/main.js — the DEV entry.
//
// A BUILT page mounts its islands and nothing else: what ships is HTML with one
// chunk per island, and this file is in none of it. What it is for is `bun run
// dev:site`, where the routes are served as a client-routed app so a page's
// markup can be iterated on without a build.
//
// It is deliberately the same boot the SPA uses — importing `virtual:sierra`
// starts the router off the generated route table — so a link behaves the same
// in both. What the built site does NOT have is any of this: a storefront page
// reads its data at BUILD time through `api/src/core/db.ts`, and its only runtime code
// is an island, which creates its own client against the API's own origin.
import 'virtual:sierra'

import '@frontierjs/css'

import { mount } from '@frontierjs/mesa/runtime'
import { RouterView } from '@frontierjs/sierra/router'

// mount()'s first argument is an anchor NODE, not an element id — Mesa inserts
// the component immediately after it, so the anchor must already be in the tree.
const root   = document.getElementById('app')
const anchor = document.createTextNode('')
root.appendChild(anchor)

mount(anchor, RouterView, { root })
