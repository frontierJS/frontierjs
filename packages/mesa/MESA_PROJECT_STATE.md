# Mesa Project State
## Last updated: 2026-08-02

> **Picking up cold?** Read the repo-root `HANDOFF.md` first — it has the
> cross-package state and what is uncommitted. This file is Mesa's detail.

Five passes are recorded, newest first. Read the linked doc before touching the
area it covers.

| Pass | Doc | What it covers |
|---|---|---|
| Island markers (2026-08-02) | `CHANGES.md` (top entry) + [`SSR_SPEC.md`](./SSR_SPEC.md) W3 | `ctx.islands` was populated and consumed nowhere; `{ islands: true }` now marks islands in SSR output so a loader can find and mount them |
| REPL + examples + 3 compiler bugs (2026-08-02) | `CHANGES.md` (top entry) | The REPL was dead two ways; `$: { }` writes, component `bind:`, and multi-line attributes all emitted invalid JS |
| Static renderer repair (2026-08-01) | [`STATIC_RENDERING.md`](./STATIC_RENDERING.md) | `renderToHTML` threw on every component; one renderer now, `createRoot` for lifetimes, the two children protocols |
| Block teardown (2026-08-01) | [`BLOCK_TEARDOWN_PASS.md`](./BLOCK_TEARDOWN_PASS.md) | The two failure shapes behind every `{#key}`/`{#await}`/`{#each}`/`<mesa:boundary>` removal bug |
| Reactivity audit (2026-08-01) | [`REACTIVITY_PASS.md`](./REACTIVITY_PASS.md) | The reactive core, the proxy layer, SSR environment split |

Read `BLOCK_TEARDOWN_PASS.md` and `REACTIVITY_PASS.md` before changing
`runtime.js`; `STATIC_RENDERING.md` before changing either renderer.

---

## Packages

| Package | Path | Description |
|---|---|---|
| `@frontierjs/mesa` | `./mesa/` | Core compiler, runtime, REPL, render pipeline |
| `@frontierjs/mesa-vite` | `./mesa/mesa-vite/` | Vite plugin — HMR, devtools, dev client |
| `@frontierjs/mesa-email` | — | Email component kit. **NOT IN THIS REPO** (checked 2026-08-01): no `mesa-email/` directory, nothing in `node_modules`. It is what `email-kit.test.js` needs. |
| `@frontierjs/mesa-ui` | `packages/mesa/ui/` | UI components. The kit described as 58 components is not here either — `ui/` holds **4**: Badge, Button, Card, Input. |

Monorepo layout — this is the pre-monorepo layout and no longer matches the
tree. Mesa lives at `packages/mesa/`; the sibling `mesa-email/` and `mesa-ui/`
packages below do not exist in this workspace:
```
frontierjs/
  mesa/           @frontierjs/mesa  (_built: 2026-05-05)
  mesa-email/     @frontierjs/mesa-email     ← absent
  mesa-ui/        @frontierjs/mesa-ui        ← absent (see packages/mesa/ui/)
  sierra/         @frontierjs/sierra  (separate)
```

---

## Test Suite

| Suite | Tests | File |
|---|---|---|
| Compiler | 406 | `compiler_test.js` |
| Runtime | 286 | `runtime.test.js` |
| Compiler emission | 12 | `emission.test.js` |
| CSS Inliner | 36 | `css-inliner.test.js` |
| Render Pipeline | 29 | `render-component.test.js` |
| External reactivity | 26 | `external-reactivity.test.js` |
| Static / SSR renderer | 41 | `render-ssr.test.js` |
| REPL | 9 | `repl.test.js` |
| Inert blocks | 23 | `inert-block.test.js` |
| Watch handler defer | 13 | `watch-handler-defer.test.js` |
| Watch proxy staleness | 8 | `watch-proxy-staleness.test.js` |
| Async decl scope | 7 | `async-decl-scope.test.js` |
| Block teardown (compiled) | 6 | `block-teardown-compiled.test.js` |
| Effect phase | 5 | `effect-phase.test.js` |
| Email Kit | 27 | `email-kit.test.js` |
| **Total** | **934** | |

Run: `npx vitest run` → **907 pass / 0 fail / 27 skipped** across 15 files
(verified 2026-08-02). The island pass took it 891 → 902; the remaining 5 are a
`bind:` member-expression block added to `emission.test.js` alongside it.

The 27 skipped are `email-kit.test.js`, marked `describe.skip` on 2026-08-01.
They render 14 `.mesa` files from `@frontierjs/mesa-email` via an absolute
`/tmp/mesa/email` path; that package is not in this workspace and the path does
not survive a reboot, so every assertion failed on ENOENT. That is a missing
fixture, not a rendering bug — the email render target (`render-component.js`,
`target: 'email'`) and its CSS inlining (`css-inliner.test.js`, 36/36) are both
covered and green. The file header says how to re-enable it.

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
- `{#virtual each}` — fixed-height virtualized lists (client-only, no-op in SSR)
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
- `compileTree()` — recursive import resolution, all temp `.mjs` files written to mesa package dir
- `sourceOverride` param eliminates double temp-file on entry point
- `_tmpDir` uses `findMesaDir()` to handle Vite rewriting `import.meta.url`
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

## @frontierjs/mesa-email

22 components in `components/`:
Email, Section, Row, TwoCol, Column, Spacer, Heading, Text, Button, Image, Link, Divider, Card, KeyValue, DataTable, Stars, Avatar, Review, Contact, Address, Header, Footer

- `renderEmail(source, options)` / `renderEmailFile(filePath, options)` in `render.js`
- `Button.mesa` uses `{@html}` for VML/MSO conditional comments (Mesa strips HTML comments in templates)
- `Stars.mesa` uses pre-computed array to avoid index signal pattern
- `DataTable.mesa` uses `.map((row,i) => ({row,i}))` pre-indexing for same reason
- Tests run via mesa's vitest with `--pool=forks` (required for dynamic `import()` of temp files)

---

## @frontierjs/mesa-ui

58 components in `components/` across:
- `forms/` — Button, Btn, Input, Textarea, Select, Checkbox, Radio, Switch, Field, Fieldset, Label, DatePicker, FileUpload, NumberInput, ColorPicker, RangeSlider, SearchInput, TagInput
- `display/` — Badge, Table, Pagination, Avatar, Rating, Timeline, Stat, Progress, Skeleton, Code, Tag, Pill, Kbd, Mono
- `layout/` — Card, Accordion, AccordionItem, Tabs, Tab, TabList, TabPanel, Divider, SectionHeader, EmptyState
- `overlay/` — Modal, Drawer, Tooltip, Popover, DropdownMenu, CommandPalette
- `feedback/` — Alert, Toast, Callout, Banner

All 58 compile clean as of 2026-04-13.

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

## Known Issues / Backlog

- **`mesa-vite` has no tests at all**, and its HMR id-normalisation fix has never been
  confirmed in a browser. `injectHMR` strips the project root from the id to produce
  root-relative registry keys; the reasoning is sound and unverified. To confirm: run a
  dev server with `App.mesa` at the project root and in a `src/` subdirectory, edit each,
  and watch the console for `[Mesa HMR] No registered instances`. Highest-value untested
  surface in the package — it is the dev loop.
- **Nothing is verified in a real browser.** Every suite here is happy-dom. The REPL in
  particular was repaired against happy-dom only; codemirror, the importmap and the drawer
  UI are unchecked. `npm run serve` and a click would settle it.
- ~~**Sierra's `static` target is not wired to the renderer**~~ — **wired 2026-08-02.**
  `sierra/src/build/prerender.js` composes each route with its layout chain and renders
  it through `renderComponent` from `closeBundle`. Remaining gaps there: islands still
  emit no marker (SSR_SPEC W3) and have no loader, and `renderComponent` resolves bare
  imports from Mesa's own package root (SSR_SPEC W1). See `SSR_SPEC.md` for both, and
  `STATIC_RENDERING.md` §Status.
- **`{@render children?.()}` vs `<slot />`** — the `uiComponents` example renders empty
  Cards: `ui/Card.mesa` reads the `children` prop while the showcase passes element
  children, which only `<slot />` receives (see `STATIC_RENDERING.md` §Component children).
  Switching `Card` to `<slot />` fixes the composition and then surfaces further latent
  errors in the `ui/` kit, so it is left alone — it is a `ui/` kit task, not a REPL one.
- **`tick()`** — not yet added. Returns Promise after next reactive flush. One `queueMicrotask` delay.
- **`{#virtual each}` in SSR** — client-only, produces no output in `renderComponent`. By design. V2 could add `{:static}` fallback.
- **White Paper §4.2/§4.4** — REVIEW NEEDED (note: `spec-check.mjs` covers VISION §4 and
  passes 16/16 as of 2026-08-02; its hardcoded path was fixed so it runs again —
  `node spec-check.mjs`). The open question: `$: { (a, b) }` (block wrapping sequence expression) is semantically different from `$: (a, b)` (multi-path watch). Block form = auto-tracked effect; sequence form = proxy watch signals. Not called out explicitly in spec or §4.7 table.
- **Variable-height `{#virtual each}`** — deferred
- **Full hydration SSR** — deferred to v1.1
- **TypeScript support** — deferred
- **`$: fn()` post-execution hooks** — design approved, implementation deferred

---

## White Paper

**Version: v1.7** — `Mesa_White_Paper_v1_0.md`  
(Version number in file header not yet updated — update before next publish)

---

## File Inventory

| File | Purpose |
|---|---|
| `compiler.js` | Mesa → JS compiler (~6,000 lines) |
| `compiler-md.js` | Markdown + frontmatter compiler |
| `runtime.js` | Signals, DOM, blocks, delegation, styles (~3,300 lines) |
| `render.js` | Static/SSR renderer — `renderToHTML` / `renderAll` / `wrapPage` |
| `STATIC_RENDERING.md` | The static-rendering model, server semantics, the two children protocols, Sierra gap |
| `render-component.js` | renderComponent / renderFile pipeline |
| `css-inliner.js` | CSS inliner for email/fragment rendering |
| `index.html` | REPL |
| `repl.test.js` | 9 REPL tests — module-graph link check, examples compile + emit valid JS, feature-coverage ratchet, preview interactivity |
| `examples.js` | 66 REPL examples across 22 groups |
| `compiler_test.js` | 406 compiler tests |
| `runtime.test.js` | 286 runtime tests |
| `emission.test.js` | 12 tests — the compiler must emit JS that parses (component `bind:`, multi-line attrs, `bind:` to a member expression) |
| `css-inliner.test.js` | 36 CSS inliner tests |
| `render-component.test.js` | 29 render pipeline tests |
| `render-ssr.test.js` | 41 static-renderer tests, incl. 11 server↔client agreement cases, 5 pinning the two component-children protocols, and 11 pinning island markers |
| `block-teardown-compiled.test.js` | 6 compiled-and-mounted block teardown tests |
| `email-kit.test.js` | 27 email kit integration tests (needs `@frontierjs/mesa-email`) |
| `REACTIVITY_PASS.md` | 2026-08-01 reactivity audit — changes, open items, false leads |
| `BLOCK_TEARDOWN_PASS.md` | 2026-08-01 block teardown pass — the two failure shapes, corrections |
| `Mesa_White_Paper_v1_0.md` | Spec v1.7 |
| `MESA_PROJECT_STATE.md` | This file |
| `mesa-vite/index.js` | Vite plugin |
| `mesa-vite/client.js` | HMR client runtime |
| `mesa-vite/devtools.html` | DevTools panel |
