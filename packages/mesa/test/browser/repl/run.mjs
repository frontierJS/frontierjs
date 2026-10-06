/*
 * run.mjs — the REPL, in a real browser.
 *
 *   node test/browser/repl/run.mjs             every spec
 *   node test/browser/repl/run.mjs --verbose   print the passing rows too
 *   node test/browser/repl/run.mjs --serve     serve the REPL and stay up
 *
 * Needs Chrome on PATH or `$FJS_CHROME`, and no network: the REPL's third-party
 * code is `example/vendor/`, committed, and `index.html` names it in its own
 * importmap. `bun example/build-vendor.mjs` rewrites it. A page that fetched
 * these off a CDN made this drive a suite that goes red on a train (`FJS-326`).
 *
 * ── What it exists to catch ───────────────────────────────────────────
 *
 * The REPL has been broken twice, both times in ways no file could report and
 * a page load reports instantly: a named export that had gone (a LINK-time
 * error in ESM — the whole module never runs, blank page, one console line),
 * and mounting by CALLING the component rather than through `mount()`, so
 * every example rendered perfectly and responded to nothing. `test/repl.test.js`
 * pins both by reading the file. This opens it.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSpecs } from '../drive.mjs'

const PKG  = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const HERE = fileURLToPath(new URL('.', import.meta.url))

const argv      = process.argv.slice(2)
const serveOnly = argv.includes('--serve')
const verbose   = argv.includes('--verbose')
const filters   = argv.filter((a) => !a.startsWith('--'))

const TYPES = {
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg':  'image/svg+xml',
}

/* ─── the REPL, served ────────────────────────────────────────────────── */

/*
 * The whole package is served at the root, so `example/index.html` reaches
 * `../src/compiler.js` and `./examples.js` by the same relative paths it uses
 * on disk. Nothing is compiled or rewritten here: the point is to load the
 * page the repository actually ships, importmap and all.
 */
function createReplServer() {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    const send = (code, body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    }

    const rel  = path === '/' ? '/example/index.html' : path
    const file = resolve(join(PKG, decodeURIComponent(rel)))
    if (file !== PKG && !file.startsWith(PKG + '/')) return send(404, `no route for ${path}`)

    try {
      const body = await readFile(file)
      send(200, body, TYPES[extname(file)] ?? 'application/octet-stream')
    } catch (err) {
      send(err.code === 'ENOENT' ? 404 : 500, String(err.message ?? err))
    }
  })

  return {
    async listen() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r))
      return `http://127.0.0.1:${server.address().port}`
    },
    close: () => new Promise((r) => server.close(r)),
  }
}

/* ─── run ─────────────────────────────────────────────────────────────── */

const repl   = createReplServer()
const origin = await repl.listen()

if (serveOnly) {
  console.log(`REPL served at ${origin}/example/index.html`)
} else {
  const { infra, failures } = await runSpecs({
    origin: origin + '/example/index.html',
    specDir: join(HERE, 'specs'),
    filters,
    verbose,
    // The REPL compiles and mounts its first example during boot, so the page
    // is not ready when `load` fires — `#pvlbl` reporting anything but its
    // initial "compiling…" is the page saying it got through.
    ready: `document.getElementById('pvlbl') && document.getElementById('pvlbl').textContent !== 'compiling…'`,
    // The REPL is a page this drive does not own — there is nowhere in it to
    // put an in-page probe, and the drawer animates, so a coordinate click has
    // to be able to ask whether it has stopped moving. The probes come from
    // this server's own origin, which is the same package.
    bootstrap: `
      import('/test/browser/probes.js')
        .then((m) => { m.installProbes(); window.__probesReady = true })
        .catch((e) => console.error('probes failed to load', e))
    `,
    extend: (browser) => ({
      goto: (path, ready) => browser.navigate(origin + path, ready),
      /** Reload the REPL at a hash, which is how a shared link arrives. */
      open: (hash = '') => browser.navigate(
        `${origin}/example/index.html${hash}`,
        `document.getElementById('pvlbl') && document.getElementById('pvlbl').textContent !== 'compiling…'`,
      ),
    }),
    // Back to the default example between specs. A REPL keeps its state in the
    // page — the loaded example, the hash, an open drawer — so without this
    // each spec inherits whatever the last one left, and the order they happen
    // to run in becomes part of what they assert.
    teardown: (browser) => browser.navigate(
      `${origin}/example/index.html`,
      `document.getElementById('pvlbl') && document.getElementById('pvlbl').textContent !== 'compiling…'`,
    ),
  })

  await repl.close()
  process.exit(failures || infra ? 1 : 0)
}
