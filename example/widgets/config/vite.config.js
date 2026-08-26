// widgets/config/vite.config.js
// `vite dev` here is how a widget is WRITTEN — index.html hosts them live.
// `fli widgets:build` (sierra widgets) is what emits the embeddable scripts,
// because each one is its own library build. See sierra build/widget-build.js.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './sierra.config.js'

// The Vite root is the surface root, one level up from config/ — the same
// relationship web/config/vite.config.js has to web/.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const base = createSierraViteConfig(sierraConfig)

export default defineConfig({
  ...base,
  root: ROOT,
  server: {
    ...base.server,
    // dev / widgetDev / this app's project id — derived, never chosen. A widget
    // surface is a THIRD server while one is being written and a fourth origin
    // once it is served, and neither is the SPA's. See packages/cli/core/ports.js.
    port:       parseInt(process.env.WIDGET_PORT ?? process.env.FLI_PORT_WIDGET ?? '8210', 10),
    // Vite hops to the next free port without a word, and the drive pointed at
    // the port it hopped from then tests whatever else is listening.
    strictPort: true,
  },
})
