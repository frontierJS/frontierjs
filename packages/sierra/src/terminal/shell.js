/**
 * terminal/shell.js — a web surface's routes, run in a terminal (`FJS-D809`,
 * `FJS-D810`): the same `src/routes`, compiled with `target: 'terminal'`,
 * listed and opened one at a time. `fli dev:tui` is the command; this is the
 * whole of it, so the command only parses flags.
 *
 *   runTerminalShell({ root })                   interactive, on this TTY
 *   runTerminalShell({ root, list: true })       each route and whether it lowers, printed
 *   runTerminalShell({ root, frame: '/x/7/' })   one path's frame, printed, no TTY
 *   runTerminalShell({ root, side: file })       interactive, with `file` in a pane beside it
 *   runTerminalShell({ root, open: '/x/7/' })    interactive, opened at that path
 *   runTerminalShell({ root, reload })           interactive, and the router's `reload(url)` hands
 *                                                the url to `reload` and ends the shell
 *
 * The boot is `virtual:sierra`'s, minus what has no terminal meaning: the
 * Junction client from `config.junction`, the schemas from the app's `.lite`
 * through the generator the Vite build uses, and the theme from `config.theme`.
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
 * A side pane is a `.mesa` component in a split at the right, mounted the
 * first time Ctrl+\ shows it and kept while hidden. Ctrl+O moves focus
 * between the panes, and Alt+= and Alt+- widen and narrow the side by five
 * columns. They are taken before any mount sees them, since a field binds
 * most Ctrl letters. A page's own command shows and hides it
 * through Mesa's `sideToggle()`, as Ctrl+\ does, and `toggle(true)` only shows it. In the side the mode line says so, and
 * h/j/k/l and Esc are the side's own: Esc going back is the page's.
 *
 * A process imports a module once, so an edit is seen only by a new one:
 * `reload` is how the caller starts it, `tools/tui.js` by running itself
 * again with `--open` at the url.
 *
 * Not here yet, each named where a route would need it: layouts (a route
 * mounts without its `_module.mesa`) and `autoImport` (a configured one is
 * refused at boot rather than left to fail as an undefined name).
 *
 * Traps:
 * - The engine is reached through `@frontierjs/mesa/runtime/terminal` and
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
  initRouter, createMemoryHistory, afterNavigate, beforeNavigate, back, followLink, goto, page,
} from '../router/index.js'
import { matchRoute, normalizePath } from '../router/match.js'
import { remountKey } from '../router/internals.js'
import { createSignal, flushSync } from '@frontierjs/mesa/runtime'
import { installTerminalLoader } from './loader.js'

const SHELL = new URL('./Shell.mesa', import.meta.url).pathname
// Ctrl+\ is a split in VS Code, and o is tmux's next pane.
const TOGGLE_SIDE = '\\'
const OTHER_PANE  = 'o'
// A page narrower than PAGE_COLUMNS clips a scene, so where the side would
// leave it fewer, an open side shows one pane at a time.
const SIDE_SHARE   = 0.3
const PAGE_COLUMNS = 120
// Alt+= and Alt+- move the split's edge, by RESIZE_STEP columns, as far as
// leaves each pane EDGE_COLUMNS. opentui's fields bind Alt+arrows to words.
const WIDER  = { '=': 1, '+': 1, '-': -1, '_': -1 }
const RESIZE_STEP  = 5
const EDGE_COLUMNS = 20
const MODE  = new URL('./Mode.mesa', import.meta.url).pathname
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

  // Before any route imports: a route reads `themes()` and `theme.value` at the
  // top of its script, once.
  if (config.theme) (await import('@frontierjs/sierra/theme')).initTheme(config.theme)

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
 * The side pane's two keys, on `renderer` ahead of every mount. The pane is
 * hidden until the first Ctrl+\, which mounts `file` there. Where the
 * page would keep fewer than `PAGE_COLUMNS`, an open side is ZOOMED, as tmux's prefix z: the pane holding
 * focus is drawn full width and Ctrl+O swaps. `setZoom` hears whether the
 * page is drawn over a side that is open.
 */
function paneKeys(tui, renderer, file, setMode, setZoom, say) {
  const box = tui.sideOf(renderer, { width: `${SIDE_SHARE * 100}%` })
  const page = tui.pageOf(renderer)
  box.visible = false
  let open = false
  let front = 'side'    // the pane drawn while zoomed
  let columns = null    // the side's width once Alt+= or Alt+- set it, else its share
  // Zoom stays the terminal's call, made at the share: a side widened past
  // PAGE_COLUMNS is the person's choice to clip the page.
  const fit = (n) => Math.max(EDGE_COLUMNS, Math.min(n, renderer.width - EDGE_COLUMNS))
  const lay = () => {
    const zoom = open && renderer.width * (1 - SIDE_SHARE) < PAGE_COLUMNS
    if (columns !== null) box.width = fit(columns)
    box.visible = open && (!zoom || front === 'side')
    page.visible = !zoom || front === 'page'
    // The side keeps its share beside the page and takes the row alone.
    box.flexGrow = zoom ? 1 : 0
    setZoom(zoom && front === 'page')
  }
  // focusables() skips a hidden pane, so the pane is drawn before focus moves.
  const show = (pane) => { front = pane; lay(); flushSync() }
  // Whatever moves focus while zoomed — a route's mount, a click — brings its
  // pane forward, or keys would go to a pane nobody can see.
  renderer.on('focused_renderable', (node) => {
    const pane = open && node && tui.paneOf(renderer, node)
    if (pane && pane !== front) { front = pane; lay() }
  })
  renderer.on('resize', lay)
  // biome-ignore lint/correctness/noUnusedVariables: the ??= below reads it, so the side mounts once
  let mounted = null
  // Focus arriving sets the mode, through Shell.mesa's focusin; a pane with
  // nothing to focus leaves none, so a hidden side keeps no keys.
  const into = (pane) => {
    if (tui.focusPane(renderer, pane)) return
    renderer.currentFocusedRenderable?.blur()
    setMode({ mode: 'normal', field: false })
  }
  // `force` as DOM's `classList.toggle`: true only shows, false only hides.
  const toggle = async (force) => {
    // A side zoomed behind the page is open and not drawn: this brings it forward.
    if (box.visible && force === true) return into('side')
    if (box.visible) { open = false; show('page'); return into('page') }
    if (force === false) return
    try {
      mounted ??= tui.mount((await import(file)).default, { renderer, parent: box })
    } catch (e) {
      say(`${file} failed: ${e.message}`)
      return
    }
    open = true
    show('side')
    into('side')
  }
  tui.setSideToggle(renderer, toggle)
  // A legacy terminal sends Alt+= as ESC =, which opentui names '' and leaves
  // unmarked; the kitty protocol names it '=' with meta.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the prefix a legacy terminal's Alt key sends
  const altOf = (k) => k.ctrl ? null : k.meta ? k.name : /^\x1b(.)$/.exec(k.sequence ?? '')?.[1]
  renderer.keyInput.on('keypress', (k) => {
    const wider = WIDER[altOf(k)]
    // Zoomed, one pane takes the row and there is no edge to move.
    if (wider && box.visible && page.visible) {
      k.preventDefault()
      columns = fit((columns ?? box.width) + wider * RESIZE_STEP)
      lay()
      return
    }
    if (!k.ctrl || k.meta || k.option) return
    if (k.name === TOGGLE_SIDE) { k.preventDefault(); toggle() }
    else if (k.name === OTHER_PANE && open) {
      k.preventDefault()
      const to = tui.paneOf(renderer) === 'side' ? 'page' : 'side'
      show(to)
      into(to)
    }
  })
}

/**
 * @param {object} o
 * @param {string}  o.root       the web surface — the directory holding `src/` and `config/`
 * @param {string}  [o.apiUrl]   the API origin; `config.junction.url` otherwise
 * @param {boolean} [o.list]     print each route and its first blocker, and return
 * @param {string}  [o.frame]    print the frame at this path, and return
 * @param {number}  [o.settle]   ms a `frame` waits for the route's first loads
 * @param {string}  [o.side]     a `.mesa` file for the side pane
 * @param {string}  [o.open]     the path to open, rather than the list
 * @param {(url: string) => void} [o.reload]  hands on the url `reload()` was asked for
 * @param {(line: string) => void} [o.print]
 * @returns {Promise<number>}    an exit code
 */
export async function runTerminalShell({ root, apiUrl, list = false, frame = null, settle = 1500, side = null, open: at = null, reload = null, print = console.log }) {
  const { config, loader, tree } = await boot(root, apiUrl)
  const routes = await routeList(root, tree, loader)
  const open = routes.filter((r) => !r.refused)
  const trailingSlash = config.trailingSlash ?? 'always'
  // `terminal: { jump: false }` leaves Ctrl+P to the app: a route that opens
  // its own finder on it would otherwise sit under the shell's.
  const jumps = config.terminal?.jump !== false

  if (list) {
    const width = Math.max(...routes.map((r) => r.path.length))
    for (const r of routes) print(`${r.refused ? '✗' : '✓'} ${r.path.padEnd(width)}  ${r.refused ?? ''}`.trimEnd())
    print(`\n${open.length} of ${routes.length} routes lower for the terminal`)
    return 0
  }

  const tui = await import('@frontierjs/mesa/runtime/terminal')
  const Shell = (await import(SHELL)).default
  const Mode  = (await import(MODE)).default
  const app = config.siteName ?? root.split('/').filter(Boolean).at(-2) ?? 'app'
  const { components, loaders } = routeTable(root, routes)
  const byId = new Map(routes.map((r) => [r.node.id, r]))

  // A route that does not lower is never imported: the guard refuses the
  // navigation with the reason, which the screen shows where it would have been.
  let refusedAt = null
  let restart = null
  beforeNavigate(({ to }) => {
    const r = byId.get(to.node.id)
    if (!r?.refused) return true
    refusedAt?.(to.pathname, r.refused)
    return false
  })

  /** Hand the router a fresh History at `path`, and answer it once the boot
   *  navigation has settled — or null when it did not land, since a route
   *  whose import throws is reported by the router and lands nowhere. */
  const start = async (path) => {
    const history = createMemoryHistory(path)
    let landed = false
    const off = afterNavigate(() => { landed = true })
    try { await initRouter(tree, components, loaders, { trailingSlash, history, ...(restart && { reload: restart }) }) } finally { off() }
    return landed ? history : null
  }

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
    if (!await start(frame)) { print(`${frame} did not open`); renderer.destroy(); return 1 }
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
  // `reload()` is called from inside a handler, and the flush that follows it
  // still writes to the screen it was called from; a renderer destroyed under
  // that flush frees the buffers it writes into. The roots go first, after it.
  const roots = []
  if (reload) restart = (url) => {
    reload(url)
    setTimeout(() => {
      screen?.dispose()
      for (const r of roots) r.dispose()
      renderer.destroy()
    })
  }

  // In NORMAL, h j k l are the arrows, so a route that walks or scrolls on
  // them takes vim's keys without knowing the mode. The key is renamed before
  // the runtime makes a keydown of it, which is why this listener goes on
  // before the first mount takes the renderer's keys; added after, a route
  // would read a letter. A j or k the page leaves alone moves focus, below.
  const [mode, setPageMode] = createSignal({ mode: 'normal', field: false })
  const setMode = (m) => setPageMode(tui.paneOf(renderer) === 'side' ? { mode: 'side', field: m.field } : m)
  const VIM = { h: ['left', '\x1b[D'], j: ['down', '\x1b[B'], k: ['up', '\x1b[A'], l: ['right', '\x1b[C'] }
  const FOCUS = { j: 1, k: -1 }
  let focusStep = 0
  renderer.keyInput.on('keypress', (k) => {
    focusStep = 0
    // A route whose controls paint after its mount (a list once its load
    // lands) had nothing to focus when it opened. The first key that is not
    // a way out takes the first control, so Enter presses it without a Tab.
    const adopted = shown && !renderer.currentFocusedRenderable && !k.ctrl && !k.meta && !k.option
      && k.name !== 'tab' && k.name !== 'escape' && tui.focusNext()
    const arrow = VIM[k.name]
    if (!arrow || mode().mode !== 'normal' || k.ctrl || k.meta || k.option || k.shift) return
    focusStep = adopted ? 0 : FOCUS[k.name] ?? 0
    ;[k.name, k.sequence] = arrow
  })
  const [zoom, setZoom] = createSignal(false)
  if (side) paneKeys(tui, renderer, side, setMode, setZoom, (note) => set({ note }))

  const listed = {
    routes:   open.filter((r) => !r.params.length),
    patterns: open.filter((r) => r.params.length).map((r) => r.path),
    refused:  routes.length - open.length,
  }
  const [state, write] = createSignal({ app, note: '', ...listed })
  const set = (fields) => write({ ...state(), ...fields })
  const where = () => `${page.pathname}${page.search} · Esc goes back${jumps ? ' · Ctrl+P jumps' : ''}`

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
      // Nothing may take focus yet, and the line must not keep the last
      // route's INSERT; a focus that does land sets it from the control.
      setMode({ mode: 'normal', field: false })
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
    if (history) showRoute()
    else set({ note: `${path} did not open` })
  }

  // A jump from a route goes through the History it is on, so Esc comes back
  // to where it was made; from the list it opens as the list does.
  const jump = (path) => {
    if (!history) return openPath(path)
    const refused = why(path)
    if (refused) set({ note: refused })
    else goto(path)
  }

  roots.push(tui.mount(Mode, { renderer, parent: tui.footerOf(renderer), props: { mode, zoom } }))
  roots.push(tui.mount(Shell, { renderer, props: {
    state,
    paths:  jumps ? listed.routes.map((r) => r.path) : [],
    onopen: openPath,
    onjump: jump,
    onmove: (step) => step > 0 ? tui.focusNext() : tui.focusPrev(),
    onmode: setMode,
  } }))
  tui.followLinks(renderer, (href) => {
    if (!followLink(href) && shown) set({ note: `${href} is not a route here` })
  })
  // A route that walks on the arrows prevents the one it took; otherwise a j
  // stepping the figure would also move focus off the line it types in.
  renderer.keyInput.on('keypress', (k) => {
    if (!focusStep || k.defaultPrevented) return
    k.preventDefault()
    focusStep > 0 ? tui.focusNext() : tui.focusPrev()
  })
  // An Escape the page prevented was the page's: a confirm panel closing
  // must not also leave the route.
  renderer.keyInput.on('keypress', (k) => {
    if (k.name !== 'escape' || !shown || k.defaultPrevented || tui.paneOf(renderer) === 'side') return
    if ((history?.state?.index ?? 0) > 0) back()
    else showList()
  })
  showList()
  if (at) await openPath(at)
  return done
}
