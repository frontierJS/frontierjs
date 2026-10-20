// web/config/vite.config.js
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './sierra.config.js'
import { API_PATHS, NAVIGATED_API_PATHS, WS_PATH } from './api-paths.js'
import { ssoFromEnv } from '../../api/src/core/sso-env.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
// The literals are the dev slot, `API_PORT`/`UI_PORT` are what a drive sets, and
// `FRONTIER_PORT_*` is what `fli dev` hands a second checkout (18020 in branch 1). A
// drive pinned to 8020/8120 cannot run while somebody's dev server holds them,
// and one that refuses to run is one nobody runs.
const API_PORT = process.env.API_PORT ?? process.env.FRONTIER_PORT_BE ?? '8120'
const UI_PORT  = Number(process.env.UI_PORT ?? process.env.FRONTIER_PORT_FE ?? 8020)
const API  = `http://localhost:${API_PORT}`
const UI   = resolve(HERE, '../../../ui')

const sierra = createSierraViteConfig(sierraConfig)

// Basecamp mounts services at /{service} with no prefix, so an API path and a
// UI path are the SAME URL: GET /projects is both the service and the page.
// Client-side navigation never notices — the router does not touch the network
// — but a hard load or a refresh of /projects/ goes to Vite, and a plain proxy
// rule would answer it with JSON.
//
// So the proxy discriminates on Accept: a browser navigation asks for
// text/html and is handed the SPA; the Junction client asks for
// application/json and is proxied. Verified both ways in a browser.
//
// The list is `./api-paths.js` and not an array here, because the deploy needs
// the same one: the container is served behind a reverse proxy that has to make
// this identical decision, and a second copy would be the same bug one layer
// down. That file no longer holds a list — it derives one from
// `app.snapshot.md`, so a service added to the API reaches this proxy
// without anybody remembering to come here.
const proxy = Object.fromEntries(API_PATHS.map(path => [path, {
  target:       API,
  changeOrigin: true,
  bypass(req) {
    // Returning a path serves it from Vite instead of proxying; returning
    // undefined proxies. A navigation gets the shell, everything else the API.
    if (NAVIGATED_API_PATHS.some(p => req.url?.startsWith(p))) return undefined
    if (req.headers.accept?.includes('text/html')) return '/index.html'
    return undefined
  },
}]))

// The WebSocket has no HTML ambiguity to resolve — always proxy.
proxy[WS_PATH] = { target: API, ws: true }

export default defineConfig({
  ...sierra,

  // The twin of `cookieAuth` on the API's auth plugin: on exactly when a
  // sign-in provider is configured (`FJS-D670`). The browser cannot read the
  // API's environment, so the build reads the same variables and bakes the
  // answer in; sierra.config.js is evaluated in the page and holds no process.
  // Left false while the API runs cookie sessions, a signed-in browser has no
  // boot restore and no socket.
  define: {
    ...sierra.define,
    __BASECAMP_COOKIE_AUTH__: JSON.stringify(ssoFromEnv(process.env).length > 0),
  },

  // @frontierjs/ui is aliased to the WORKSPACE SOURCE, not to the copy under
  // node_modules. `bun install` resolves a workspace dep by COPYING it
  // (CLAUDE.md § Live hazards), so without this a fix to a component needs a
  // reinstall before this app can see it — and a stale copy looks exactly like
  // a component that does not work. There is a hand-made symlink at
  // node_modules/@frontierjs/ui today; it will not survive a reinstall, and
  // this alias is what makes that not matter. Merged into Sierra's aliases
  // rather than replacing them.
  //
  // ONLY when that directory is actually there. The path is `../../../ui`
  // relative to this file, which is a fact about the workspace and about
  // nowhere else: inside the container image this app is /app with no siblings,
  // and the alias rewrote every `@frontierjs/ui/...` import to a path that does
  // not exist — 22 UNLOADABLE_DEPENDENCY errors naming components that install
  // correctly. An alias to a directory that is not there is never right, so the
  // guard is existsSync rather than a NODE_ENV check.
  resolve: {
    ...sierra.resolve,
    alias: existsSync(UI)
      ? { ...sierra.resolve?.alias, '@frontierjs/ui': UI }
      : sierra.resolve?.alias,
  },

  // The alias turns the bare specifier into a path inside the repo, so Vite
  // treats the components as project source; this keeps esbuild's dep pre-scan
  // off them regardless, since it cannot parse .mesa.
  optimizeDeps: {
    ...sierra.optimizeDeps,
    exclude: [...(sierra.optimizeDeps?.exclude ?? []), '@frontierjs/ui'],
  },

  // The Vite root is web/, not config/. Everything Sierra resolves is relative
  // to it: routesDir, the manifest it writes, and ../db/schema.lite — the same
  // file the API reads, without a copy.
  root: ROOT,

  server: {
    // Sierra's base carries `host`, which `fli dev --host` sets.
    ...sierra.server,
    port: UI_PORT,   // dev/fe, project 2 — see packages/cli/core/ports.js

    // Refuse to hop ports. Vite's default is to take the next free one and
    // print a line nobody reads — which, with a stale server still holding
    // 8020, means the browser you open talks to the OLD build while the new
    // one runs somewhere else. A collision is a mistake; say so and stop.
    strictPort: true,

    proxy,
  },
})
