/**
 * widget/serve.js — serve built widgets to pages this app does not own.
 *
 * A widget surface deploys as static files and nothing else: `dist/embeds/*.js`
 * behind a URL a stranger's page writes into a `<script src>`. That is a
 * different deployment from the API's container and from the SPA's bundle, and
 * it has two requirements neither of those has:
 *
 *   • **CORS, always.** The host page is on another origin by definition. A
 *     classic `<script src>` does not itself need CORS, but everything the
 *     widget does after loading — `import()` of a lazy chunk, a font, a
 *     stylesheet fetch, an error with a readable stack — does. A server that
 *     omits the header works in the smoke test and fails on the customer's site.
 *   • **A cache answer per file kind.** The script's URL is what a host page
 *     pasted into their CMS a year ago; it cannot change. So the entry is
 *     revalidated and only content-addressed assets are immutable.
 *
 * This is the module `sierra widgets --serve` runs, the one the generated
 * `widgets/deploy/` container runs, and the one the widget drive loads its
 * bundles through — so the headers a browser is tested against are the headers
 * that ship, rather than a second server written for the test.
 */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, normalize, resolve } from 'node:path'

const TYPES = {
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

/** Vite's hashed asset names. Only these may be cached forever. */
const HASHED = /-[A-Za-z0-9_]{8,}\.[a-z0-9]+$/

function cacheFor(path) {
  if (HASHED.test(path)) return 'public, max-age=31536000, immutable'
  // The entry: a host page's <script src> is written once and never updated, so
  // a long max-age here is a widget nobody can ship a fix to.
  return 'public, max-age=300, must-revalidate'
}

/**
 * Serve `dir` as a widget origin.
 *
 * @param {object}  opts
 * @param {string}  opts.dir            directory of built widgets
 * @param {number}  [opts.port=0]       0 asks the OS, and the real one comes
 *                                      back on the result — parallel drives
 *                                      cannot collide that way
 * @param {string}  [opts.host='0.0.0.0']
 * @param {string}  [opts.origin='*']   Access-Control-Allow-Origin
 * @returns {Promise<{ port: number, url: string, close: () => Promise<void> }>}
 */
export async function serveWidgets({ dir, port = 0, host = '0.0.0.0', origin = '*' } = {}) {
  const rootDir = resolve(dir)

  const server = createServer(async (req, res) => {
    const headers = {
      'Access-Control-Allow-Origin': origin,
      // A widget fetching its own API from the host page sends these; answering
      // them here costs nothing and a missing one is a blank widget with a
      // console message on somebody else's site.
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Timing-Allow-Origin': origin,
      'X-Content-Type-Options': 'nosniff',
    }

    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, headers); res.end('method not allowed'); return
    }

    // `normalize` before joining, so `..` cannot walk out of the directory —
    // this is served to the open internet by definition.
    const url  = decodeURIComponent(req.url.split('?')[0])
    const safe = normalize(url).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '')
    const file = join(rootDir, safe)

    if (!file.startsWith(rootDir)) { res.writeHead(403, headers); res.end('forbidden'); return }

    try {
      const info = await stat(file)
      if (info.isDirectory()) throw new Error('directory')
      const body = await readFile(file)
      res.writeHead(200, {
        ...headers,
        'Content-Type':   TYPES[extname(file)] ?? 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control':  cacheFor(safe),
      })
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch {
      res.writeHead(404, headers)
      res.end('not found')
    }
  })

  await new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(port, host, ok)
  })

  const actual = server.address().port
  return {
    port: actual,
    url:  `http://127.0.0.1:${actual}`,
    close: () => new Promise(ok => server.close(ok)),
  }
}
