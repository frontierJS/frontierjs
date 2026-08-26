// site/config/vite.config.js
//
// `vite dev` here serves the routes client-routed, which is how a page is
// WRITTEN. `vite build` is what ships: target 'static' is this same config plus
// a prerender pass in closeBundle, so one HTML file per route, the island
// chunks and the publish check all exist only in the build. A page that works
// in dev and fails in the build is the normal case.

import { dirname, resolve } from 'node:path'
import { fileURLToPath }    from 'node:url'
import { defineConfig }     from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './sierra.config.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const base = createSierraViteConfig(sierraConfig)

export default defineConfig({
  ...base,
  root: ROOT,
  server: {
    ...base.server,
    // dev / siteDev / project 9 (`website`) — derived, never chosen.
    // packages/cli/core/ports.js.
    port:       parseInt(process.env.SITE_PORT ?? process.env.FLI_PORT_SITE ?? '8690', 10),
    strictPort: true,
  },
})
