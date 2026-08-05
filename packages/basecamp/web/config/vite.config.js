// web/config/vite.config.js
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './sierra.config.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const API  = 'http://localhost:3001'

// Basecamp mounts services at /{service} with no prefix, so an API path and a
// UI path are the SAME URL: GET /projects is both the service and the page.
// Client-side navigation never notices — the router does not touch the network
// — but a hard load or a refresh of /projects/ goes to Vite, and a plain proxy
// rule would answer it with JSON.
//
// So the proxy discriminates on Accept: a browser navigation asks for
// text/html and is handed the SPA; the Junction client asks for
// application/json and is proxied. Verified both ways in a browser.
//
// If this ever gets fragile, the durable fix is to give the API an apiPrefix
// ('/api') and match it in sierra.config.js — one proxy rule, no ambiguity.
// The prefix was removed deliberately; this is the cost of that, written down.
const API_PATHS = [
  '/auth', '/setup', '/health', '/metrics', '/conduit-targets',
  '/workspaces', '/projects', '/environments', '/apps',
  '/servers', '/deployments', '/jobs', '/portal',
]

const proxy = Object.fromEntries(API_PATHS.map(path => [path, {
  target:       API,
  changeOrigin: true,
  bypass(req) {
    // Returning a path serves it from Vite instead of proxying; returning
    // undefined proxies. A navigation gets the shell, everything else the API.
    if (req.headers.accept?.includes('text/html')) return '/index.html'
    return undefined
  },
}]))

// The WebSocket has no HTML ambiguity to resolve — always proxy.
proxy['/ws'] = { target: API, ws: true }

export default defineConfig({
  ...createSierraViteConfig(sierraConfig),

  // The Vite root is web/, not config/. Everything Sierra resolves is relative
  // to it: routesDir, the manifest it writes, and ../db/schema.lite — the same
  // file the API reads, without a copy.
  root: ROOT,

  server: {
    port: 5274,   // 5273 is the sierra example's; they can run side by side

    // Refuse to hop ports. Vite's default is to take the next free one and
    // print a line nobody reads — which, with a stale server still holding
    // 5274, means the browser you open talks to the OLD build while the new
    // one runs somewhere else. A collision is a mistake; say so and stop.
    strictPort: true,

    proxy,
  },
})
