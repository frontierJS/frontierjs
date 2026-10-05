# Mesa

**Reactive UI language — compiler, runtime, and tooling**

Mesa is a JavaScript-native reactive UI language. Every piece of Mesa syntax
is valid JavaScript AST. The compiler does the heavy lifting; the runtime is
minimal.

For the language specification, see
[`docs/VISION.md`](./docs/VISION.md).

---

## Ecosystem

| Package                 | Where it lives                        | Purpose                                                                                                         |
| ----------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `@frontierjs/mesa`      | this package                          | Core compiler, runtime, REPL, render pipeline                                                                   |
| `@frontierjs/mesa/vite` | [`mesa-vite/`](./mesa-vite/)          | Vite plugin — transform, HMR, error overlay, scoped CSS, DevTools. A **subpath of this package**, not a package |
| `@frontierjs/ui`        | [`packages/ui`](../ui/)               | Component kit over `@frontierjs/css`                                                                            |
| `@frontierjs/sierra`    | [`packages/sierra`](../sierra/)       | Meta-framework built on Mesa — **in this monorepo**, not a separate repo                                        |
| `@frontierjs/email-kit` | [`packages/email-kit`](../email-kit/) | Email component kit — table-based, CSS-inlined, Outlook-safe.                                                   |

> **`mesa-vite/` and `bench/` are directories of this package, not packages, and
> a `package.json` of its own is what would change that** — a nested package is
> invisible to the workspace glob (`packages/*`): uninstalled, so nothing imports
> it and nothing can test it. `mesa-vite/` is a subpath
> (`@frontierjs/mesa/vite`), reached by relative path, and four suites cover it.

---

## Quick start

```bash
bun install         # acorn, astring, vitest -- and the optional peers, as devDependencies
bun run serve       # then open /packages/mesa/example/ — the live REPL
bun run test        # vitest, then Chrome — compiler, runtime, render, css
```

**`bun run test`, never `bun test`.** The runner is **vitest**; bun's own runner
picks up whatever it finds here and reports ~35 failures that are runner
artefacts rather than defects.

`serve` roots at the **monorepo root**, not this package, so the REPL can reach
two siblings: `@ui/…` imports resolve to `packages/ui` (the UI Library example
mounts the real components) and `packages/css/dist/frontier.css` is the design
system they are written in. Everything else in the REPL works from any root —
those two degrade to a console warning and unstyled components.

For a real project, install the Vite plugin in your app and write `.mesa`
or `.md` files alongside your other source. See [Vite plugin](#vite-plugin).

**The server half's packages are optional peers**, so a client-only app installs
none of them. An app that uses one adds its packages itself; without them, the
import fails with an error naming the feature and the install line:

| To use | Add to the app |
|---|---|
| `.md` pages | `unified remark-parse remark-gfm remark-rehype rehype-slug rehype-stringify` |
| `render`, `render-component`, `css-inliner` | `happy-dom` |

---

## Files

| File | Purpose |
|---|---|
| `src/compiler.js` | Mesa → JS compiler. `compile(src, opts)` → `ctx` |
| `src/compiler-md.js` | Markdown + frontmatter compiler. `compileMd(src, opts)` → `ctx` |
| `src/runtime.js` | Signals, effects, DOM helpers, event delegation, mount, blocks |
| `src/render.js` | `renderToHTML(component, props, opts)` / `renderAll` / `wrapPage` — happy-dom static rendering. See `docs/STATIC_RENDERING.md` |
| `src/render-component.js` | Source-in pipeline: `renderComponent` / `renderFile` for HTML, email, fragment, JS |
| `src/css-inliner.js` | CSS-to-`style=""` inliner with custom-property resolution |
| `src/optional-peer.js` | `missingPeer(name, feature)` — the error when an optional peer is not installed |
| `example/index.html` | Browser REPL — `bun run serve`, then open `/packages/mesa/example/`. Mounts previews via `mount()`; see `test/repl.test.js` |
| `example/examples.js` | All REPL examples — 66 across 22 groups |
| `example/README.md` | What the REPL is, how to run it, how to add an example |
| `test/` | Every suite, plus `spec-check.mjs`. See the table below |
| `mesa-vite/` | Vite plugin |
| `bench/` | `bun run bench` — gzip bytes, DOM mutations per operation and time for a keyed 1k-row table, against a hand-written floor. `bench/run.mjs` says what each number is and which are gated |

---

## Language basics

### Signals — `let`

```js
let count = 0             // reactive signal
const double = count * 2  // auto-derived memo
```

### Props

```js
export let   value = 0    // reactive prop — parent can update, two-way bind ok
export const label = ''   // immutable prop — read-only in component
export var   snap  = 0    // snapshot at mount — ignores future parent changes
```

### Non-reactive escape hatch — `var`

```js
var previous = count   // captures current value, does not subscribe
```

### Shared state — plain JS modules

```js
// store.js — no Mesa, no store API needed
export const user = { name: 'Alice' }
```

```js
// Component.mesa
import { user } from './store.js'
$: user.name    // tell compiler to watch this path
```

### Watch + handler — `$:`

```js
$: selectedId, async () => {
  const res = await fetch(`/api/${selectedId}`)
  data = await res.json()
}
```

### Async derived

```js
const cities = await getCities(selectedState)
// $async.cities.loading / .pending / .error generated automatically
```

### Slots — `<slot />`

```mesa
<!-- Card.mesa -->
<div class="card">
  <header><slot:header /></header>
  <main><slot /></main>
</div>

<!-- Parent -->
<Card>
  <h1 slot="header">Title</h1>
  <p>Body content</p>
</Card>
```

For the full spec — `var` semantics, `$:` patterns, context, `<mesa:*>`
elements, `bind:value|mask`, `$.inspect`, the render pipeline — see
[`docs/VISION.md`](./docs/VISION.md).

---

## Markdown in `.md` files

A `.md` file is compiled as markdown. The extension decides the language — a
`---` block at the top of a `.mesa` file is metadata, not a switch to markdown:

```md
---
title: My Post
date: 2025-01-15
---

<script>
  let likes = 0
</script>

# {title}

{#if likes > 0}
  Thanks for {likes} likes!
{/if}

<p><button on:click={() => likes++}>Like</button></p>
```

Mesa closes no element for you, so a bare inline element on its own line is
refused — markdown opens a `<p>` around it that nothing closes. Wrap it, as above.

Frontmatter keys become `export const` declarations automatically. Mesa
expressions, `{#if}`, `{#each}`, and Mesa components all work inline.

`compileMd` accepts user-supplied remark and rehype plugins:

```js
const ctx = await compileSource(src, {
  filename: 'Post.md',
  remarkPlugins: [remarkMath, [remarkGfmExtended, { tables: true }]],
  rehypePlugins: [rehypeKatex],
})
```

---

## Compiler API

```js
import { compile, compileSource, compileFile } from '@frontierjs/mesa'

// .mesa source — always routes to Mesa compiler
const ctx = await compile(source, { filename: 'Counter.mesa', css: false })

// Routes on the EXTENSION: .md → compileMd, anything else → compile.
// A `---` block at the top of a .mesa file is metadata (a route's title, its
// render mode) — it is stripped, exposed as ctx.frontmatter, and does not
// change which language the file is written in.
const ctx = await compileSource(source, { filename: 'Post.md' })

// Reads file + routes by extension
const ctx = await compileFile('./src/Counter.mesa')

ctx.result           // compiled JS string
ctx.analysis.errors  // []
ctx.analysis.warnings
ctx.css?.result      // scoped CSS — populated only when css: FALSE (see below)
ctx.css?.id          // the content-addressed scope class on every element
ctx.frontmatter      // parsed frontmatter object, for .md and .mesa alike
ctx.isStatic         // true if component has no JS at runtime
```

Useful options:

| Option | Effect |
|---|---|
| `dev: true` | Emit `$$runtime.__dev?.r(...)` registration calls — required for DevTools |
| `debug: false` | Strip `$.inspect` calls entirely |
| `css: true` (default) | Scope styles and emit a `$$runtime.addStyles(id, css)` call into `ctx.result` — the compiler injects them for you |
| `css: false` | Scope styles and hand them back on **`ctx.css.result`**, emitting nothing. **The caller must inject them.** Styles are silently absent if you don't — every element still carries the scope class, so the markup looks right and matches no rule |
| `filename` | Used in dev component labels and source maps |
| `remarkPlugins` | Array passed through to the markdown processor (`.md` only) |
| `rehypePlugins` | Same, for the HTML AST stage |

---

## Runtime API

```js
import { mount, mountStatic, flushSync } from '@frontierjs/mesa/runtime.js'
import App from './App.mesa'

// Standard mount — inserts after the label node, which needs a parent
const label = document.getElementById('app')
const app   = mount(label, App, {
  props: { value: 42 },
})

flushSync()      // flush pending reactive updates synchronously
app.find(sel)    // querySelector scoped to the mounted tree
app.destroy()    // unmount + cleanup delegation listeners + removed styles
```

### Owning a lifetime — `createRoot`

`mount()` and `destroy()` cover an app. When you need a span of work that ends —
rendering one page of a static build, swapping one preview for another —
`createRoot` owns everything created inside it and disposes it on demand.

```js
import { createRoot, flushSync } from '@frontierjs/mesa/runtime.js'

const html = createRoot((dispose) => {
  Component(anchor, props, null)
  flushSync()
  const out = container.innerHTML
  dispose()                  // every effect created above is gone
  return out
})
```

It gives **ownership without tracking**: the root subscribes to nothing, so it
can never re-run. `createEffect` looks like a substitute and is not — an effect
subscribes to what its body reads, so a component that reads and then writes a
store during setup re-triggers the effect that is running it. See VISION
**RULE 54**.

### Shadow DOM mount

`mount()` accepts a `root` option that scopes both event delegation and
style injection to a shadow root. Mesa uses `adoptedStyleSheets` for shadow
roots and per-root delegated event listeners — `on:click` and friends work
correctly inside shadow DOM with no extra wiring.

```js
const host   = document.getElementById('app')
const shadow = host.attachShadow({ mode: 'open' })
const target = document.createElement('div')
shadow.appendChild(target)

const app = mount(target, App, {
  props: {},
  root:  shadow,   // delegation + style root
})
```

`destroy()` removes both the delegation listeners and the adopted stylesheets
from the shadow root.

---

## Render pipeline — SSR, email, fragments, static

`render-component.js` is a source-in pipeline that handles compilation,
recursive imports, CSS extraction, and rendering in one call. Use it for
build-time templating, transactional emails, and server-rendered fragments.

```js
import { renderComponent, renderFile } from '@frontierjs/mesa/render-component'

// Full HTML document
const { html } = await renderFile('./pages/About.mesa', {
  data: { title: 'About' },
  target: 'html',
})

// Email — CSS inlined, MSO/VML namespaces, plain-text fallback
const { html, text, subject } = await renderFile('./emails/Welcome.mesa', {
  data: { firstName: 'Alice' },
  target: 'email',
})

// Fragment — inlined HTML chunk, no document wrapper
const { html } = await renderFile('./snippets/Hero.mesa', { target: 'fragment' })

// JS — compiled module map for client bundling (no HTML render)
const { modules, entry } = await renderFile('./App.mesa', { target: 'js' })
```

For low-level rendering of an **already-compiled** component factory — a bundler
plugin, or an SSG loop that imports its own pages — use `render.js`. The
pipeline above renders through it, so there is only one renderer.

```js
import { initRenderer, renderToHTML } from '@frontierjs/mesa/render'

initRenderer()                                   // 1. install DOM globals
const { default: Page } = await import('./Page.mesa.js')   // 2. then import
const html = await renderToHTML(Page, { title: 'Hello' })  // 3. then render
```

The order matters: compiled components call `htmlToFragment()` at module-load
time, so the DOM has to exist before the `import()`, not just before the render.

```js
// A whole static page, shell included
const page = await renderToHTML(Page, props, {
  full: true,
  title: 'My Page',
  css: '/assets/site.css',
  scripts: ['/assets/app.js'],
  islandLoader: '/assets/islands.js',
  meta: { description: 'a page' },
})

// Many pages — serial by construction; see STATIC_RENDERING.md on concurrency
const pages = await renderAll([
  { component: Page, props: { slug: 'a' } },
  { component: Page, props: { slug: 'b' } },
])
```

On the server, `$.onMount` and path watches are inert while effects and block
directives run and are then disposed; `{#await}` renders its `{:pending}`
branch; `{#virtual each}` renders its first window, since there is no viewport to
measure. Comment anchors are stripped unless
you pass `{ keepAnchors: true }`.

### Islands — `{ islands: true }`

`client:*` directives are stripped by default (RULE 26). Pass `islands: true` to
mark them in the output instead, so a client loader can find a prerendered
island and mount into it:

```js
const { html, islands } = await renderFile('./pages/Post.mesa', {
  target: 'fragment',
  islands: true,
})
```

```html
<article>
  <p>static</p>
  <!--mesa-island {"component":"Counter","directive":"load","props":{"start":3}}-->
  <button>3</button>
  <!--/mesa-island-->
</article>
```

The marker carries the props **as rendered**, not just the literal attributes a
compile-time pass can see — `start={2 + 3}` gives `{"start":5}`. The returned
`.islands` array is the complementary build-time view (`{ component, directive,
media?, props?, file }` per call site), which is what maps a component name onto
a module to import.

Markers are written in a **server render only** — `island()` calls the component
directly on a live client — and omitting the flag produces byte-identical output
to before. Mounting one needs no new protocol: remove the nodes between the
markers, then `mount(openComment, Comp, { props })`. Use `mount`, not a bare
`Comp(anchor, props, null)`, or the island renders correctly and responds to
nothing — a direct call registers no delegation root.

The loader itself, per-island bundling, and name→module resolution belong to the
meta-framework; `docs/STATIC_RENDERING.md` § Island markers has the rationale, including why the
markers are comments rather than a `<mesa-island>` element and two traps waiting
for whoever writes the loader.

**[`docs/STATIC_RENDERING.md`](./docs/STATIC_RENDERING.md)** has the full model — server
semantics, the page shell, concurrency, lifetimes, and what is and isn't wired
up to Sierra's `static` target yet.

---

## Vite plugin

```js
// vite.config.js
import mesaPlugin from '@frontierjs/mesa/vite'

export default {
  plugins: [mesaPlugin()]
}
```

The plugin handles `.mesa` and `.md` file transforms, scoped CSS via virtual
modules, error overlay, and HMR.

### HMR

Mesa HMR re-compiles on save and re-renders existing component instances in
place — without losing the parent's component tree. The plugin:

- Renames the default `Counter` function to `__mesaOrigFn`
- Injects `__mesa_register(id, mark, anchor, props, block, fn)` after each
  mount so the runtime knows which DOM region to re-render
- Inserts a stable `<!--mesa:hmr:Name-->` marker so re-renders find their
  anchor across module reloads
- Snapshots all instances on update, deletes them, then re-renders the
  module's new default export — no stale instance accumulation

Top-level signals are recreated on each HMR update — long-lived state
(persisted forms, in-flight requests) belongs in a plain JS module per
[`docs/VISION.md` §5](./docs/VISION.md), where it survives module
reloads naturally.

### Mesa DevTools

The plugin also serves a self-contained DevTools page at
`/__mesa/devtools` showing the component tree, signal inspector, and
real-time update log. It reads from `window.__MESA_DEV__` (the runtime's
`__dev` registry) over a `BroadcastChannel`.

For DevTools to populate, components must be compiled with `dev: true` —
the plugin enables this automatically in development. The server prints the
DevTools URL on startup:

```
  ➜  Mesa DevTools: http://localhost:5173/__mesa/devtools
```

#### Using DevTools with Sierra (or any nested plugin)

Sierra compiles `.mesa` files with its own plugin rather than `mesa-vite`, so
Mesa's DevTools server hooks (`configureServer`, `transformIndexHtml`) are never
registered — the DevTools route and the client injection are silently absent.

Add `mesaDevtools()` through `sierra.config.js`'s `plugins`:

```js
// web/config/sierra.config.js
import { mesaDevtools } from '@frontierjs/mesa/vite'

export default {
  target:  'spa',
  plugins: [mesaDevtools()],   // adds /__mesa/devtools route + client injection
}
```

Standalone projects using `mesaPlugin()` directly already include the
DevTools server hooks — no separate import needed.

---

## Browser drive — `@frontierjs/mesa/drive`

A real Chrome over CDP, for an app's own drive: launch, navigate, evaluate, send
input the browser trusts, collect what the page threw. No dependency — the
protocol goes over the global `WebSocket`. Chrome is `$FJS_CHROME` when it is
set, and otherwise the first of `google-chrome`, `google-chrome-stable`,
`chromium` and `chromium-browser` on `PATH`, then the macOS app bundles.
`findChrome()` answers that binary or `null`, so a drive that should skip on a
machine without Chrome asks it first; `openChrome` throws when there is none.

```js
import { openChrome } from '@frontierjs/mesa/drive'

const page = await openChrome({ profile: 'test/.profile' })
await page.navigate('http://localhost:8700/', 'window.__ready')
await page.clickAt('button[type=submit]')
await page.type('ada@example.com')
await page.press('Enter')
const title = await page.evaluate(`return document.title`)
if (page.errors.length) throw new Error(page.errors.join('\n'))
await page.close()
```

| Option | Default | |
|---|---|---|
| `profile` | a temp directory, removed on close | A directory you keep. IndexedDB, Cache Storage, the service worker and OPFS live in it, so a drive that closes and reopens an offline app needs one |
| `bootstrap` | — | A script run before anything else in every document |
| `windowSize` | `'1280,900'` | |
| `args` | `[]` | Further Chrome flags, appended — `--enable-unsafe-extension-debugging` for a drive that loads an extension. `--remote-debugging-port` and `--user-data-dir` are the driver's and are refused |

The handle is `{ navigate, evaluate, clickAt, press, type, key, newPage, cmd, send, on, errors, close }`.
`errors` holds what the page threw, its `console.error` calls, and any console
warning starting `[Mesa]` — a render the framework survived but corrupted.
A drive with a stricter policy, or one counting WebSocket frames, reads the
events itself: `on('Runtime.consoleAPICalled', (params) => …)` answers its own
unsubscribe. `cmd(method, params)` is a CDP call on the page; `send(method,
params, sessionId)` is the browser-level one, for a drive that attaches targets
of its own — an extension's popup or its service worker.

Chrome picks its own debugging port, so two drives never attach to each other's
browser, and a crashed run's browser and temp profile are cleaned up on exit
and on the next launch. Focus is emulated: a headless window blurs about thirty
seconds in, and after that `el.focus()` fires no `focus` event.

### Taking the network away

`createNetwork(browser)` is Chrome's own offline mode, the one the DevTools
network panel switches, plus the step the emulation leaves out: **an open
WebSocket keeps carrying frames**, so going offline also closes the sockets the
page opened. A vite-hmr socket is left alone, because closing it reloads the
page onto Chrome's offline screen. Call it before the first navigation, so the
page's sockets are registered.

```js
import { openChrome, createNetwork } from '@frontierjs/mesa/drive'

const page = await openChrome()
const net  = await createNetwork(page)
await page.navigate('http://localhost:8700/')
await net.withOffline(async () => {
  // the network refuses, and the app's socket is closed
})
await net.waitOnline()   // the browser, then the app's socket reconnecting
```

`goOffline()` answers how many sockets it severed, or `null` when the page
loaded before `createNetwork`. `withOffline(fn, { sever: false })` leaves the
socket open, which is a real outage's first seconds. The emulation is per
page, so a `newPage()` stays online, and a service worker's own network is
not covered.

## Tests

```bash
bun run test        # vitest, then the browser drives
```

Every suite lives in `test/`. What each covers, rather than how many assertions
it holds — a per-suite count is a number nothing regenerates, and the table this
replaced was out of date in both columns without ever rendering wrong:

| Suite | Covers |
|---|---|
| `compiler` · `emission` | Analysis, emission, `$:` semantics, blocks, CSS scoping — and that the emitted JS **parses** (Invariant 15: a clean compile is not proof of valid JS) |
| `runtime` · `effect-phase` · `block-teardown-compiled` | Signals, effects, DOM bindings, blocks, delegation, teardown, SSR guards |
| `render-ssr` · `render-component` · `css-inliner` | Static rendering, server↔client agreement, islands, the `renderComponent` pipeline, CSS inlining |
| `component-anchor` · `component-api` · `dynamic-element` | The anchor→registry keying, what `bind:this` hands a parent, `<mesa:element>` |
| `external-reactivity` · `inert-block` · `watch-handler-defer` · `watch-proxy-staleness` · `async-decl-scope` · `whitespace-collapse` | The diagnostics and the semantics that are silent when wrong |
| `vite-plugin` · `vite-server` · `vite-devtools` · `vite-errors` · `vite-hmr` · `vite-compiler-resolution` | The Vite plugin — hooks, a real dev server in middleware mode, the DevTools route, the HMR boundary against real compiled output |
| `script-order` · `script-source-order` | An instance script runs in the order it is written, and what is still pulled up because something needs it |
| `parse-diagnostics` | What a parse failure tells the author — the position it happened at, where the still-open construct was OPENED, and the rule an author who wrote valid HTML broke |
| `reserved-names` | The `$$` prefix an author may not declare — graded against the names the emitter still generates, so a refusal protecting nothing goes red |
| `snippet-through-slot` | A snippet argument that reaches its render site through another component's slot or `{@render}`, including the `<table>` shape it was found in |
| `repl` | REPL module graph, example compile + coverage, interactivity |

`test/spec-check.mjs` is separate — a plain `node test/spec-check.mjs` script that
checks every claim VISION §4 makes against the compiler. `bun run test` runs it first.

`test/mutants.mjs` is the other one, and it grades the suite rather than the
compiler. Most of `compiler.test.js` asserts on the emitted JavaScript as text,
which any emission still calling the named function satisfies whatever the
arguments or the surrounding effect — so this replaces one runtime export at a
time with a function that does nothing, leaves the name exported, and runs the
whole vitest suite. The compiled output is unchanged byte for byte; only the
behavior is gone. A survivor is a construct nothing executes. The catalog is
read off `compiler.js` rather than listed, so a function the compiler stops
emitting leaves on its own, and the expected survivors are named with their
reason in the file — a boundary that stops being true shows up as an unexpected
KILL. `node test/mutants.mjs --list`, or with names to run a few. Not part of
`bun run test`: it runs the suite once per mutant.

---

## Spec

The language specification — `let`/`const`/`var` semantics, the full `$:`
pattern reference, context, slots, block directives, `<mesa:*>` elements,
SSR, and the complete rules reference — lives in
[`docs/VISION.md`](./docs/VISION.md).
