// web/config/vite.config.js
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './sierra.config.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const API  = 'http://localhost:3001'
const UI   = resolve(HERE, '../../../ui')

const sierra = createSierraViteConfig(sierraConfig)

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
// One entry per mounted service, plus the non-service routes. It is a hand-kept
// copy of the registry and it HAS gone stale: `audit`, `channels`, `flags` and
// `api-keys` were each missing for a phase or more. Nothing failed loudly,
// because the Junction client is configured with the API's own origin and never
// uses this proxy — what breaks is anything fetching a relative URL from the
// page, which is every check in web/test/verify.mjs, and it breaks as a 404
// from Vite rather than as a refusal from the API.
const API_PATHS = [
  '/auth', '/setup', '/health', '/metrics', '/conduit-targets',
  '/workspaces', '/projects', '/environments', '/apps',
  '/servers', '/deployments', '/jobs', '/portal',
  '/alerts', '/networks', '/secrets', '/domains',
  '/audit', '/channels', '/flags', '/api-keys',
  '/volumes', '/dashboards', '/recipes', '/cleanup',
  '/hub',
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
  ...sierra,

  // @frontierjs/ui is aliased to the WORKSPACE SOURCE, not to the copy under
  // node_modules. `bun install` resolves a workspace dep by COPYING it
  // (CLAUDE.md § Live hazards), so without this a fix to a component needs a
  // reinstall before this app can see it — and a stale copy looks exactly like
  // a component that does not work. There is a hand-made symlink at
  // node_modules/@frontierjs/ui today; it will not survive a reinstall, and
  // this alias is what makes that not matter. Merged into Sierra's aliases
  // rather than replacing them.
  resolve: {
    ...sierra.resolve,
    alias: { ...sierra.resolve?.alias, '@frontierjs/ui': UI },
  },

  // The alias turns the bare specifier into a path inside the repo, so Vite
  // treats the components as project source; this keeps esbuild's dep pre-scan
  // off them regardless, since it cannot parse .mesa.
  optimizeDeps: {
    ...sierra.optimizeDeps,
    exclude: [...(sierra.optimizeDeps?.exclude ?? []), '@frontierjs/ui'],
  },

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
