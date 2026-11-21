// The same site built `hydratable: true`: each page adopts its server nodes
// from one tree, and a `client:*` subtree attaches on its trigger
// (`FJS-D2174`). `verify.mjs --hydratable` drives this build.
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './config/sierra.config.js'

const HERE = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  ...createSierraViteConfig({ ...sierraConfig, hydratable: true, outDir: 'dist/hydrate' }),
  root: HERE,
})
