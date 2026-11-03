// web/config/vite.config.js
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './sierra.config.js'
import { API_PATHS, WS_PATH } from './api-paths.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
// The literals are the global tooling block's `workbench` and `workbenchWeb`
// (packages/cli/core/ports.js); `API_PORT`/`UI_PORT` are what a drive sets.
const API_PORT = process.env.API_PORT ?? 5501
const UI_PORT  = Number(process.env.UI_PORT ?? 5508)
const API  = `http://localhost:${API_PORT}`
const UI   = resolve(HERE, '../../../ui')

const sierra = createSierraViteConfig(sierraConfig)

// Services mount at /{service} with no prefix, so a page and a service share a
// URL: a browser navigation asks for text/html and is handed the SPA; the
// Junction client asks for application/json and is proxied.
const proxy = Object.fromEntries(API_PATHS.map(path => [path, {
  target:       API,
  changeOrigin: true,
  bypass(req) {
    if (req.headers.accept?.includes('text/html')) return '/index.html'
    return undefined
  },
}]))

// The WebSocket has no HTML ambiguity to resolve -- always proxy.
proxy[WS_PATH] = { target: API, ws: true }

export default defineConfig({
  ...sierra,

  // @frontierjs/ui is aliased to the WORKSPACE SOURCE: `bun install` resolves a
  // workspace dep by COPYING it, and a stale copy looks exactly like a component
  // that does not work. Only when that directory is there (CLAUDE.md § Live hazards).
  resolve: {
    ...sierra.resolve,
    alias: existsSync(UI)
      ? { ...sierra.resolve?.alias, '@frontierjs/ui': UI }
      : sierra.resolve?.alias,
  },
  optimizeDeps: {
    ...sierra.optimizeDeps,
    exclude: [...(sierra.optimizeDeps?.exclude ?? []), '@frontierjs/ui'],
  },

  // The Vite root is web/, not config/: everything Sierra resolves is relative to it.
  root: ROOT,

  server: {
    ...sierra.server,
    port: UI_PORT,
    // Refuse to hop ports: a stale server holding 5508 would leave the browser
    // talking to the OLD build while the new one runs somewhere else.
    strictPort: true,
    proxy,
  },
})
