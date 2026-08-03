# Mesa

**Reactive UI language — compiler, runtime, and tooling**

Mesa is a JavaScript-native reactive UI language. Every piece of Mesa syntax
is valid JavaScript AST. The compiler does the heavy lifting; the runtime is
minimal.

For the language specification, see
[`VISION.md`](./VISION.md).

---

## Ecosystem

| Package | Purpose |
|---|---|
| `@frontierjs/mesa` | Core compiler, runtime, REPL, render pipeline (this package) |
| `@frontierjs/mesa-vite` | Vite plugin — transform, HMR, error overlay, scoped CSS, DevTools |
| `@frontierjs/mesa-email` | Email component kit — 22 production-ready components |
| `@frontierjs/mesa-ui` | UI component kit — 58 components (forms, layout, overlay, feedback) |
| `@frontierjs/sierra` | Meta-framework built on Mesa (separate repo) |

---

## Quick start

```bash
npm install         # install acorn, astring, unified, remark, rehype, vitest
npm run serve       # open index.html in the browser — live REPL
npm test            # run full test suite (compiler + runtime + render + css)
```

For a real project, install the Vite plugin in your app and write `.mesa`
or `.md` files alongside your other source. See [Vite plugin](#vite-plugin).

---

## Files

| File | Purpose |
|---|---|
| `compiler.js` | Mesa → JS compiler. `compile(src, opts)` → `ctx` |
| `compiler-md.js` | Markdown + frontmatter compiler. `compileMd(src, opts)` → `ctx` |
| `runtime.js` | Signals, effects, DOM helpers, event delegation, mount, blocks |
| `render.js` | `renderToHTML(component, props, opts)` / `renderAll` / `wrapPage` — happy-dom static rendering. See `STATIC_RENDERING.md` |
| `render-component.js` | Source-in pipeline: `renderComponent` / `renderFile` for HTML, email, fragment, JS |
| `css-inliner.js` | CSS-to-`style=""` inliner with custom-property resolution |
| `index.html` | Browser REPL — `npm run serve`. Mounts previews via `mount()`; see `repl.test.js` |
| `examples.js` | All REPL examples — 66 across 22 groups |
| `compiler_test.js` | Compiler tests (406) |
| `runtime.test.js` | Runtime tests (286) |
| `render-component.test.js` | Render pipeline tests (29) |
| `render-ssr.test.js` | Static renderer + server↔client agreement (30) |
| `repl.test.js` | REPL module graph, example compile + coverage, preview interactivity (9) |
| `emission.test.js` | Compiler must emit parseable JS — component `bind:`, multi-line attrs (7) |
| `css-inliner.test.js` | CSS inliner tests (36) |
| `email-kit.test.js` | Email kit integration (27, skipped — requires `@frontierjs/mesa-email`) |
| `mesa-vite/` | Vite plugin |
| `mesa-bench/` | Benchmark component |

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
// $async.cities.loading / .fetching / .error generated automatically
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
elements, `bind:value|mask`, `$inspect`, the render pipeline — see
[`VISION.md`](./VISION.md).

---

## Markdown in `.mesa` files

Any `.mesa` or `.md` file that begins with `---` frontmatter is compiled as
markdown:

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

<button on:click={() => likes++}>Like</button>
```

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

// Auto-routes: frontmatter → compileMd, otherwise → compile
const ctx = await compileSource(source, { filename: 'Post.mesa' })

// Reads file + auto-routes by content and extension
const ctx = await compileFile('./src/Counter.mesa')

ctx.result           // compiled JS string
ctx.analysis.errors  // []
ctx.analysis.warnings
ctx.css?.result      // scoped CSS (if css: true)
ctx.frontmatter      // parsed frontmatter object (.md files only)
ctx.isStatic         // true if component has no JS at runtime
```

Useful options:

| Option | Effect |
|---|---|
| `dev: true` | Emit `$runtime.__dev?.r(...)` registration calls — required for DevTools |
| `debug: false` | Strip `$inspect` calls entirely |
| `css: true` | Scope styles and emit `ctx.css.result` |
| `filename` | Used in dev component labels and source maps |
| `remarkPlugins` | Array passed through to the markdown processor (`.md` only) |
| `rehypePlugins` | Same, for the HTML AST stage |

---

## Runtime API

```js
import { mount, mountStatic, flushSync } from '@frontierjs/mesa/runtime.js'
import App from './App.mesa'

// Standard mount — inserts after the label node
const app = mount(document.body, App, {
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

On the server, `$onMount` and path watches are inert while effects and block
directives run and are then disposed; `{#await}` renders its `{:pending}`
branch; `{#virtual each}` renders nothing. Comment anchors are stripped unless
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
meta-framework; `SSR_SPEC.md` W3 has the full rationale, including why the
markers are comments rather than a `<mesa-island>` element and two traps waiting
for whoever writes the loader.

**[`STATIC_RENDERING.md`](./STATIC_RENDERING.md)** has the full model — server
semantics, the page shell, concurrency, lifetimes, and what is and isn't wired
up to Sierra's `static` target yet.

---

## Vite plugin

```js
// vite.config.js
import mesaPlugin from '@frontierjs/mesa-vite'

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
[`VISION.md` §5](./VISION.md), where it survives module
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

Sierra wraps `mesa-vite`'s `transform()` internally but does **not** forward
Vite's server lifecycle hooks (`configureServer`, `transformIndexHtml`).
The DevTools route and client-injection both depend on those hooks, so they
get silently dropped.

Add `mesaDevtools()` as a separate top-level plugin in `vite.config.js`:

```js
import sierra from '@frontierjs/sierra'
import { mesaDevtools } from '@frontierjs/mesa-vite'

export default {
  plugins: [
    sierra(),
    mesaDevtools(),   // separate — Sierra doesn't forward server hooks
  ],
}
```

Standalone projects using `mesaPlugin()` directly already include the
DevTools server hooks — no separate import needed.

---

## Tests

```bash
npm test
```

| Suite | Tests |
|---|---|
| `compiler_test.js` | 399 |
| `runtime.test.js` | 236 |
| `render-component.test.js` | 25 |
| `css-inliner.test.js` | 36 |
| `email-kit.test.js` | 27 (requires `@frontierjs/mesa-email` fixtures) |
| **Total** | **723** |

The email kit suite expects `/tmp/mesa/email/*.mesa` fixtures from the
`@frontierjs/mesa-email` package. Skip with
`--exclude='**/email-kit.test.js'` for core-only runs.

---

## Spec

The language specification — `let`/`const`/`var` semantics, the full `$:`
pattern reference, context, slots, block directives, `<mesa:*>` elements,
SSR, and the complete rules reference — lives in
[`VISION.md`](./VISION.md).
