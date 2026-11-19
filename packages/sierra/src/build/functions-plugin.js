/**
 * functions-plugin.js — host functions, in dev
 *
 * `serveSite` mounts the entry a build wrote; `vite dev` serves no build, so a
 * page posting to `/api/event` reached Vite's SPA fallback and failed on
 * HTML where the host would have answered. The directory is read per request,
 * so a function added or edited under a running server answers on the next
 * call, and a refusal `functionRoutes` raises (a bracketed name, a host-only
 * import) reaches the person at the request rather than at the next build.
 *
 * Each function is imported the way the build imports it, a plain `import()`
 * keyed on the file's mtime, not through `server.ssrLoadModule`; see
 * `static-data-plugin.js` for what the SSR runner breaks under Bun.
 */

import { statSync } from 'node:fs'

import { functionHandler } from '../postbuild/function-handler.js'
import { hasFunctions, requestFrom, sendResponse, siteFunctionRoutes } from '../postbuild/functions.js'
import { plausibleProxy } from '../postbuild/plausible-proxy.js'
import { importFresh } from '../scanner/import-fresh.js'

// absolute file → the mtime it was last imported at, and the module that produced
const stamps  = new Map()
const modules = new Map()

async function load(file) {
  const stamp = statSync(file).mtimeMs
  if (stamps.get(file) !== stamp) {
    modules.set(file, await importFresh(file))
    stamps.set(file, stamp)
  }
  return modules.get(file)
}

/**
 * @param {{ functions?: string, analytics?: object }} config
 * @returns {import('vite').Plugin | null}
 */
export function functionsPlugin(config) {
  if (!hasFunctions(config)) return null

  return {
    name:  'sierra:functions',
    apply: 'serve',

    configureServer(server) {
      // Added directly rather than returned, so it runs ahead of Vite's own
      // middleware, the SPA fallback included.
      server.middlewares.use(async (req, res, next) => {
        try {
          const path  = new URL(req.url, 'http://localhost').pathname
          const key   = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
          const route = siteFunctionRoutes(config, server.config.root).find(r => r.path === key)
          if (!route) return next()

          const fn      = route.file ? (await load(route.file)).default : plausibleProxy({ [key]: route.upstream })[key]
          const handler = functionHandler({ [key]: fn }, process.env)
          await sendResponse(req, res, await handler.handle(await requestFrom(req)))
        } catch (err) {
          server.config.logger.error(`[Sierra] functions: ${req.method} ${req.url} failed\n${err?.stack ?? err}`)
          if (res.writableEnded) return
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('internal error')
        }
      })
    },
  }
}
