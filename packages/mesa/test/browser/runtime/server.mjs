/*
 * server.mjs — this package, served to a browser, compiled on demand.
 *
 * Nothing in mesa builds, so there is no bundle to point a browser at: this
 * server IS the build step, one module at a time, and the browser's own module
 * graph does the resolving. Everything under the package root is at
 * `/mesa/<relative path>`; a `.mesa` is compiled, anything else is served
 * verbatim. That is what lets a fixture live beside its spec and import a
 * sibling by the relative path an app would write.
 *
 * ── Why a server and not a file:// page ───────────────────────────────
 *
 * Compiled output is ES modules and imports `@frontierjs/mesa/runtime.js`.
 * `file://` module resolution is subject to CORS, and rewriting the specifier
 * into something only this harness accepts would test a shape no app has. An
 * import map over HTTP resolves it exactly as an app does.
 *
 * The compiler is imported by RELATIVE path rather than through the package
 * name, for the reason every in-repo consumer does: `bun install` resolves a
 * workspace dependency to a copy under `node_modules/.bun/`, so a by-name
 * import would drive a snapshot taken at install time and this drive would
 * report green against a compiler that no longer exists.
 *
 * `node test/browser/runtime/server.mjs` starts it standalone and prints the
 * URL — which is the way to eyeball a fixture in a real browser.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileSource } from '../../../src/compiler.js'

// resolve() rather than the URL path as-is: `new URL('../../..')` keeps its
// trailing slash, and the containment check below compares against `base + '/'`.
const PKG = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

const TYPES = {
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.mesa': 'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
}

/*
 * The import map.
 *
 * Both spellings of the runtime are mapped because the compiler's output and a
 * hand-written import do not have to agree about the extension.
 */
const IMPORT_MAP = {
  imports: {
    '@frontierjs/mesa/runtime.js': '/mesa/src/runtime.js',
    '@frontierjs/mesa/runtime':    '/mesa/src/runtime.js',
  },
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>@frontierjs/mesa — runtime drive</title>
<script type="importmap">${JSON.stringify(IMPORT_MAP)}</script>
<style>
  /* A stage with a real box. Not display:none and not a hidden subtree: a
     hidden element still computes styles but never lays out, so anything that
     reads geometry — an animation, a measured attachment — silently reads
     zero. Sized so a fixture is laid out at a width, since a scoped rule
     asserted through the CSSOM still needs the element to exist on screen. */
  #stage { min-height: 200px; padding: 8px; }
</style>
</head>
<body>
<div id="stage"></div>
<script type="module" src="/mesa/test/browser/runtime/page.js"></script>
</body>
</html>
`

/** Compile a `.mesa` file to the module a browser can import.
 *
 *  `css` is left at its default, which INLINES the scoped rules as
 *  `$runtime.addStyles(...)`. That is what both Vite plugins do, so what runs
 *  here is what runs in an app; extracting them would mean this harness places
 *  styles nothing else places, and a scoped-style bug would be invisible
 *  exactly where it lives (`css` is a destination, not a switch). */
async function compileMesa(file) {
  const src = await readFile(file, 'utf8')
  const warnings = []
  const ctx = await compileSource(src, {
    filename: file,
    warning: (w) => warnings.push(w.message ?? String(w)),
  })
  // The compiler COLLECTS most diagnostics rather than throwing, so a module
  // built from a component with errors loads and renders something wrong.
  if (ctx.analysis?.errors?.length)
    throw new Error(`${ctx.analysis.errors.length} compile error(s):\n  • ` +
      ctx.analysis.errors.join('\n  • '))
  return { code: ctx.result, warnings }
}

/** Resolve a URL path under a base directory, refusing anything that escapes it. */
function safeJoin(base, rel) {
  const p = resolve(join(base, decodeURIComponent(rel)))
  return p === base || p.startsWith(base + '/') ? p : null
}

export function createMesaServer({ onWarning } = {}) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname

    const send = (code, body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(code, {
        'content-type': type,
        // Every request is compiled fresh; a cached module would serve the
        // previous edit back to the next run of the drive.
        'cache-control': 'no-store',
      })
      res.end(body)
    }

    try {
      if (path === '/' || path === '/index.html') return send(200, PAGE, TYPES['.html'])

      const file = path.startsWith('/mesa/') ? safeJoin(PKG, path.slice(6)) : null
      if (!file) return send(404, `no route for ${path}`)

      if (extname(file) === '.mesa') {
        const { code, warnings } = await compileMesa(file)
        for (const w of warnings) onWarning?.(file, w)
        return send(200, code, TYPES['.mesa'])
      }

      const body = await readFile(file)
      return send(200, body, TYPES[extname(file)] ?? 'application/octet-stream')
    } catch (err) {
      // A compile failure is served as a module that THROWS, so it surfaces as
      // a page exception naming the file rather than as a 500 the browser
      // reports only as "failed to fetch dynamically imported module".
      if (extname(path) === '.mesa') {
        const msg = String(err.message ?? err).replace(/\\/g, '\\\\').replace(/`/g, '\\`')
        return send(200, `throw new Error(\`[mesa] ${path}\\n${msg}\`)`, TYPES['.mesa'])
      }
      send(err.code === 'ENOENT' ? 404 : 500, String(err.message ?? err))
    }
  })

  return {
    server,
    /** Bind an ephemeral port and read back the one the OS gave us — a fixed
     *  port would collide with a second suite running in parallel. */
    async listen() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r))
      return `http://127.0.0.1:${server.address().port}`
    },
    close: () => new Promise((r) => server.close(r)),
  }
}

// Standalone: serve and stay up, for looking at a fixture in a real browser.
if (import.meta.url === `file://${process.argv[1]}`) {
  const it = createMesaServer({ onWarning: (f, w) => console.error(`! ${f}\n    ${w}`) })
  const origin = await it.listen()
  console.log(`mesa served at ${origin}`)
  console.log('fixtures import through /mesa/test/browser/runtime/fixtures/<name>.mesa')
}
