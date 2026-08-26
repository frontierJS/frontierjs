// site/config/vite.config.js
//
// `vite dev` here is how the storefront is WRITTEN — the routes served as a
// client-routed app, so markup can be iterated on without a build.
//
// `bun run build:site` is what SHIPS. `target: 'static'` is the SPA's Vite
// config plus a prerender pass in `closeBundle`, so everything that makes this
// surface what it is — one HTML file per route, the publish check against the
// schema's gates, one chunk per island — exists only in the build. A page that
// works here and fails there is the normal case, not a surprise.

import { dirname, resolve } from 'node:path'
import { fileURLToPath }    from 'node:url'
import { defineConfig }     from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './sierra.config.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const UI   = resolve(HERE, '../../../packages/ui')

const base = createSierraViteConfig(sierraConfig)

export default defineConfig({
  ...base,
  root: ROOT,

  // Same reason as the SPA config: @frontierjs/ui is aliased to the workspace
  // source, because `bun install` copies a workspace dep and a stale copy looks
  // exactly like a component that does not work.
  resolve: {
    ...base.resolve,
    alias: { ...base.resolve?.alias, '@frontierjs/ui': UI },
  },
  optimizeDeps: {
    ...base.optimizeDeps,
    exclude: [...(base.optimizeDeps?.exclude ?? []), '@frontierjs/ui'],
  },

  server: {
    ...base.server,
    // dev / siteDev / project 1 (`example`) — derived, never chosen. See
    // packages/cli/core/ports.js. There is NO `/api` proxy here, deliberately:
    // this surface deploys to its own origin, so its islands must talk to the
    // API cross-origin. A dev proxy would make every CORS answer untested until
    // the day it shipped, which is exactly how the SPA's drives never preflight.
    port:       parseInt(process.env.SITE_PORT ?? process.env.FLI_PORT_SITE ?? '8610', 10),
    strictPort: true,
  },
})
