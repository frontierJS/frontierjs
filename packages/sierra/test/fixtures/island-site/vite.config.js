import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './config/sierra.config.js'

const HERE = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  ...createSierraViteConfig(sierraConfig),
  root: HERE,
})
