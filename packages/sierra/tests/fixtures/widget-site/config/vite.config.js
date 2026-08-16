import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './sierra.config.js'

// The Vite root is the SURFACE root, one level up from config/ — the same
// relationship `web/config/vite.config.js` has to `web/`. Every path in the
// sierra config resolves against it.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// `vite dev` over this config is how a widget is written; `sierra widgets` is
// what emits the embeddable scripts. See build/widget-build.js.
export default defineConfig({
  ...createSierraViteConfig(sierraConfig),
  root: ROOT,
  // Vite hops to the next free port in silence, and a drive pointed at the
  // hopped-from port then tests whatever else is listening.
  server: { strictPort: true },
})
