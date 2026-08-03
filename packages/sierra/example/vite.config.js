// example/vite.config.js
//
// Note where this file is: at the Vite ROOT, next to index.html. Sierra derives
// the path to sierra.config.js by rewriting the resolved Vite config path, so a
// config/vite.config.js resolves to config/config/sierra.config.js and the
// build fails. If you must nest it, set `_configPath` in sierra.config.js.
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './config/sierra.config.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const API  = 'http://localhost:3500'

export default defineConfig({
  ...createSierraViteConfig(sierraConfig),

  // The example is run from the package root (`bun run example`), so the Vite
  // root has to be stated — everything Sierra resolves is relative to it:
  // routesDir, db/schema.lite, and the manifest it writes.
  root: HERE,

  server: {
    port: 5273,
    // Same-origin: the browser talks to Vite, Vite forwards to Junction. The
    // Junction client derives its WebSocket URL from the same base as its HTTP
    // calls, so proxying both here means one origin and no CORS.
    proxy: {
      '/api':   { target: API, changeOrigin: true },
      '/login': { target: API, changeOrigin: true },
      '/ws':    { target: API, ws: true },
    },
  },
})
