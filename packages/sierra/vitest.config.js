import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    environment: 'node',
  },
  resolve: {
    alias: {
      '@frontierjs/mesa': resolve(__dirname, '../mesa'),
    }
  },
  // Tell Vite to treat .mesa files as external assets in tests
  // Tests don't need to compile Mesa components — only JS modules
  assetsInclude: ['**/*.mesa'],
})
