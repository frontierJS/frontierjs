/**
 * static-data-plugin.js — a prerendered route's `load()`, in dev
 *
 * A `render: static` route's `load()` runs in Node at build time and is where
 * an app reads its own database. Its companion may never enter the browser
 * graph: following one there published a storefront's Litestone client, the DDL
 * emitter and the migration engine as fetchable files on a public origin
 * (`FJS-543`). So the client route table has no import for it, and until now
 * that meant `vite dev` on a static surface rendered every page with
 * `data: null` — correct, and indistinguishable from a query that found nothing.
 *
 * The dev server IS a Node process. So the loader runs HERE, in the same place
 * the build runs it, and the browser gets JSON. Nothing about the published
 * output changes: this middleware exists only under `vite dev`, and the fetch
 * shim in the route table is emitted only for a table generated under `serve`.
 *
 * Two properties worth stating because they are what make this safe:
 *
 *   - It is a FETCH on the browser side, not an import. Whatever the companion
 *     pulls in stays in Node — the bundler never sees it, so there is no graph
 *     to leak into.
 *   - The companion is imported the way the BUILD imports it — a plain dynamic
 *     `import()` of the file on disk, exactly what `importCompanion` does in
 *     prerender.js — and not through `server.ssrLoadModule`. Vite's SSR runner
 *     was the obvious choice and does not work: it rewrites the module and does
 *     not provide Bun's `import.meta.dir`, so `example`'s own db module dies on
 *     `join(undefined, …)` before a query is ever made. Running it the way the
 *     build runs it is also the only way this can be trusted to agree with the
 *     build.
 *
 * `params` comes from the CLIENT rather than being re-derived here. The router
 * has already matched the URL and knows them; matching a second time on the
 * server would be a second implementation of the one thing the route table
 * exists to answer.
 */

import { resolve } from 'path'
import { statSync }  from 'fs'
import { pathToFileURL } from 'url'

const ENDPOINT = '/__sierra/static-data'

/**
 * @param {import('./index.js').SierraConfig} config
 * @param {object} sierraContext — carries the scanned tree
 * @returns {import('vite').Plugin}
 */
export function staticDataPlugin(config, sierraContext) {
  return {
    name: 'sierra:static-data',
    apply: 'serve',

    configureServer(server) {
      const root = server.config.root ?? process.cwd()

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith(ENDPOINT)) return next()

        const send = (status, body) => {
          res.statusCode = status
          res.setHeader('Content-Type', 'application/json')
          // A loader's answer is this navigation's, and a dev server that let a
          // browser cache it would show yesterday's catalogue after an edit.
          res.setHeader('Cache-Control', 'no-store')
          res.end(JSON.stringify(body))
        }

        try {
          const url     = new URL(req.url, 'http://localhost')
          const routeId = url.searchParams.get('route')
          const pageUrl = url.searchParams.get('url') ?? '/'
          let params    = {}
          try { params = JSON.parse(url.searchParams.get('params') ?? '{}') } catch { params = {} }

          const node = findNode(sierraContext.tree, routeId)
          if (!node)          return send(404, { error: `no such route: ${routeId}` })
          if (!node.companion) return send(404, { error: `${routeId} has no companion` })

          // Keyed by the companion's own mtime, so editing a `load()` is picked
          // up on the next navigation without restarting the server — and the
          // modules it IMPORTS stay cached, which is what keeps the app's
          // database client from being rebuilt on every page view.
          const abs = resolve(root, node.companion)
          let stamp = 0
          try { stamp = statSync(abs).mtimeMs } catch { /* it will fail on import */ }
          const mod = await import(`${pathToFileURL(abs).href}?t=${stamp}`)

          const load = mod?.load ?? mod?.default?.load
          if (typeof load !== 'function') return send(200, { data: null, head: null })

          const data = await load({
            params,
            url:   pageUrl,
            meta:  node.meta ?? {},
            fetch: globalThis.fetch,
          })

          // head() is in the same module and the router asks for it after the
          // data, so it is answered on the same round trip rather than a second.
          let head = null
          const headFn = mod?.head ?? mod?.default?.head
          if (typeof headFn === 'function') {
            try { head = await headFn({ params, data, url: pageUrl }) } catch { head = null }
          }

          send(200, { data, head })
        } catch (err) {
          // Reported as the loader's failure and with the stack in the terminal.
          // A 500 with no sentence here reads in the browser as the dev server
          // being broken, which is the wrong thing to go and look at.
          server.config.logger.error(
            `[Sierra] static-data: load() threw for ${req.url}\n${err?.stack ?? err?.message ?? err}`
          )
          send(500, { error: String(err?.message ?? err) })
        }
      })
    },
  }
}

/** Depth-first by node id — the same id the route table's keys use. */
function findNode(node, id) {
  if (!node || !id) return null
  if (node.id === id) return node
  for (const child of node.children ?? []) {
    const found = findNode(child, id)
    if (found) return found
  }
  return null
}
