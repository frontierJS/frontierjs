// ─── console.js ───────────────────────────────────────────────────────────────
//
// The console's screens, compiled on request for either target
// (`IDEAS/one-console.md`). A screen is a `.mesa` file under `console/`; Mesa's
// runtime, the kit and toolbelt come from the copies THIS `fli` holds
// (`ownPackageRoot`). Nothing is built, so there is no bundle to go stale.
//
// The browser resolves them through an import map:
//   GET /console/             the page — stylesheet, import map, the mount
//   GET /console/<file>       a file under `console/`; a `.mesa` is compiled
//   GET /@fjs/<pkg>/<file>    a file of one of SERVED, by the same rule
//
// The terminal (`runTerminalConsole`) imports them under Bun through a loader
// that compiles with `target: 'terminal'` and rewrites the same map's names to
// files, and mounts the screen in this process with `api` naming the server.
//
// Traps:
// - The compiler and the runtime come from ONE mesa root. Compiled output
//   imports `@frontierjs/mesa/runtime`, and the map points that at the root the
//   compiler was read from; two copies compile against one runtime and run on
//   another.
// - The compiler COLLECTS errors and still returns code with the statement left
//   out, so a file with errors is served as a module that throws naming it.
// - The browser does no extension guessing, so every bare subpath is spelled
//   out, read from each package's own `exports`. A star export whose target
//   adds an extension (`./stores/*` → `./stores/*.js`) cannot be a prefix
//   entry, and its directory is listed instead.
// - Bun hands a plugin-loaded module's package imports to its own resolver,
//   never to the plugin, so the terminal's are rewritten in the compiled text.
//   Left to Bun, `@frontierjs/mesa/runtime/terminal` can be another copy, and
//   the screen mounts on a renderer its runtime has never seen.
// - Bun caches a loaded module by its CONTENTS, and a screen compiles to the
//   same text in every checkout, so the output carries its own path
//   (`FJS-2907`, as sierra's terminal loader does).

import { readFile } from 'fs/promises'
import { readFileSync, readdirSync } from 'fs'
import { join, resolve, extname, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { ownPackageRoot } from './assets.js'

const __dir = dirname(fileURLToPath(import.meta.url))

export const SCREENS = resolve(__dir, '../console')
const SERVED = ['mesa', 'ui', 'toolbelt']

// Only these are served from a package root; anything else there is a 404.
const TYPES = {
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.mesa': 'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

let _roots

function roots() {
  if (_roots) return _roots
  const found = {}
  for (const pkg of SERVED) {
    found[pkg] = ownPackageRoot(pkg)
    if (!found[pkg]) throw new Error(`@frontierjs/${pkg} is not resolvable from this fli, so the console cannot be served`)
  }
  return (_roots = found)
}

const manifestOf = (root) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const exportFile = (target) => typeof target === 'string' ? target : target?.import ?? target?.default

const served = (pkg, file) => `/@fjs/${pkg}/${file}`

/** Every subpath each package exports, as the URL this server answers it at,
 *  or as whatever `at(pkg, file)` names it — the terminal names the file. */
export function importMap(rootsByPkg, at = served) {
  const imports = {}
  for (const [pkg, root] of Object.entries(rootsByPkg)) {
    for (const [sub, target] of Object.entries(manifestOf(root).exports ?? {})) {
      const file = exportFile(target)
      if (typeof file !== 'string' || !sub.startsWith('.')) continue
      const name = `@frontierjs/${pkg}${sub.slice(1)}`
      const url  = at(pkg, file.replace(/^\.\//, ''))
      if (!sub.includes('*')) { imports[name] = url; continue }

      const [nameHead, nameTail] = name.split('*')
      const [urlHead, urlTail]   = url.split('*')
      if (nameTail === urlTail) { imports[nameHead] = urlHead; continue }

      let listed = []
      try { listed = readdirSync(join(root, file.replace(/^\.\//, '').split('*')[0])) } catch {}
      for (const f of listed) {
        if (f.endsWith(urlTail)) imports[nameHead + f.slice(0, f.length - urlTail.length) + nameTail] = urlHead + f
      }
    }
  }
  return { imports }
}

export function consolePage(map) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fli — console</title>
<script>
  try {
    var t = localStorage.getItem('fli-theme')
    if (t) document.documentElement.className = 'theme-' + t
  } catch (e) {}
</script>
<link rel="stylesheet" href="/fli.css">
<script type="importmap">${JSON.stringify(map)}</script>
</head>
<body class="app">
<main id="console" class="stack"></main>
<script type="module">
  import { mount } from '@frontierjs/mesa/runtime'
  import Console from '/console/Console.mesa'
  const root  = document.getElementById('console')
  const label = root.appendChild(document.createComment('console'))
  mount(label, Console, { root })
</script>
</body>
</html>
`
}

let _compile

const mesaModule = (sub) => {
  const mesa = roots().mesa
  return import(pathToFileURL(join(mesa, exportFile(manifestOf(mesa).exports[sub]))).href)
}

async function compileMesa(file, target) {
  _compile ??= mesaModule('./compiler').then(m => m.compileSource)
  const compileSource = await _compile
  const ctx = await compileSource(await readFile(file, 'utf8'), { filename: file, target, warning: () => {} })
  const errors = ctx.analysis?.errors ?? []
  if (errors.length) throw new Error(`${errors.length} compile error(s):\n  • ${errors.join('\n  • ')}`)
  return ctx.result
}

/** A path under `base`, or null when it escapes it. */
function under(base, rel) {
  const p = resolve(join(base, decodeURIComponent(rel)))
  return p.startsWith(base + '/') ? p : null
}

const send = (res, code, body, type = 'text/plain; charset=utf-8') => {
  // A checkout's screens change under a running server, and a cached module
  // serves the previous edit back.
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(body)
}

/** Whether `path` is the console's to answer. */
export const isConsolePath = (path) =>
  path === '/console' || path.startsWith('/console/') || path.startsWith('/@fjs/')

export async function handleConsole(res, path) {
  if (path === '/console') {
    res.writeHead(301, { Location: '/console/' })
    return res.end()
  }

  try {
    if (path === '/console/') return send(res, 200, consolePage(importMap(roots())), 'text/html; charset=utf-8')

    let file = null
    if (path.startsWith('/console/')) file = under(SCREENS, path.slice('/console/'.length))
    else {
      const [, pkg, ...rest] = path.slice('/@fjs/'.length).match(/^([^/]+)\/(.*)$/) ?? []
      if (SERVED.includes(pkg)) file = under(roots()[pkg], rest.join('/'))
    }
    if (!file || !TYPES[extname(file)]) return send(res, 404, `no route for ${path}`)

    if (extname(file) === '.mesa') {
      try {
        return send(res, 200, await compileMesa(file), TYPES['.mesa'])
      } catch (err) {
        const msg = String(err.message ?? err).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
        return send(res, 200, `throw new Error(\`[mesa] ${path}\\n${msg}\`)`, TYPES['.mesa'])
      }
    }
    return send(res, 200, await readFile(file), TYPES[extname(file)])
  } catch (err) {
    send(res, err.code === 'ENOENT' ? 404 : 500, String(err.message ?? err))
  }
}

// ─── terminal ────────────────────────────────────────────────────────────────

/** `spec` as `map` names it: an exact entry, else the longest prefix entry. */
function mapped(map, spec) {
  if (map.imports[spec]) return map.imports[spec]
  const prefix = Object.keys(map.imports)
    .filter(k => k.endsWith('/') && spec.startsWith(k))
    .sort((a, b) => b.length - a.length)[0]
  return prefix ? map.imports[prefix] + spec.slice(prefix.length) : null
}

const PACKAGE_IMPORT = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])(@frontierjs\/[^'"]+)\2/g

let _loader

/** Register the Bun loader once: a `.mesa` import, a screen's or the kit's, is
 *  compiled for the terminal and its `@frontierjs/*` imports pointed at files. */
function installTerminalLoader() {
  if (_loader) return
  const r = roots()
  const map = importMap(r, (pkg, file) => join(r[pkg], file))
  Bun.plugin({
    name: 'fli:console',
    setup(build) {
      build.onLoad({ filter: /\.mesa$/ }, async ({ path }) => {
        const code = (await compileMesa(path, 'terminal'))
          .replace(PACKAGE_IMPORT, (all, head, q, spec) => {
            const file = mapped(map, spec)
            return file ? `${head}${JSON.stringify(file)}` : all
          })
        return { contents: `${code}\n// ${path}\n`, loader: 'js' }
      })
    },
  })
  _loader = true
}

/**
 * `Console.mesa` in this terminal, reading the server at `api`. Answers when the
 * renderer is destroyed — Ctrl+C — so the caller stops the server it started.
 * A screen that does not compile or lower throws before the screen is taken.
 * @param {{ api: string, openUrl?: (url: string) => void }} options
 */
export async function runTerminalConsole({ api, openUrl = () => {} }) {
  installTerminalLoader()
  // The engine is an optional peer of mesa, and this fli does not declare it.
  const tui = await mesaModule('./runtime/terminal').catch((e) => {
    throw /@opentui\/core/.test(e.message)
      ? new Error('the terminal console needs @opentui/core beside this fli\'s mesa; --open serves it to the browser')
      : e
  })
  const Console = (await import(join(SCREENS, 'Console.mesa'))).default
  const Legend  = (await import(join(SCREENS, 'Legend.mesa'))).default
  return new Promise((done, fail) => {
    tui.createRenderer({ exitOnCtrlC: true, onDestroy: done }).then((renderer) => {
      // A row's `open` is a link; the terminal has no page to follow it in.
      tui.followLinks(renderer, (href) => openUrl(new URL(href, api).href))
      // The console places its own focus; the legend is a footer line, so a
      // long pane never scrolls it away.
      const legendAt = (read) => tui.mount(Legend, { renderer, parent: tui.footerOf(renderer), props: { read } })
      tui.mount(Console, { renderer, props: { api, legendAt } })
    }, fail)
  })
}
