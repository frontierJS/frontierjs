# Mesa Project State
## Last updated: 2026-08-04

> **Picking up cold?** Read the repo-root `HANDOFF.md` first — it has the
> cross-package state and what is uncommitted. This file is Mesa's detail.

Six passes are recorded, newest first. Read the linked doc before touching the
area it covers.

| Pass | Doc | What it covers |
|---|---|---|
| Kit screens, second wave (2026-08-04) | `CHANGES.md` (top entry) | Six found by building `example/`'s order-detail / filter-bar / settings / ⌘K screens: **a click inside `<mesa:portal>` never reached its handler** (portals are delegation roots now, reference-counted), an assignment in a component prop compiled to a signal READ, `$: fn(), handler` spliced its output from the wrong string and threw on a `const`, an attribute depending only on a `{@const}` was written once, a hyphenated prop was an unquoted object key, and `$attributes` finally excludes declared props |
| Snippet props (2026-08-04) | `CHANGES.md` | `{#snippet}` inside a component tag never reached the component, and a snippet's arguments were frozen at first render. VISION §9.5 documented both as working |
| Nested delegation roots (2026-08-03) | `CHANGES.md` (top entry) | A handler ran once per ancestor delegation root — one click, two increments — whenever two mounted trees sat at different depths. The nearest root now owns the event |
| Island markers (2026-08-02) | `CHANGES.md` (top entry) + [`docs/SSR_SPEC.md`](./docs/SSR_SPEC.md) W3 | `ctx.islands` was populated and consumed nowhere; `{ islands: true }` now marks islands in SSR output so a loader can find and mount them |
| REPL + examples + 3 compiler bugs (2026-08-02) | `CHANGES.md` (top entry) | The REPL was dead two ways; `$: { }` writes, component `bind:`, and multi-line attributes all emitted invalid JS |
| Static renderer repair (2026-08-01) | [`docs/STATIC_RENDERING.md`](./docs/STATIC_RENDERING.md) | `renderToHTML` threw on every component; one renderer now, `createRoot` for lifetimes, the two children protocols |
| Block teardown (2026-08-01) | [`docs/BLOCK_TEARDOWN_PASS.md`](./docs/BLOCK_TEARDOWN_PASS.md) | The two failure shapes behind every `{#key}`/`{#await}`/`{#each}`/`<mesa:boundary>` removal bug |
| Reactivity audit (2026-08-01) | [`docs/REACTIVITY_PASS.md`](./docs/REACTIVITY_PASS.md) | The reactive core, the proxy layer, SSR environment split |

Read `docs/BLOCK_TEARDOWN_PASS.md` and `docs/REACTIVITY_PASS.md` before changing
`runtime.js`; `docs/STATIC_RENDERING.md` before changing either renderer.

---

## Packages

| Package | Path | Description |
|---|---|---|
| `@frontierjs/mesa` | `./mesa/` | Core compiler, runtime, REPL, render pipeline |
| `@frontierjs/mesa/vite` | `./mesa/mesa-vite/` | Vite plugin — HMR, devtools, dev client. **A subpath of mesa since 2026-08-10, not a package** — see `CHANGES.md` |
| `@frontierjs/email-kit` | `packages/email-kit/` | Email component kit. **Arrived 2026-08-03.** The skipped `email-kit.test.js` that needed it is deleted — it was all 27 of this package's skipped tests. |
| `@frontierjs/ui` | `packages/ui/` | Component kit over `@frontierjs/css`, 63 components. **Promoted out of `packages/mesa/ui-v2/` on 2026-08-03** and restyled; `packages/mesa/ui/` (the older 4: Badge, Button, Card, Input) was deleted in the same move. |

Monorepo layout — this is the pre-monorepo layout and no longer matches the
tree. Mesa lives at `packages/mesa/`:
```
frontierjs/packages/
  mesa/           @frontierjs/mesa  (_built: 2026-05-05)
  ui/             @frontierjs/ui          ← real, since 2026-08-03
  css/            @frontierjs/css
  sierra/         @frontierjs/sierra
  email-kit/      @frontierjs/email-kit   ← real, since 2026-08-03
```

---

## Test Suite

| Suite | Tests | File |
|---|---|---|
| Compiler | 406 | `test/compiler.test.js` |
| Runtime | 286 | `test/runtime.test.js` |
| Compiler emission | 17 | `test/emission.test.js` |
| CSS Inliner | 36 | `test/css-inliner.test.js` |
| Render Pipeline | 29 | `test/render-component.test.js` |
| External reactivity | 26 | `test/external-reactivity.test.js` |
| Static / SSR renderer | 41 | `test/render-ssr.test.js` |
| REPL | 9 | `test/repl.test.js` |
| Inert blocks | 23 | `test/inert-block.test.js` |
| Watch handler defer | 13 | `test/watch-handler-defer.test.js` |
| Watch proxy staleness | 8 | `test/watch-proxy-staleness.test.js` |
| Async decl scope | 7 | `test/async-decl-scope.test.js` |
| Block teardown (compiled) | 6 | `test/block-teardown-compiled.test.js` |
| Effect phase | 5 | `test/effect-phase.test.js` |
| **Total** | **946** | |

Run: `bun run test` → **1027 pass / 0 fail / 0 skipped** across 16 files
(verified 2026-08-04).

Nothing is skipped any more. The 27 that were are gone with `email-kit.test.js`,
deleted on 2026-08-03: it rendered 14 `.mesa` files from `@frontierjs/email-kit`
through an absolute `/tmp/mesa/email` path, and that kit now lives at
`packages/email-kit` with a real 34-test suite of its own. Restyling and
rendering it also fixed four defects in this package's `htmlToText`
(conditional comments, `<style>`/`<script>` contents, numeric entities, hidden
preheaders) — see `CHANGES.md`.

`render-component.test.js` needs `/tmp/mesa` to exist (`mkdir -p /tmp/mesa`).

Downstream regression check: `cd ../sierra && npx vitest run` → **672/672**
(2026-08-02; the doc said 655 before that session's new test files landed).
Re-run it after any change to `runtime.js`.

---

## Compiler — Key Features

- `let` → reactive signal, `const` → derived memo, `var` → non-reactive sampler
- `export let` / `export const` / `export var` — all three prop kinds
- `$:` annotation system — path watch, auto-effect, watch+handler, ordered group, writable derived, debug labels
- `{#if}`, `{#each}` (with destructuring), `{#await}`, `{#key}`, `{#snippet}`, `{@render}`, `{@html}`, `{@attach}`
- `{#virtual each}` — fixed-height virtualized lists, `height=` / `viewport=` optional; SSR renders the first window
- `<mesa:boundary>`, `<mesa:mounted>`, `<mesa:portal>`, `<mesa:window>`, `<mesa:document>`, `<mesa:body>`, `<mesa:head>`
- `$mounted(fn)` builtin — imperative mount gate, one per component
- `$context` — provide/consume with `const` (tracks) / `let` (init at mount) / `var` (snapshot)
- `$class` system — `bind:class`, `{class}` shorthand, auto-rename on components
- `bind:prop` on a component — two-way; `pushProps` carries parent→child, `bindProp` child→parent
- CSS tokenizer — nested CSS, `@layer`, `@container`, `@keyframes`, `:global()`, `@apply`
- `<script module>` — shared across instances, real ES module exports
- Static component detection (`ctx.isStatic`)
- `config.dev: true` — emits `$runtime.__dev?.r(sig, name, kind)` registration calls

### Compiled output shape
```js
export default function Counter(__anchor, __props, __block) {
  $runtime.push_component('Counter', 'Counter.mesa')
  // ... signals, effects, DOM ...
  $runtime.pop_component()
}
$runtime.$$delegate(['click'])
```
No `makeComponent` wrapper — direct named function export.

---

## Runtime — Key Features

- Fine-grained signals: `createSignal`, `createEffect`, `createMemo`, `batch`, `untrack`
- `createRoot(fn)` — an owner scope with an end. `fn` receives `dispose`; everything
  created inside is torn down by it. **Ownership without tracking** — the root
  subscribes to nothing, which is why `createEffect` cannot substitute (it would
  re-run the body when the body's own writes fire). VISION **RULE 54**; used by
  `render.js` per page and by the REPL per preview
- `mount(label, component, option)` — mounts a component after a label node
  - `option.root` — explicit delegation + style root (required for shadow DOM)
  - `option.props` — initial props
- `$$delegate(events)` — per-mount-container event delegation (not document.body)
- `_registerDelegateRoot(root)` — attaches delegation listeners to a container, returns cleanup
- `addStyles(id, css)` — injects styles into shadow root via `adoptedStyleSheets` when registered
- `_registerStyleRoot(root)` — registers a shadow root to receive component styles
- `__dev` export — signal registry, component registry, update log for DevTools
- `tick()` — returns Promise resolving after next reactive flush (not yet added — backlog)

### Shadow DOM mount pattern
```js
import { mount } from '@frontierjs/mesa/runtime.js'
import App from './App.mesa'

const host = document.getElementById('host')
const shadow = host.attachShadow({ mode: 'open' })
const target = document.createElement('div')
shadow.appendChild(target)

mount(target, App, {
  props: {},
  root: shadow,  // scopes event delegation + style injection to shadow root
})
```

---

## mesa-vite Plugin

### HMR (Vite 8) ⚠️ partially tested — id normalization fix untested in browser
- `handleHotUpdate` — re-compiles on change, **explicitly invalidates module** before returning
- Uses `server.hot ?? server.ws` for error overlay (Vite 8 compat)
- `injectHMR(js, id, root)` — wraps compiled component for hot update:
  - **Normalizes `id` to root-relative** (`/App.mesa` not `/abs/path/App.mesa`) so the
    browser registry key matches what Vite uses in `import.meta.hot.accept` callbacks
  - Renames `export default function Name(...)` to `__mesaOrigFn`
  - Injects `__mesa_register(id, hmrMark, anchor, props, block, fn)` after `pop_component()`
  - Exports `__mesaHMRWrap` (inserts stable `<!--mesa:hmr:Name-->` comment, then calls `__mesaOrigFn`)
  - Exports `__mesaOrigFn` and `__setMark(mark)` — accept handler injects existing hmrMark
    into new module scope before re-rendering to avoid creating a duplicate marker
  - `import.meta.hot.accept((m) => __mesa_hot_update(id, m.__mesaOrigFn ?? m.default))`
- `__mesa_hot_update` snapshots entries, deletes each before re-rendering to prevent stale accumulation

### DevTools (`mesaDevtools()`)
- Standalone named export — add separately in `vite.config.js` for Sierra projects
- Serves `/__mesa/devtools` — component tree, signal inspector, update log
- Injects BroadcastChannel relay client into HTML pages
- Prints devtools URL in terminal on server start

### Event delegation
- Vite 5+ / 8: `handleHotUpdate` is the correct hook (not `hotUpdate`)
- `hotUpdate` (Vite 8 environments API) not used — `handleHotUpdate` still works

---

## render-component.js Pipeline

`renderComponent(source, options)` / `renderFile(filePath, options)`

Targets:
- `html` — rendered HTML with CSS in `<style>` block
- `email` — CSS inlined via `css-inliner.js`, full `<!DOCTYPE html>` document, `result.text` plain-text fallback, `result.subject` from `<script module>`
- `fragment` — inlined HTML, no document wrapper
- `js` — Map of compiled JS modules

Key details:
- `compileTree()` — recursive import resolution; every temp `.mjs` in a tree goes to one directory, `options.tmpDir` or the default
- `sourceOverride` param eliminates double temp-file on entry point
- `defaultTmpDir()` uses `findMesaDir()` to handle Vite rewriting `import.meta.url`. It is the default because a temp module imports `@frontierjs/mesa/runtime.js`; a caller rendering an APP's tree passes `tmpDir` so bare specifiers resolve from the app's `node_modules` (SSR_SPEC W1)
- CSS de-scoping: strips `.scopeId ` prefix from collected CSS before inlining

---

## CSS Inliner (`css-inliner.js`)

- `inlineCSS(html, extraCSS, options)` — inlines CSS into `style=""` attributes
- Specificity-aware selector matching via happy-dom `querySelectorAll`
- CSS custom property (`var()`) resolution including chained references
- `@media`/`@supports` preserved in `<style>` block (`preserveMediaQueries: true`)
- `@keyframes`/`@font-face` silently dropped (useless without `<style>`)
- `:root` custom properties extracted, not inlined as `style=""`

---

## DevTools System

- `__dev` exported from `runtime.js` — `_signals` Map, `_components` Map, `_log` circular buffer (200)
- `__dev.r(sig, name, kind)` — called by dev-compiled components to register signals
- `__dev.snapshot()` — full state dump for devtools page on connect
- `window.__MESA_DEV__ = __dev` — accessible to injected client without re-import
- Component instance tracking: `push_component(devName, devFile)` / `pop_component()` saves/restores `_devCompId`

---

## @frontierjs/email-kit

22 components in `components/`:
Email, Section, Row, TwoCol, Column, Spacer, Heading, Text, Button, Image, Link, Divider, Card, KeyValue, DataTable, Stars, Avatar, Review, Contact, Address, Header, Footer

- `renderEmail(source, options)` / `renderEmailFile(filePath, options)` in `render.js`
- `Button.mesa` uses `{@html}` for VML/MSO conditional comments (Mesa strips HTML comments in templates)
- `Stars.mesa` uses pre-computed array to avoid index signal pattern
- `DataTable.mesa` uses `.map((row,i) => ({row,i}))` pre-indexing for same reason
- Tests run via mesa's vitest with `--pool=forks` (required for dynamic `import()` of temp files)

---

## @frontierjs/ui

**Moved out to `packages/ui/` on 2026-08-03.** See that package's
`PROJECT_STATE.md`; the inventory that used to be here was stale (it listed 58
components including several — ColorPicker, Rating, Timeline, Banner — that do
not exist).

Restyling it onto `@frontierjs/css` surfaced three compiler bugs here, all of
which reported success from `analysis.errors`:

- `const fn = () => { reactiveLet = x }` emitted `$runtime.get(sig) = …`, an
  invalid assignment target — so the module threw on load. Same for a mutator
  provided through `$context`. Both fixed, pinned in `emission.test.js`.
- **`{class}` replaced an element's own classes instead of merging them**, so
  `<button class="btn primary" {class}>` rendered with *no* classes when no
  class prop was passed and only the consumer's when one was. Fixed with
  `bindClassPassthrough` in `runtime.js`.

Two gaps found there are **not** fixed and are documented as current behaviour:
a destructuring assignment to reactive lets (`[a,b] = [b,a]`) emits invalid JS,
and `{@const}` inside `{#each}` calls the loop index as a getter. The third —
`<mesa:element this={…}>` compiling to nothing — is closed; see `CHANGES.md`.

---

## Compiler Bugs Fixed This Phase

| Bug | Fix |
|---|---|
| **Slot source dropped** | `makeBlock(tpl)` → `makeBlock(tpl, fn)` when slot body has source. Component calls, effects, bind ops inside slot bodies now render. |
| **Block directive anchor (non-root)** | `{#each}`, `{#if}`, `{#key}`, `{#await}`, `{@render}`, `{@html}` inside element templates now always push a comment anchor and use `noParent=true`. Previously resolved to parent element making `append()` a no-op on detached nodes. `{#virtual each}` excluded (needs container element). |
| **Component inside element template** | Same anchor fix — `<Badge />` inside `<div>` now compiles with a comment anchor inside the element template. |
| **`$: (a, b)` mis-parsed for imports** | Multi-path watch `$: (connectedNew, connectedArr)` where both are imported identifiers was being classified as watch+handler (connectedArr as the "handler"). Fix: pre-scan imports before Pass 1; imported identifiers are never handlers. |
| **`$: (a, b)` mis-parsed for local lets** | Same issue for local `let` variables. Fix: identifiers in `vars` map are never handlers. |
| **Proxy fire self-assignment in watch+handler** | `connectedArr = connectedArr` inside `$: dep, () => {...}` was emitting `$$proxy_connectedArr = $$proxy_connectedArr` instead of `$fire_connectedArr_...()`. Fix: pre-process proxy fire self-assignments before `rewriteExpr` in watch+handler bodies. |
| **Local proxy fire fn not in `proxyFireFns`** | Local `let` whole-object watches now register in `ctx.proxyFireFns` so `rewriteAssignments` can find them in watch+handler bodies. |

---

## Runtime Changes This Phase

| Change | Details |
|---|---|
| **Per-mount event delegation** | `$$delegate` no longer attaches to `document.body`. Each `mount()` call registers its container via `_registerDelegateRoot()`. Shadow DOM works automatically with `root: shadow`. |
| **Shadow root style injection** | `addStyles()` uses `adoptedStyleSheets` for shadow roots. `mount(target, App, { root: shadow })` registers the shadow as both delegation and style root. |
| **`mount()` signature** | `mount(label, component, option)` — label first, component second. `option.root` for shadow DOM. `destroy()` cleans up delegation and styles. |

---

## Known Issues / Backlog — see `ISSUES.md`

Defects and gaps for this package are in the repo-wide register:
**`FJS-024`** `mesa-vite` has no tests, HMR unconfirmed in a browser ·
**`FJS-025`** nothing verified in a real browser (every suite is happy-dom) ·
**`FJS-026`** `mesa-vite/`/`mesa-bench/` invisible to the workspace glob.

Deferred by the language spec rather than open here: full hydration SSR and
TypeScript (RULE 20), variable-height virtual lists (RULE 34).

Still true and not an issue: `{@render children?.()}` vs `<slot />` in the
`uiComponents` REPL example is a `ui/` kit task, deliberately left alone
(`docs/STATIC_RENDERING.md` § Component children).

Add a new item to `../../ISSUES.md`, not here.

## File Inventory

| File | Purpose |
|---|---|
| `src/compiler.js` | Mesa → JS compiler (~6,000 lines) |
| `src/compiler-md.js` | Markdown + frontmatter compiler |
| `src/runtime.js` | Signals, DOM, blocks, delegation, styles (~3,300 lines) |
| `src/render.js` | Static/SSR renderer — `renderToHTML` / `renderAll` / `wrapPage` |
| `docs/STATIC_RENDERING.md` | The static-rendering model, server semantics, the two children protocols, Sierra gap |
| `src/render-component.js` | renderComponent / renderFile pipeline |
| `src/css-inliner.js` | CSS inliner for email/fragment rendering |
| `example/index.html` | REPL |
| `test/repl.test.js` | 9 REPL tests — module-graph link check, examples compile + emit valid JS, feature-coverage ratchet, preview interactivity |
| `example/examples.js` | 66 REPL examples across 22 groups |
| `test/compiler.test.js` | 432 compiler tests, incl. 6 pinning that the file EXTENSION decides the language (a `.mesa` route with frontmatter is Mesa, not Markdown — `FJS-106`) and 9 pinning the `<mesa:boundary>` watch set — it watches the async values its body reads, not every one in the component |
| `test/runtime.test.js` | 286 runtime tests |
| `test/emission.test.js` | 17 tests — the compiler must emit JS that parses (component `bind:`, multi-line attrs, `bind:` to a member expression, and the component function name colliding with a reserved word or a `<script module>` binding) |
| `test/css-inliner.test.js` | 36 CSS inliner tests |
| `test/render-component.test.js` | 29 render pipeline tests |
| `test/render-ssr.test.js` | 41 static-renderer tests, incl. 11 server↔client agreement cases, 5 pinning the two component-children protocols, and 11 pinning island markers |
| `test/block-teardown-compiled.test.js` | 6 compiled-and-mounted block teardown tests |
| `docs/REACTIVITY_PASS.md` | 2026-08-01 reactivity audit — changes, open items, false leads |
| `docs/BLOCK_TEARDOWN_PASS.md` | 2026-08-01 block teardown pass — the two failure shapes, corrections |
| `PROJECT_STATE.md` | This file |
| `mesa-vite/index.js` | Vite plugin |
| `mesa-vite/client.js` | HMR client runtime |
| `mesa-vite/devtools.html` | DevTools panel |
