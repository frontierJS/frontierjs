# @frontierjs/mesa/vite

Vite plugin for [Mesa](../) — `.mesa` and `.md` source transforms, scoped CSS,
HMR, error overlay, and DevTools.

## Features

- **Transform** — `.mesa` and `.md` → ES module JavaScript
- **Scoped CSS** — a `<style>` block is inlined into the module as
  `$$runtime.addStyles(id, css)`, keyed by a content hash. Same route Sierra's
  plugin takes, which is what lets a prerendered page and the client agree
  about which styles are already there
- **HMR** — re-renders live instances in place across module reloads,
  preserving their position in the parent's DOM
- **Error overlay** — compiler errors and warnings shown in the browser
  via Vite's overlay
- **DevTools** — self-contained component tree, signal inspector, and
  update log served at `/__mesa/devtools` in dev
- **Markdown** — `.md` files compile via the same pipeline with frontmatter
  support and pluggable `remark` / `rehype` stages

## Setup

```js
// vite.config.js
import { defineConfig } from 'vite'
import mesa from '@frontierjs/mesa/vite'

export default defineConfig({
  plugins: [mesa()]
})
```

In dev, the plugin compiles with `dev: true` automatically — the runtime's
`__dev` registry is populated and the DevTools page can attach to it.
Production builds compile with `dev: false`.

### Compiler resolution

The plugin imports `compileSource` from `../src/compiler.js` — a sibling, since
this plugin ships inside `@frontierjs/mesa`. There is nothing to search for and
no layout that can fail to match; a missing sibling means a broken install.

It is imported lazily, so putting the plugin in a config file does not pull
~290 KB of compiler into a process that may never transform anything.

`options.compilerPath` still wins, for testing against a compiler build that is
not the installed one — and the answer is memoised per PLUGIN INSTANCE, so two
`mesa()` calls in one config each keep the compiler they asked for:

```js
mesa({
  compilerPath: require.resolve('@frontierjs/mesa/compiler.js'),
})
```

### Markdown support

`.md` files are processed through `compiler-md.js`, which pulls in the
unified ecosystem. Install these alongside the plugin:

```bash
npm install unified remark-parse remark-gfm remark-rehype rehype-slug rehype-stringify
```

Missing packages produce a clear transform error on the first `.md` file —
`.mesa` files are unaffected.

User-supplied remark/rehype plugins can be passed through the compile
options (e.g. via a wrapping plugin or by reading `compileSource` directly):

```js
const ctx = await compileSource(src, {
  filename: 'Post.md',
  remarkPlugins: [remarkMath],
  rehypePlugins: [rehypeKatex],
})
```

## Options

```js
mesa({
  extensions:   ['.mesa', '.md'],   // file extensions to process
  css:          true,               // emit <style> blocks. false DROPS them
  hmr:          true,               // enable HMR in dev (.mesa only)
  inspect:      true,               // click-to-source in dev. { key: 'meta' } names the modifier
  compilerPath: undefined,          // explicit compiler path (overrides auto-resolution)
})
```

## Click-to-source

Hold **Alt** and the element under the pointer is outlined with the line that
wrote it; click and the dev server opens that line in your editor. `Alt`+`Z`
does the same to whatever has focus, and `window.__fjsInspect.locate(el)`
answers a location from the console.

Two halves, and both are dev-only. The compiler stamps
`data-fjs-loc="src/pages/Home.mesa:12:3"` on every template element — an
ATTRIBUTE rather than a runtime map, because a template is cloned rather than
built element by element, so an element with no binding has no reference for a
map to be keyed by and those are most of them. The plugin injects the client
that reads it and calls Vite's own `/__open-in-editor`, so which editor opens is
Vite's answer (`$EDITOR`, or its own detection) and not this package's.

The path in the attribute is relative to the Vite root; the client puts the root
back on before it asks. `inspect: false` turns off the injection AND the
attribute — the client is its only reader, so there is nothing to keep.

A production build stamps nothing and injects nothing.

## HMR

Mesa HMR keeps live component instances in place across module reloads
instead of re-mounting them from scratch. The plugin coordinates with the
runtime to make this work:

**At compile time** the plugin rewrites the module's default export:

- The original `export default function Counter(...)` is renamed to
  `__mesaOrigFn` and re-exported under that name.
- A new default export, `__mesaHMRWrap`, inserts a stable
  `<!--mesa:hmr:Counter-->` marker into the DOM and then delegates to
  `__mesaOrigFn`.
- Inside the function body, just before mount, the plugin emits
  `__mesa_register(id, hmrMark, anchor, props, block, fn)` so the runtime
  knows which DOM region belongs to which module.
- `import.meta.hot.accept((m) => __mesa_hot_update(id, m.__mesaOrigFn ?? m.default))`
  is appended.

**On change**, for every registered instance:

1. Nodes between the stable HMR marker and the runtime anchor are removed.
2. The new module's function is called with the same anchor and the
   existing marker (passed via `newFn.__setMark(hmrMark)`) so no duplicate
   marker is created.
3. The new render registers a fresh entry; stale entries are pruned.

The DOM position survives — the parent component never re-renders, props
flow through unchanged. **Top-level signals are recreated on each update**;
state that needs to survive HMR belongs in a plain JS module
(see [`VISION.md` §5](../docs/VISION.md)).

`.md` files do not receive HMR — they reload the page on change. They are
typically rendered once at build time and rarely participate in interactive
component trees.

### Vite version compatibility

The plugin uses `handleHotUpdate` (the stable hook), and it only
invalidates: a broken file is reported by `transform` raising, so the hook
touches neither `server.hot` nor `server.ws`. The `hotUpdate`
environments-API hook (Vite 8) is not used — `handleHotUpdate` remains the
working path.

## Mesa DevTools

When `mesaPlugin()` is the top-level Vite plugin, DevTools come along for
free:

- A self-contained DevTools page is served at `/__mesa/devtools`
- A small BroadcastChannel relay client is injected into every HTML page
- The runtime's `__dev` registry is exposed on `window.__MESA_DEV__`

The server logs the URL on startup:

```
  ➜  Mesa DevTools: http://localhost:5173/__mesa/devtools
```

The page shows the live component tree, a signal inspector with current
values, and a real-time update log scoped to the last few hundred reactive
events.

### Standalone `mesaDevtools()` — for nested plugins

Some upstream plugins (notably `@frontierjs/sierra`) wrap `mesa-vite`'s
`transform()` internally but **do not forward Vite's server lifecycle
hooks** (`configureServer`, `transformIndexHtml`). The transform still
runs, but the DevTools route and the relay-client injection both depend
on those hooks and get silently dropped.

Add `mesaDevtools()` as a separate top-level plugin to restore them:

```js
import sierra from '@frontierjs/sierra'
import { mesaDevtools } from '@frontierjs/mesa/vite'

export default {
  plugins: [
    sierra(),
    mesaDevtools(),   // adds /__mesa/devtools route + client injection
  ],
}
```

`mesaDevtools()` is a no-op for transform/CSS/HMR — those still come from
whichever plugin handles `.mesa` files. Use it strictly when those
server-lifecycle hooks aren't reaching Vite from the primary plugin. It is
dev-only: in a build it injects no script and claims no id, since the client's
`src` is a virtual id nothing emits as an asset.

## Error overlay

Compile errors surface in Vite's browser overlay with the file path,
message, and (for parse errors) the relevant source context. Compile
warnings appear as terminal warnings during the dev session and as
comments in the compiled output.

Dev and build alike, the transform RAISES: the module request is answered
500, which is the only thing the dev client will put in an overlay. A module
body that throws does not work and cannot — every importer writes
`import X from './X.mesa'`, so the ES linker rejects it for a missing
`default` before a line of it runs, and the developer is told their own
import is wrong.

## Mounting components

```js
import { mount } from '@frontierjs/mesa/runtime.js'
import App from './src/App.mesa'

const app = mount(document.getElementById('app'), App, {
  props: { initialCount: 0 },
})

// Later: app.find(sel) / app.destroy()
```

For shadow DOM, pass `root: shadowRoot` in the mount options — event
delegation and CSS injection both scope to the shadow root automatically.
See the [main README](../README.md#shadow-dom-mount) for the full pattern.
