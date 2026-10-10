/**
 * terminal/shell.js — a web surface's routes, run in a terminal (`FJS-D809`,
 * `FJS-D810`): the same `src/routes`, compiled with `target: 'terminal'`,
 * listed and opened one at a time. `fli dev:tui` is the command; this is the
 * whole of it, so the command only parses flags.
 *
 *   runTerminalShell({ root })                   interactive, on this TTY
 *   runTerminalShell({ root, list: true })       each route and whether it lowers, printed
 *   runTerminalShell({ root, frame: '/x/7/' })   one path's frame, printed, no TTY
 *
 * The boot is `virtual:sierra`'s, minus what has no terminal meaning: the
 * Junction client from `config.junction`, and the schemas from the app's
 * `.lite` through the generator the Vite build uses.
 *
 * Navigation is Sierra's own router, handed a memory History in place of the
 * address bar: `page`, a route's params, query and `load()`, `goto`, `back`
 * and guards are the browser's, and a link a person activates is followed by
 * `followLink`, the half of the router's click delegation that is not about a
 * document. A route is mounted when the router lands on it and remounted when
 * its own params change, as `ChainRenderer` keys it. Opening a route from the
 * list starts a fresh History, so Esc walks back through what was opened from
 * there and then returns to the list.
 *
 * Not here yet, each named where a route would need it: layouts (a route
 * mounts without its `_module.mesa`) and `autoImport` (a configured one is
 * refused at boot rather than left to fail as an undefined name).
 *
 * Traps:
 * - The engine is reached through `@frontierjs/mesa/runtime/terminal.js` and
 *   nothing else: an import of `@opentui/core` from this package installs a
 *   second copy of it.
 * - `@frontierjs/sierra/router` is `router/index.js` here, never `entry.js`:
 *   the loader maps it, because `entry.js` re-exports the two DOM outlets and
 *   a route importing `page` would load `ChainRenderer.mesa`, which does not
 *   lower (`FJS-2271`). This file imports the same module, so there is one
 *   `page`.
 * - `config.junction.debug` is turned off: it logs every call to the console,
 *   which a terminal renderer paints over.
 * - A route's module runs its resources at IMPORT, so a route is imported
 *   when it is opened, never to decide whether it lowers — `lowers()` compiles
 *   and does not run.
 */
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { scan } from '../scanner/index.js'
import { resolveSchemaPath, generateSchemas } from '../build/schema-plugin.js'
import {
  initRouter, createMemoryHistory, afterNavigate, beforeNavigate, back, followLink, page,
} from '../router/index.js'
import { matchRoute, normalizePath } from '../router/match.js'
import { remountKey } from '../router/internals.js'
import { createSignal, flushSync } from '@frontierjs/mesa/runtime'
import { installTerminalLoader } from './loader.js'

const SHELL = new URL('./Shell.mesa', import.meta.url).pathname
const NO_LOWERING = / has no terminal lowering$/

/** Every node of the route tree that renders a page, in table order. */
function pages(node, out = []) {
  if (node.file && !node.meta?.redirect) out.push(node)
  for (const c of node.children ?? []) pages(c, out)
  return out
}

async function routeList(root, tree, loader) {
  const out = []
  for (const node of pages(tree)) {
    const file = resolve(root, node.file)
    const r = await loader.lowers(file)
    out.push({ node, path: node.path, file, params: node.params ?? [], refused: r ? r.error.replace(NO_LOWERING, '') : null })
  }
  return out
}

async function boot(root, apiUrl) {
  const config = (await import(pathToFileURL(join(root, 'config/sierra.config.js')).href)).default
  if (config.autoImport) {
    throw new Error('[Sierra] the terminal shell does not inject autoImport yet; this app configures it, so its routes would render undefined names')
  }
  const loader = await installTerminalLoader({ root })

  const resource = await import('@frontierjs/sierra/resource')
  if (config.junction) resource.initJunction({ ...config.junction, url: apiUrl ?? config.junction.url, debug: false })
  const schemaPath = resolveSchemaPath(config, root)
  if (schemaPath) {
    const g = await generateSchemas(schemaPath, (m) => console.warn(`[Sierra] ${m}`), root)
    if (g?.defs) resource.registerSchemas(g.defs, g.models ?? null, g.updatePatch ?? null, g.readPatch ?? null)
  }
  const tree = await scan(config.routesDir ?? 'src/routes', {
    cwd: root, trailingSlash: config.trailingSlash ?? 'always', warn: () => {},
  })
  return { config, loader, tree }
}

/**
 * The route table the router is handed, as `config/routes.js` builds it for
 * the browser: a component factory per route, and a loader per route whose
 * `.meta.js` runs in the client. A prerendered route's companion runs at
 * build time and is not here, as it is not in the client table.
 */
function routeTable(root, routes) {
  const components = {}
  const loaders = {}
  for (const r of routes) {
    components[r.node.id] = () => import(r.file)
    if (r.node.companion && r.node.meta?.render !== 'static') {
      const companion = resolve(root, r.node.companion)
      loaders[r.node.id] = () => import(companion)
    }
  }
  return { components, loaders }
}

/** What remounts a route's screen: another route, or what remounts a page
 *  under `ChainRenderer` (`remountKey`). */
const screenKey = (node, params) =>
  `${node.id} ${remountKey({ meta: node.meta, ownParams: node.params }, params) ?? ''}`

/**
 * @param {object} o
 * @param {string}  o.root       the web surface — the directory holding `src/` and `config/`
 * @param {string}  [o.apiUrl]   the API origin; `config.junction.url` otherwise
 * @param {boolean} [o.list]     print each route and its first blocker, and return
 * @param {string}  [o.frame]    print the frame at this path, and return
 * @param {number}  [o.settle]   ms a `frame` waits for the route's first loads
 * @param {(line: string) => void} [o.print]
 * @returns {Promise<number>}    an exit code
 */
export async function runTerminalShell({ root, apiUrl, list = false, frame = null, settle = 1500, print = console.log }) {
  const { config, loader, tree } = await boot(root, apiUrl)
  const routes = await routeList(root, tree, loader)
  const open = routes.filter((r) => !r.refused)
  const trailingSlash = config.trailingSlash ?? 'always'

  if (list) {
    const width = Math.max(...routes.map((r) => r.path.length))
    for (const r of routes) print(`${r.refused ? '✗' : '✓'} ${r.path.padEnd(width)}  ${r.refused ?? ''}`.trimEnd())
    print(`\n${open.length} of ${routes.length} routes lower for the terminal`)
    return 0
  }

  const tui = await import('@frontierjs/mesa/runtime/terminal.js')
  const Shell = (await import(SHELL)).default
  const app = config.siteName ?? root.split('/').filter(Boolean).at(-2) ?? 'app'
  const { components, loaders } = routeTable(root, routes)
  const byId = new Map(routes.map((r) => [r.node.id, r]))

  // A route that does not lower is never imported: the guard refuses the
  // navigation with the reason, which the screen shows where it would have been.
  let refusedAt = null
  beforeNavigate(({ to }) => {
    const r = byId.get(to.node.id)
    if (!r?.refused) return true
    refusedAt?.(to.pathname, r.refused)
    return false
  })

  /** Hand the router a fresh History at `path`, and answer it once the
   *  router has landed there. */
  const start = (path) => new Promise((landed) => {
    const history = createMemoryHistory(path)
    const off = afterNavigate(() => { off(); landed(history) })
    initRouter(tree, components, loaders, { trailingSlash, history })
  })

  // What a typed path or `--frame` names, before the router is asked: a path
  // no route matches is refused there with no word said, so it is said here.
  const why = (path) => {
    const normalized = normalizePath(path.split(/[?#]/)[0], trailingSlash)
    const match = matchRoute(normalized, tree, { trailingSlash })
    if (!match) return `no route at ${path}`
    return byId.get(match.node.id)?.refused ? `${path} does not lower: ${byId.get(match.node.id).refused}` : null
  }

  if (frame) {
    const refused = why(frame)
    if (refused) { print(refused); return 1 }
    const { renderer, renderOnce, captureCharFrame } = await tui.createHeadlessRenderer({ width: 100, height: 30 })
    await start(frame)
    const handle = tui.mount((await import(byId.get(page.route.id).file)).default, { renderer, props: { data: page.data } })
    await new Promise((res) => setTimeout(res, settle))
    await renderOnce()
    print(captureCharFrame().replace(/\s+$/, ''))
    handle.dispose()
    renderer.destroy()
    return 0
  }

  // Ctrl+C destroys the renderer and restores the terminal, and the process
  // would then stay up: the Junction socket's reconnect timers hold the event
  // loop. The shell is finished when its renderer is.
  let finished
  const done = new Promise((res) => { finished = res })
  const renderer = await tui.createRenderer({ exitOnCtrlC: true, onDestroy: () => finished(0) })

  const listed = {
    routes:   open.filter((r) => !r.params.length),
    patterns: open.filter((r) => r.params.length).map((r) => r.path),
    refused:  routes.length - open.length,
  }
  const [state, write] = createSignal({ app, note: '', ...listed })
  const set = (fields) => write({ ...state(), ...fields })
  const where = () => `${page.pathname}${page.search} · Esc goes back`

  let screen = null
  let shown = null      // the screenKey of the route on screen, null on the list
  let history = null    // the History the open route was started with

  const showList = (note = '') => {
    screen?.dispose()
    screen = shown = history = null
    set({ app, note, ...listed })
    // The list is rebuilt on the flush, and focus needs its buttons there.
    flushSync()
    tui.focusNext()
  }

  // A route that throws while it mounts goes back to the list with the error
  // as its note, rather than leaving a half-built screen.
  const showRoute = async () => {
    const node = page.route
    const key = screenKey(node, page.params)
    set({ app: where(), note: '', routes: null })
    if (key === shown) return
    screen?.dispose()
    screen = null
    shown = key
    try {
      const Route = (await import(byId.get(node.id).file)).default
      screen = tui.mount(Route, { renderer, props: { data: page.data } })
      tui.focusNext()
    } catch (e) {
      showList(`${page.pathname} failed: ${e.message}`)
    }
  }

  refusedAt = (path, reason) => { if (shown) set({ note: `${path} does not lower: ${reason}` }) }
  afterNavigate(() => { if (history) showRoute() })

  const openPath = async (path) => {
    const refused = why(path)
    if (refused) { set({ note: refused }); return }
    // The first landing is the one `start` waits for, so it is shown here;
    // every later one through the hook above.
    history = await start(path)
    showRoute()
  }

  tui.mount(Shell, { renderer, props: { state, onopen: openPath } })
  tui.followLinks(renderer, (href) => {
    if (!followLink(href) && shown) set({ note: `${href} is not a route here` })
  })
  renderer.keyInput.on('keypress', (k) => {
    if (k.name !== 'escape' || !shown) return
    if ((history?.state?.index ?? 0) > 0) back()
    else showList()
  })
  showList()
  return done
}
