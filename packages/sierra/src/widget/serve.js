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
import { join, extname, resolve } from 'node:path'

import { isHashedAsset } from '../serve/hashed-asset.js'
import { relativePathFor, withinRoot } from '../serve/served-path.js'
import { bodyAnswer, methodAnswer, ALLOWED_METHODS } from '../serve/http-answers.js'

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
  // Below: everything a widget bundle can legitimately reference and this table
  // answered `application/octet-stream` for. With `nosniff` set, that is not a
  // guess the browser recovers from — a `.wasm` served that way cannot be
  // `instantiateStreaming`'d at all, and `.woff` (not `2`) is still what an
  // older face ships as.
  '.woff': 'font/woff',
  '.ico':  'image/x-icon',
  '.gif':  'image/gif',
  '.avif': 'image/avif',
  '.wasm': 'application/wasm',
}

function cacheFor(path) {
  if (isHashedAsset(path)) return 'public, max-age=31536000, immutable'
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
 * @param {string[]} [opts.allowOutside] directories a symlink inside `dir` may
 *                                      legitimately resolve into; see
 *                                      serve/served-path.js
 * @returns {Promise<{ port: number, url: string, close: () => Promise<void> }>}
 */
export async function serveWidgets({
  dir, port = 0, host = '0.0.0.0', origin = '*', allowOutside = [],
} = {}) {
  const rootDir = resolve(dir)

  const server = createServer(async (req, res) => {
    const headers = {
      'Access-Control-Allow-Origin': origin,
      // A widget fetching its own API from the host page sends these; answering
      // them here costs nothing and a missing one is a blank widget with a
      // console message on somebody else's site.
      'Access-Control-Allow-Methods': ALLOWED_METHODS,
      'Access-Control-Allow-Headers': 'Content-Type',
      // Without this a browser preflights EVERY cross-origin fetch this widget
      // makes, so a page that loads the widget once pays two round trips for
      // every one it needs. Ten minutes is the ceiling Chromium honors.
      'Access-Control-Max-Age': '600',
      'Timing-Allow-Origin': origin,
      'X-Content-Type-Options': 'nosniff',
    }

    // Everything below is inside one try. The handler is `async`, so anything
    // that throws becomes an unhandled rejection — which node answers by
    // exiting the process, taking a public origin down on one bad request, and
    // bun answers by never writing the response at all (`FJS-784`).
    try {

    const verb = methodAnswer(req.method)
    if (verb) {
      res.writeHead(verb.status, { ...headers, ...verb.headers })
      res.end(verb.status === 405 ? 'method not allowed' : undefined)
      return
    }

    // What the URL says, decoded and normalized so `..` cannot walk out — this
    // is served to the open internet by definition.
    const safe = relativePathFor(req.url.split('?')[0].split('#')[0])

    // Not a 404: a URL that cannot be decoded is not a file that is missing.
    if (safe === null) {
      res.writeHead(400, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('bad request')
      return
    }

    const file = join(rootDir, safe)

    let body
    try {
      const info = await stat(file)
      if (info.isDirectory()) throw new Error('directory')
      // What the URL said is settled above; what the file IS is a second
      // question, and only realpath can answer it. Answered as not found for
      // the same reason junction does (`FJS-746`, `FJS-783`): a 403 confirms
      // to the caller that they found a way out of the root.
      if (!file.startsWith(rootDir)) throw new Error('outside root')
      if (!await withinRoot(rootDir, file, allowOutside)) throw new Error('outside root')
      body = await readFile(file)
    } catch {
      res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }

    const type   = TYPES[extname(file)] ?? 'application/octet-stream'
    const answer = bodyAnswer(body, type, {
      range:          req.headers.range,
      acceptEncoding: req.headers['accept-encoding'],
    })

    res.writeHead(answer.status, {
      ...headers,
      ...answer.headers,
      'Content-Type':  type,
      'Cache-Control': cacheFor(safe),
    })
    res.end(req.method === 'HEAD' ? undefined : answer.body)

    } catch (err) {
      // Logged rather than swallowed: a 500 on an origin whose whole job is to
      // hand back files it already has is a defect, and the operator is the
      // only one who can see it.
      console.error(`[Sierra] widgets: ${req.method} ${req.url} failed —`, err)
      // `end()` on a finished response emits an 'error' event with no listener,
      // which is the crash this catch exists to prevent, one step along.
      if (res.writableEnded) return
      if (!res.headersSent) {
        res.writeHead(500, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' })
      }
      res.end('internal error')
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
