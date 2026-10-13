/**
 * site/serve.js — serve a prerendered site.
 *
 * A `site/` surface deploys as files: one `index.html` per route, a bundle of
 * island chunks beside them, and no application server. Most real deployments
 * are a bucket behind a CDN and never run this module — which is exactly why it
 * exists. The three answers a static host gives for free are the three a
 * hand-rolled `createServer` in a test harness forgets, and then the harness
 * proves the site works under rules nothing in production applies:
 *
 *   • **Directory index.** `trailingSlash: 'always'` emits `about/index.html`,
 *     and the URL in every link is `/about/`. A server that does not resolve a
 *     directory to its index answers 404 for every page but the root, and the
 *     build looks broken when it is not.
 *   • **A cache answer per file kind.** An HTML file's URL is permanent and its
 *     content is a build artefact, so it must be revalidated; a hashed asset is
 *     immutable. Getting this backwards is a site that serves last week's page
 *     to anyone who visited last week, which is invisible locally.
 *   • **A 404 that is a page.** A static host serves `404.html` when it has one.
 *     Emitting one and never serving it is the same as not having one.
 *
 * There is no CORS here and that is deliberate — this origin serves documents
 * a browser navigates to, not resources another origin fetches. The API is what
 * a page's islands call, and CORS is that server's answer to give. A widget
 * origin is the opposite case: see widget/serve.js.
 *
 * This is the module `sierra site --serve` runs, the one the generated
 * `site/deploy/` container runs, and the one a site drive points a browser at.
 */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import { isHashedAsset } from '../serve/hashed-asset.js'
import { relativePathFor, withinRoot } from '../serve/served-path.js'
import { bodyAnswer, methodAnswer } from '../serve/http-answers.js'

import { contentTypeFor } from '@frontierjs/toolbelt/mime'

// The type table is `@frontierjs/toolbelt/mime` (`FJS-1186`). This file is the
// reason the row exists: it gained `.avif` in the pass that added `.wasm` to
// `widget/serve.js` and never gained `.wasm` itself.

function cacheFor(path) {
  if (isHashedAsset(path)) return 'public, max-age=31536000, immutable'
  // Everything else, HTML included: the URL is permanent and the bytes behind
  // it change on every build, so the only safe answer is revalidate.
  return 'public, max-age=0, must-revalidate'
}

/**
 * Resolve an already-decoded, root-relative path to a file on disk.
 *
 * Two candidates and the order matters. `/about/` is a directory, so its index
 * is the answer; `/about` names the same page and a static host redirects or
 * serves the index rather than 404ing, because a link written without the slash
 * is the commonest thing in a hand-typed URL. An exact file wins over both —
 * `/robots.txt` is a file, not a directory to index.
 */
async function resolveFile(rootDir, safe, allowOutside) {
  const base = join(rootDir, safe)
  // `..` cannot walk out — this is served to the open internet by definition.
  if (!base.startsWith(rootDir)) return null

  const candidates = safe === '' || safe.endsWith('/')
    ? [join(base, 'index.html')]
    : [base, join(base, 'index.html')]

  for (const file of candidates) {
    try {
      const info = await stat(file)
      if (!info.isFile()) continue
      // What the URL SAID is settled above; what the file IS is a second
      // question, and only realpath can answer it (`FJS-783`).
      if (!await withinRoot(rootDir, file, allowOutside)) continue
      // Root-relative, the name `resolveEntry` gives: `cacheFor` reads where in
      // the build the file sits, and the disk path above the root is not that.
      return { read: file, name: relative(rootDir, file) }
    } catch { /* next candidate */ }
  }
  return null
}

/**
 * The same two candidates against a closed map of files — the site compiled into
 * one executable (`site/compile.js`). Bun's embedded filesystem has no
 * directories and no realpath, so `stat` and `withinRoot` answer nothing there;
 * a map key IS the published path, and nothing outside the map is reachable.
 *
 * `name` is the published path because the embedded file is renamed with a
 * content hash — `index-2ax96sah.html` — and `cacheFor` reading that would mark
 * every page immutable.
 */
function resolveEntry(files, safe) {
  const candidates = safe === '' || safe.endsWith('/')
    ? [join(safe, 'index.html')]
    : [safe, join(safe, 'index.html')]
  for (const name of candidates) {
    if (files.has(name)) return { read: files.get(name), name }
  }
  return null
}

/**
 * Serve `dir` as a prerendered site origin.
 *
 * @param {object}  opts
 * @param {string}  [opts.dir]         the build output — one index.html per route
 * @param {Map<string, string>} [opts.files]  in place of `dir`: published path
 *                                     (`about/index.html`) → a path `readFile`
 *                                     reads. What a compiled site serves from
 * @param {number}  [opts.port=0]      0 asks the OS, and the real one comes back
 *                                     on the result, so parallel drives cannot
 *                                     collide
 * @param {string}  [opts.host='0.0.0.0']
 * @param {string}  [opts.notFound='404.html']  served for a miss when it exists
 * @param {string[]} [opts.allowOutside]  directories a symlink inside `dir` may
 *                                     legitimately resolve into; see
 *                                     serve/served-path.js
 * @returns {Promise<{ port: number, url: string, close: () => Promise<void> }>}
 */
export async function serveSite({
  dir, files, port = 0, host = '0.0.0.0', notFound = '404.html', allowOutside = [],
} = {}) {
  const rootDir = files ? null : resolve(dir)
  const find    = files
    ? async (safe) => resolveEntry(files, safe)
    : (safe) => resolveFile(rootDir, safe, allowOutside)

  const server = createServer(async (req, res) => {
    const headers = { 'X-Content-Type-Options': 'nosniff' }

    // Everything below is inside one try. The handler is `async`, so anything
    // that throws becomes an unhandled rejection — which node answers by
    // exiting the process, taking a public origin down on one bad request. The
    // decode was the way in that was found (`FJS-784`); `readFile` racing a
    // deleted file between the stat and the read has the identical shape, and
    // so does every line added here later.
    try {

    // A wrong verb is 405 CARRYING `Allow` and an unclaimed OPTIONS is 204 —
    // the shape `FJS-753` settled for junction, and the same one a static host
    // gives. This answered 405 to both, with nothing saying what was allowed.
    const verb = methodAnswer(req.method)
    if (verb) {
      res.writeHead(verb.status, { ...headers, ...verb.headers })
      res.end(verb.status === 405 ? 'method not allowed' : undefined)
      return
    }

    const urlPath = req.url.split('?')[0].split('#')[0]
    const safe    = relativePathFor(urlPath)

    // Not a 404: a URL that cannot be decoded is not a file that is missing.
    if (safe === null) {
      res.writeHead(400, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('bad request')
      return
    }

    const file = await find(safe)

    if (file) {
      const body   = await readFile(file.read)
      const type   = contentTypeFor(file.name, { charset: true })
      const answer = bodyAnswer(body, type, {
        range:          req.headers.range,
        acceptEncoding: req.headers['accept-encoding'],
      })

      res.writeHead(answer.status, {
        ...headers,
        ...answer.headers,
        'Content-Type':  type,
        'Cache-Control': cacheFor(file.name),
      })
      res.end(req.method === 'HEAD' ? undefined : answer.body)
      return
    }

    // A miss gets the site's own 404 page where the build emitted one, with the
    // status still 404 — a soft 404 is a page a crawler indexes.
    const fallback = await find(notFound)
    if (fallback) {
      const body = await readFile(fallback.read)
      res.writeHead(404, {
        ...headers,
        'Content-Type':   'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control':  'public, max-age=0, must-revalidate',
      })
      res.end(req.method === 'HEAD' ? undefined : body)
      return
    }

    res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')

    } catch (err) {
      // Logged rather than swallowed: a 500 on an origin whose whole job is to
      // hand back files it already has is a defect, and the operator is the
      // only one who can see it.
      console.error(`[Sierra] site: ${req.method} ${req.url} failed —`, err)
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
