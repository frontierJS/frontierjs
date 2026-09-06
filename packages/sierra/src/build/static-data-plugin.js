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
import { importFresh } from '../scanner/import-fresh.js'

const ENDPOINT = '/__sierra/static-data'

// absolute companion path → the mtime it was last imported at, and the module
// that import produced. The cache this middleware always claimed to have.
const lastStamp = new Map()
const lastMod   = new Map()

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

        // Two refusals, and the second is the one the first cannot make.
        //
        // What is being protected is not the RESPONSE — that is unreadable
        // cross-origin already — but the SIDE EFFECT, because `load()` is by
        // design where an app reads its own database and may `fetch()` a URL it
        // was handed (`FJS-821`). Dev only, and `VITE_HOST_APP` binds this to
        // 0.0.0.0, so the page driving it need not be on this machine.
        //
        // GET only: a cross-origin `<form>` POST is a SIMPLE request, so no
        // preflight asks this server whether it wants the call.
        if (req.method !== 'GET') return next()

        // …and a GET from another SITE, which the verb check cannot cover:
        // `<img src>`, `<script src>` and a top-level form GET are all simple
        // GETs and none of them sends an `Origin` header to read.
        // `Sec-Fetch-Site` is what answers it — set by the browser, and a page
        // can neither forge nor suppress it. Absent means a caller that is not
        // a browser (curl, a test), which is not the threat; `none` is a typed
        // URL or a bookmark.
        const site = req.headers['sec-fetch-site']
        if (site && site !== 'same-origin' && site !== 'none') {
          return send(403, { error: 'cross-site request refused' })
        }

        try {
          const url     = new URL(req.url, 'http://localhost')
          const routeId = url.searchParams.get('route')
          const pageUrl = url.searchParams.get('url') ?? '/'
          let sent      = {}
          try { sent = JSON.parse(url.searchParams.get('params') ?? '{}') } catch { sent = {} }

          const node = findNode(sierraContext.tree, routeId)
          if (!node)          return send(404, { error: `no such route: ${routeId}` })
          if (!node.companion) return send(404, { error: `${routeId} has no companion` })

          // Only a route that DECLARES `render: static`. This endpoint exists
          // because a static route's companion never enters the browser graph;
          // a route that does not declare it has its loader in the graph
          // already and reaches it there. Without the check the endpoint runs
          // the companion of any route in the tree, which is a second way into
          // code the client route table deliberately imports differently.
          if (node.meta?.render !== 'static') {
            return send(404, { error: `${routeId} is not a render: static route` })
          }

          // Only the params the ROUTE declares, and each one a string, which is
          // what a path capture is. The client sends them because the router
          // has already matched the URL — but *the client sends them* is not a
          // reason to hand a `load()` an arbitrary object, and `__proto__` in
          // that object reached it (`FJS-821`).
          const params = Object.create(null)
          for (const name of node.params ?? []) {
            const v = sent?.[name]
            if (typeof v === 'string' || typeof v === 'number') params[name] = String(v)
          }

          // Keyed by the companion's own mtime, so editing a `load()` is picked
          // up on the next navigation without restarting the server — and the
          // modules it IMPORTS stay cached, which is what keeps the app's
          // database client from being rebuilt on every page view.
          //
          // The mtime is a key HERE rather than a query on the specifier: bun
          // does not include a query string in the module cache key, so
          // `?t=${mtime}` under `bun --bun vite` — the runtime this surface's
          // dev server is required to be — never missed at all, and the header
          // above promised an edit was picked up when it never was (`FJS-806`).
          const abs = resolve(root, node.companion)
          let stamp = 0
          try { stamp = statSync(abs).mtimeMs } catch { /* it will fail on import */ }
          const mod = stamp === lastStamp.get(abs) && lastMod.has(abs)
            ? lastMod.get(abs)
            : await importFresh(abs)
          lastStamp.set(abs, stamp)
          lastMod.set(abs, mod)

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
          // A throwing head() is NOT swallowed, because the build does not
          // swallow it: there it skips the page, and a skipped page fails the
          // build (`FJS-439`). Answering `head: null` in dev made one question
          // have two answers, and the dev one hid the failure until deploy —
          // which is the wrong way round for the half a person is looking at.
          // It falls to the catch below, the same as a load() that threw.
          let head = null
          const headFn = mod?.head ?? mod?.default?.head
          if (typeof headFn === 'function') {
            head = await headFn({ params, data, url: pageUrl })
          }

          send(200, { data, head })
        } catch (err) {
          // Reported as the loader's failure and with the stack in the terminal.
          // A 500 with no sentence here reads in the browser as the dev server
          // being broken, which is the wrong thing to go and look at.
          server.config.logger.error(
            `[Sierra] static-data: the companion threw for ${req.url}\n${err?.stack ?? err?.message ?? err}`
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
