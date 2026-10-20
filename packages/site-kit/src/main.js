// src/main.js — the DEV entry of every site-kit site, served by config/shell.js.
// Nothing in the built output imports it.
// A built page ships HTML plus one chunk per island; this file exists so the
// routes can be served as a client-routed app while a page is being written.
// A site's root has no src/, so the kit's entry is this file rather than
// virtual:sierra, and it imports virtual:sierra last: that boots the router and
// mounts the routes, after the stylesheets are in.
import '@frontierjs/css'
import 'virtual:site-kit/styles'

import 'virtual:sierra'
