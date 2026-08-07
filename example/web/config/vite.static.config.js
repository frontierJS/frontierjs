// web/config/vite.static.config.js
//
// The public prerendered site. Pairs with sierra.static.config.js; the SPA's
// vite.config.js is untouched.
//
//   bun run build:public
//
import { dirname, resolve } from 'node:path'
import { fileURLToPath }    from 'node:url'
import { defineConfig }     from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './sierra.static.config.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const UI   = resolve(HERE, '../../../packages/ui')

const sierra = createSierraViteConfig(sierraConfig)

export default defineConfig({
  ...sierra,

  // Same reason as the SPA config: @frontierjs/ui is aliased to the workspace
  // source, because `bun install` copies a workspace dep and a stale copy looks
  // exactly like a component that does not work.
  resolve: {
    ...sierra.resolve,
    alias: { ...sierra.resolve?.alias, '@frontierjs/ui': UI },
  },

  optimizeDeps: {
    ...sierra.optimizeDeps,
    exclude: [...(sierra.optimizeDeps?.exclude ?? []), '@frontierjs/ui'],
  },

  root: ROOT,
})
