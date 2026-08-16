/*
 * server.mjs — the kit, served to a browser, compiled on demand.
 *
 * A component in this kit is a `.mesa` file. Nothing in the package builds, so
 * there is no bundle to point a browser at: this server IS the build step, one
 * module at a time, and the browser's own module graph does the resolving.
 *
 * ── Why a server and not a file:// page ───────────────────────────────
 *
 * `@frontierjs/css`'s harness writes one HTML file and opens it with
 * `file://`, which works because everything it tests is a stylesheet. This kit
 * is ES modules: `file://` module resolution is subject to CORS, and a compiled
 * component imports `@frontierjs/mesa/runtime.js`, `../../utils.js` and its
 * child components. Serving over HTTP with an import map means those specifiers
 * resolve exactly as they do in an app, rather than being rewritten into
 * something only this harness would accept.
 *
 * ── One rule for what is served ───────────────────────────────────────
 *
 * Everything under the package root is at `/kit/<relative path>`; a `.mesa` is
 * compiled, anything else is served verbatim. That is what lets a fixture live
 * beside its spec and import `../../../components/forms/DatePicker.mesa` — the
 * same relative import an app writes, resolved by the browser.
 *
 * Mesa is read by RELATIVE PATH, never through the `@frontierjs/mesa`
 * specifier. `bun install` resolves a workspace dependency to a copy under
 * `node_modules/.bun/`, so the specifier reads a snapshot taken at install time
 * and this drive would report green against a compiler that no longer exists.
 *
 * `node test/browser/server.mjs` starts it standalone and prints the URL —
 * which is the way to eyeball a component while working on it.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileSource } from '../../../mesa/src/compiler.js'

// resolve() rather than the URL path as-is: `new URL('../..')` keeps its
// trailing slash, and the containment check below compares against `base + '/'`
// — so every path under the package root read as an escape attempt and 404'd.
const PKG   = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const MESA  = resolve(fileURLToPath(new URL('../../../mesa', import.meta.url)))
const CSS   = resolve(fileURLToPath(new URL('../../../css', import.meta.url)))
// Sierra is served for ONE module: `src/junction/field-rules.js`, the real
// control table. A fixture that decided for itself which control a `Float`
// gets would pass while the two disagreed, which is the failure the shared
// table exists to prevent — `test/form.mjs` imports the same file by relative
// path for the same reason. It is a leaf and imports nothing, so serving it
// pulls no package in behind it and inverts no dependency: this is a test
// harness reading a file, not the kit importing Sierra.
const SIERRA = resolve(fileURLToPath(new URL('../../../sierra', import.meta.url)))
// …and toolbelt behind it, because that table reads the `$` directive names
// from the substrate package rather than restating them. It depends on
// nothing, so the chain stops here.
const TOOLBELT = resolve(fileURLToPath(new URL('../../../toolbelt', import.meta.url)))

const TYPES = {
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.mesa': 'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg':  'image/svg+xml',
}

/*
 * The import map.
 *
 * A compiled component imports `@frontierjs/mesa/runtime.js`; two components
 * import `@frontierjs/ui/...` by its published name rather than relatively.
 * Both spellings of the runtime are mapped because the compiler's output and a
 * hand-written import do not have to agree about the extension.
 *
 * The trailing-slash entry is a prefix mapping, and it does NOT cover
 * `@frontierjs/ui/controls` — a bare specifier with no extension has to be
 * spelled out, because the browser does no extension guessing.
 */
const IMPORT_MAP = {
  imports: {
    '@frontierjs/mesa/runtime.js':      '/@mesa/src/runtime.js',
    '@frontierjs/mesa/runtime':         '/@mesa/src/runtime.js',
    '@frontierjs/ui/':                  '/kit/',
    '@frontierjs/ui/controls':          '/kit/controls.js',
    '@frontierjs/ui/utils':             '/kit/utils.js',
    '@frontierjs/ui/stores/toastStore': '/kit/stores/toastStore.js',
    '@frontierjs/ui/stores/alertStore': '/kit/stores/alertStore.js',
    // The real control table, for a fixture standing in for a resource, and
    // the two toolbelt kits it reads. Spelled out one by one: a bare specifier
    // with no extension gets no guessing from the browser.
    '@frontierjs/sierra/field-rules':   '/@sierra/src/junction/field-rules.js',
    '@frontierjs/toolbelt/directives':  '/@toolbelt/src/directives/directives.js',
    '@frontierjs/toolbelt/inflect':     '/@toolbelt/src/inflect/inflect.js',
  },
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>@frontierjs/ui — kit drive</title>
<link rel="stylesheet" href="/@css/src/index.css">
<link rel="stylesheet" href="/kit/tokens.css">
<script type="importmap">${JSON.stringify(IMPORT_MAP)}</script>
</head>
<body class="theme-default">
<!--
  The stage is a real, visible box. Not display:none and not a hidden subtree:
  a hidden element still computes styles but never lays out, so anything that
  reads geometry — a popover's placement, a slider's track, a focus trap's
  first tabbable — silently reads zero.
-->
<div id="stage"></div>
<script type="module" src="/kit/test/browser/page.js"></script>
</body>
</html>
`

/** Compile a `.mesa` file to the module a browser can import.
 *
 *  `css` is left at its default, which INLINES the scoped rules as
 *  `$runtime.addStyles(...)`. That is what the Vite plugin does, so what runs
 *  here is what runs in an app; extracting them would mean this harness
 *  places styles that nothing else places, and a scoped-style bug would be
 *  invisible exactly where it lives. */
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

export function createKitServer({ onWarning } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname

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

      let file = null
      if (path.startsWith('/kit/'))          file = safeJoin(PKG,    path.slice(5))
      else if (path.startsWith('/@mesa/'))   file = safeJoin(MESA,   path.slice(7))
      else if (path.startsWith('/@css/'))    file = safeJoin(CSS,    path.slice(6))
      else if (path.startsWith('/@sierra/')) file = safeJoin(SIERRA, path.slice(9))
      else if (path.startsWith('/@toolbelt/')) file = safeJoin(TOOLBELT, path.slice(11))

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

// Standalone: serve and stay up, for looking at a component in a real browser.
if (import.meta.url === `file://${process.argv[1]}`) {
  const kit = createKitServer({ onWarning: (f, w) => console.error(`! ${f}\n    ${w}`) })
  const origin = await kit.listen()
  console.log(`kit served at ${origin}`)
  console.log(`fixtures import through /kit/test/browser/fixtures/<name>.mesa`)
}
