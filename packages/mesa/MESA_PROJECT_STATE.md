# Mesa Project State
## Last updated: May 2026 — Phase 3

---

## Packages

| Package | Path | Description |
|---|---|---|
| `@frontierjs/mesa` | `./mesa/` | Core compiler, runtime, REPL, render pipeline |
| `@frontierjs/mesa-vite` | `./mesa/mesa-vite/` | Vite plugin — HMR, devtools, dev client |
| `@frontierjs/mesa-email` | `./mesa-email/` | Email component kit (22 components) |
| `@frontierjs/mesa-ui` | `./mesa-ui/` | UI component kit (58 components) |

Monorepo layout:
```
frontierjs/
  mesa/           @frontierjs/mesa  (_built: 2026-05-05)
  mesa-email/     @frontierjs/mesa-email
  mesa-ui/        @frontierjs/mesa-ui
  sierra/         @frontierjs/sierra  (separate)
```

---

## Test Suite

| Suite | Tests | File |
|---|---|---|
| Compiler | 399 | `compiler_test.js` |
| Runtime | 236 | `runtime.test.js` |
| CSS Inliner | 36 | `css-inliner.test.js` |
| Render Pipeline | 25 | `render-component.test.js` |
| Email Kit | 27 | `email-kit.test.js` |
| **Total** | **723** | |

Run: `npx vitest run`

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

- **HMR id normalization** ⚠️ — `injectHMR` now strips project root from id to produce
  root-relative registry keys. Fix is logical but **not yet confirmed working in browser**.
  Next session: test with `App.mesa` in project root and in `src/` subdirectory. Check
  console for `[Mesa HMR] No registered instances` warning — if gone, fix is confirmed.
- **`tick()`** — not yet added. Returns Promise after next reactive flush. One `queueMicrotask` delay.
- **`{#virtual each}` in SSR** — client-only, produces no output in `renderComponent`. By design. V2 could add `{:static}` fallback.
- **White Paper §4.2/§4.4** — REVIEW NEEDED: `$: { (a, b) }` (block wrapping sequence expression) is semantically different from `$: (a, b)` (multi-path watch). Block form = auto-tracked effect; sequence form = proxy watch signals. Not called out explicitly in spec or §4.7 table.
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
| `render.js` | SSR renderToHTML |
| `render-component.js` | renderComponent / renderFile pipeline |
| `css-inliner.js` | CSS inliner for email/fragment rendering |
| `index.html` | REPL |
| `examples.js` | 55 REPL examples |
| `compiler_test.js` | 399 compiler tests |
| `runtime.test.js` | 236 runtime tests |
| `css-inliner.test.js` | 36 CSS inliner tests |
| `render-component.test.js` | 25 render pipeline tests |
| `email-kit.test.js` | 27 email kit integration tests |
| `Mesa_White_Paper_v1_0.md` | Spec v1.7 |
| `MESA_PROJECT_STATE.md` | This file |
| `mesa-vite/index.js` | Vite plugin |
| `mesa-vite/client.js` | HMR client runtime |
| `mesa-vite/devtools.html` | DevTools panel |
