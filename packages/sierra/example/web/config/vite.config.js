// example/web/config/vite.config.js
//
// Configuration lives in config/, beside sierra.config.js — the standard FJS
// layout (config/ src/ public/ test/ dist/). Sierra looks for sierra.config.js
// next to this file first, so nesting needs no `_configPath` escape hatch.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './sierra.config.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const API  = 'http://localhost:3500'

export default defineConfig({
  ...createSierraViteConfig(sierraConfig),

  // The Vite root is web/, not config/. Everything Sierra resolves is relative
  // to it: routesDir, the manifest it writes, and ../db/schema.lite — which is
  // how the UI reads the same schema file the API does without a copy.
  // Stated explicitly so `bun run dev` works from the example root too.
  root: ROOT,

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
