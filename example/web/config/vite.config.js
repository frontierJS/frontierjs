// web/config/vite.config.js
//
// Configuration lives in config/, beside sierra.config.js. Sierra looks for
// sierra.config.js next to this file first, so the pair needs no _configPath.
import { dirname, resolve } from 'node:path'
import { fileURLToPath }    from 'node:url'
import { defineConfig }     from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './sierra.config.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const API  = 'http://localhost:8110'
const UI   = resolve(HERE, '../../../packages/ui')

const sierra = createSierraViteConfig(sierraConfig)

export default defineConfig({
  ...sierra,

  // @frontierjs/ui is aliased to the WORKSPACE SOURCE, not to the copy under
  // node_modules. `bun install` resolves a workspace dep by copying it, so
  // without this every fix to a component would need a reinstall before this
  // app could see it — and a stale copy looks exactly like a component that
  // does not work. Merged into Sierra's aliases rather than replacing them.
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
  // to it — routesDir, the manifest it writes, and ../db/schema.lite. Stated
  // explicitly so `bun run dev` works from the example root without a cd.
  root: ROOT,

  server: {
    port: 8010,
    // Refuse to hop. Vite's default is to take the next free port in silence,
    // which is how a drive ends up asserting against a different app.
    strictPort: true,
    // One origin: the browser talks to Vite, Vite forwards to Junction. That is
    // also what lets the Junction client derive its WebSocket URL from the same
    // base as its HTTP calls, and it means no CORS.
    proxy: {
      // One entry covers the whole API: apiPrefix moves every route the app
      // registers, raw ones included — auth, the session probe and Caravan's
      // admin routes are all under /api. /ws is the socket, which is not a
      // route.
      '/api':     { target: API, changeOrigin: true },
      '/ws':      { target: API, ws: true },
    },
  },
})
