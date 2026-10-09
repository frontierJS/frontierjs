/**
 * terminal/shell.js — a web surface's routes, run in a terminal (`FJS-D809`,
 * `FJS-D810`): the same `src/routes`, compiled with `target: 'terminal'`,
 * listed and mounted one at a time. `fli dev:tui` is the command; this is the
 * whole of it, so the command only parses flags.
 *
 *   runTerminalShell({ root })                 interactive, on this TTY
 *   runTerminalShell({ root, list: true })     each route and whether it lowers, printed
 *   runTerminalShell({ root, frame: '/x/' })   one route's frame, printed, no TTY
 *
 * The boot is `virtual:sierra`'s, minus what has no terminal meaning: the
 * Junction client from `config.junction`, and the schemas from the app's
 * `.lite` through the generator the Vite build uses. Not here yet, each named
 * where a route would need it: the router (`page` keeps its defaults, so a
 * route reading `page.params` gets none, and a route that takes a param is
 * listed as refused), layouts (a route mounts without its `_module.mesa`),
 * and `autoImport` (a configured one is refused at boot rather than left to
 * fail as an undefined name).
 *
 * Traps:
 * - The engine is reached through `@frontierjs/mesa/runtime/terminal.js` and
 *   nothing else: an import of `@opentui/core` from this package installs a
 *   second copy of it.
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
import { installTerminalLoader } from './loader.js'

const SHELL = new URL('./Shell.mesa', import.meta.url).pathname
const NO_LOWERING = / has no terminal lowering$/

/** Every node of the route tree that renders a page, in table order. */
function pages(node, out = []) {
  if (node.file && !node.meta?.redirect) out.push(node)
  for (const c of node.children ?? []) pages(c, out)
  return out
}

async function routeList(root, config, loader) {
  const tree = await scan(config.routesDir ?? 'src/routes', {
    cwd: root, trailingSlash: config.trailingSlash ?? 'always', warn: () => {},
  })
  const out = []
  for (const node of pages(tree)) {
    const file = resolve(root, node.file)
    let refused = null
    if (node.params?.length) refused = `takes ${node.params.map((p) => ':' + p).join(', ')}, and the shell has no router yet`
    else {
      const r = await loader.lowers(file)
      if (r) refused = r.error.replace(NO_LOWERING, '')
    }
    out.push({ path: node.path, file, refused })
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
  return { config, loader }
}

/**
 * @param {object} o
 * @param {string}  o.root       the web surface — the directory holding `src/` and `config/`
 * @param {string}  [o.apiUrl]   the API origin; `config.junction.url` otherwise
 * @param {boolean} [o.list]     print each route and its first blocker, and return
 * @param {string}  [o.frame]    print the frame of the route at this path, and return
 * @param {number}  [o.settle]   ms a `frame` waits for the route's first loads
 * @param {(line: string) => void} [o.print]
 * @returns {Promise<number>}    an exit code
 */
export async function runTerminalShell({ root, apiUrl, list = false, frame = null, settle = 1500, print = console.log }) {
  const { config, loader } = await boot(root, apiUrl)
  const routes = await routeList(root, config, loader)
  const open = routes.filter((r) => !r.refused)

  if (list) {
    const width = Math.max(...routes.map((r) => r.path.length))
    for (const r of routes) print(`${r.refused ? '✗' : '✓'} ${r.path.padEnd(width)}  ${r.refused ?? ''}`.trimEnd())
    print(`\n${open.length} of ${routes.length} routes lower for the terminal`)
    return 0
  }

  const tui = await import('@frontierjs/mesa/runtime/terminal.js')
  const Shell = (await import(SHELL)).default
  const app = config.siteName ?? root.split('/').filter(Boolean).at(-2) ?? 'app'

  if (frame) {
    const r = routes.find((x) => x.path === frame)
    if (!r) { print(`no route at ${frame}`); return 1 }
    if (r.refused) { print(`${frame} does not lower: ${r.refused}`); return 1 }
    const { renderer, renderOnce, captureCharFrame } = await tui.createHeadlessRenderer({ width: 100, height: 30 })
    const Route = (await import(r.file)).default
    const handle = tui.mount(Route, { renderer })
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
  let screen = []
  const clear = () => { for (const h of screen.reverse()) h.dispose(); screen = [] }

  const showList = () => {
    clear()
    screen.push(tui.mount(Shell, { renderer, props: { app, routes: open, refused: routes.length - open.length, onopen: showRoute } }))
    tui.focusNext()
  }

  // A route that throws while it mounts goes back to the list with the error
  // as its heading, rather than leaving a half-built screen.
  const showRoute = async (r) => {
    clear()
    screen.push(tui.mount(Shell, { renderer, props: { app: `${r.path} · Esc goes back` } }))
    try {
      const Route = (await import(r.file)).default
      screen.push(tui.mount(Route, { renderer }))
      tui.focusNext()
    } catch (e) {
      clear()
      screen.push(tui.mount(Shell, { renderer, props: { app: `${r.path} failed: ${e.message}`, routes: open, onopen: showRoute } }))
    }
  }

  renderer.keyInput.on('keypress', (k) => { if (k.name === 'escape') showList() })
  showList()
  return done
}
