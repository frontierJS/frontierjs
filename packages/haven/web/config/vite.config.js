// web/config/vite.config.js
//
// The browser haven: the routes `fli haven` draws in a terminal, built for a
// browser (`FJS-D985`). Vite resolves the package's `#` imports under its
// `browser` condition, which is the whole of what differs between the two
// targets; nothing here names them.
//
// The page talks to its own origin (sierra.config.js), so every path the API
// answers is proxied from here. Without a rule a call lands on Vite's SPA
// fallback: 200, an HTML body, and a client reporting nonsense from the API.
import { readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './sierra.config.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The API's own slot unless a drive or `fli dev` says otherwise. The web
// literal is the global block's `havenWeb` (cli core/ports.js), beside the API.
const API  = process.env.FRONTIER_API_URL ?? `http://localhost:${process.env.API_PORT ?? 5505}`
const PORT = Number(process.env.WEB_PORT ?? process.env.FRONTIER_PORT_FE ?? 5506)

// Every service autoloaded from api/src/services/, read from that directory so a
// new one is proxied without a line here, and the two raw routes under /haven/.
const SERVICES  = resolve(ROOT, '../api/src/services')
const API_PATHS = [
  ...readdirSync(SERVICES).filter((f) => f.endsWith('.service.ts')).map((f) => `/${f.slice(0, -'.service.ts'.length)}`),
  '/haven',
]

const sierra = createSierraViteConfig(sierraConfig)

export default defineConfig({
  ...sierra,
  root: ROOT,
  // The weather and season a person or a drive pins (`web/src/lib/scene/sky.js`) -- the
  // browser has no environment, so each name is baked in when the server starts.
  define: {
    ...sierra.define,
    'import.meta.env.HAVEN_WEATHER': JSON.stringify(process.env.HAVEN_WEATHER ?? null),
    'import.meta.env.HAVEN_SEASON':  JSON.stringify(process.env.HAVEN_SEASON ?? null),
  },
  server: {
    ...sierra.server,
    port: PORT,
    // A port already held means another server, perhaps an older build of
    // this one, and a hop would leave the drive talking to it.
    strictPort: true,
    proxy: {
      ...Object.fromEntries(API_PATHS.map((path) => [path, { target: API, changeOrigin: true }])),
      '/ws': { target: API, ws: true },
    },
  },
})
