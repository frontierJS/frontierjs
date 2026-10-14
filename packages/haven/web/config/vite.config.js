// web/config/vite.config.js
//
// The browser haven: the routes `fli haven` draws in a terminal, built for a
// browser (`FJS-D985`). Vite resolves the package's `#paint`, `#cell` and
// `#sign-in` imports under its `browser` condition, which is the whole of
// what differs between the two targets; nothing here names them.
//
// The page talks to its own origin (sierra.config.js), so every path the API
// answers is proxied from here. Without a rule a call lands on Vite's SPA
// fallback: 200, an HTML body, and a client reporting nonsense from the API.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './sierra.config.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The API's own slot unless a drive or `fli dev` says otherwise. The web
// literal is the global block's `havenWeb` (cli core/ports.js), beside the API.
const API  = process.env.API_URL ?? `http://localhost:${process.env.API_PORT ?? 5505}`
const PORT = Number(process.env.WEB_PORT ?? process.env.FLI_PORT_FE ?? 5506)

// The services autoloaded from api/src/services/ and the two raw routes under
// /haven/. A service added there needs its path here too, or the page's calls
// to it are answered by the SPA.
const API_PATHS = ['/rooms', '/members', '/messages', '/haven']

const sierra = createSierraViteConfig(sierraConfig)

export default defineConfig({
  ...sierra,
  root: ROOT,
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
