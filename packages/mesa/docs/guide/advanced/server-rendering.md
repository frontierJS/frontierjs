# Server rendering

You need this page to turn a component into an HTML string at build time or on
a server: a static site, an email, a fragment for another page. Output is plain
HTML. There is no hydration. A client that wants a live region mounts it fresh
(see [Islands](islands.md)).

```js
import { renderFile } from '@frontierjs/mesa/render-component'

const { html } = await renderFile('./pages/About.mesa', {
  data: { title: 'About' },   // becomes the component's props
  target: 'html',             // full document, collected CSS in a <style>
})
```

`renderFile` (a path) and `renderComponent` (a source string) compile the
component, resolve its imports, collect CSS, render and return the result.
`happy-dom` is an optional peer, so the app installs it (`bun add happy-dom`).
The `target` picks the output:

| `target` | Output |
|---|---|
| `html` (default) | Full `<!DOCTYPE html>` document with the CSS in a `<style>` block |
| `email` | Full document with CSS inlined into `style=""`, plus `result.text` and `result.subject` |
| `fragment` | Inlined HTML chunk with no document wrapper, for embedding in a host page |
| `js` | Compiled modules (`result.modules`, `result.entry`) for client bundling; no HTML |

For `email`, export `subject` from `<script module>` and it arrives as
`result.subject`. A result also carries `result.css` and, with `islands: true`,
`result.islands`. If the renderer had to fall back to its DOM path for a file,
that file is named in `result.unlowered`.

## Rendering a compiled factory

When you already have a compiled component (a bundler plugin, or a loop that
imports its own pages), use `renderToHTML`. The order is not optional:

```js
import { initRenderer, renderToHTML } from '@frontierjs/mesa/render'

initRenderer()                                              // 1. DOM first
const { default: Page } = await import('./Page.mesa.js')    // 2. then import
const html = await renderToHTML(Page, { title: 'Hello' })   // 3. then render
```

Compiled components touch the DOM when the module loads, so import before
`initRenderer()` and the import itself throws. Pass the function (`mod.default`),
not the module namespace. `renderToHTML(Page, props, { full: true, title, css,
scripts, meta })` wraps the result in a page shell; `wrapPage(html, options)`
does the wrapping alone, and `renderAll([{ component, props }])` renders many.

## What runs on the server

Effects, derived `const`s and every block (`{#if}`, `{#each}`, `{#key}`,
`{@html}`, `{@render}`) run, because that is how the markup is built, and are
disposed when the render returns. These do not:

- `$.onMount`, `{@attach}`, event handlers and path watches are inert.
- `bind:` on an element writes nothing. A bound field renders blank unless it
  has a `value=` beside it.
- `{#await}` is waited on, and the page gets `{:then}` or `{:catch}`, never
  `{:pending}`. A promise that never settles never returns.
- `<mesa:mounted>` renders its pending branch, and `<mesa:head>` reaches the page
  only on the string mode, which is what `renderComponent` uses.
- `{#virtual each}` renders its first window of rows.

Renders run one at a time, so awaiting a render from inside another render waits
on itself forever. For real parallelism, use one process per worker.

## Static detection

The compiler marks a component static (`ctx.isStatic`) when it has no `let`, no
props, no `$:`, no `$context`, no async derived values, no event handlers and no
`{@attach}`. A static component needs no JavaScript on the client at all. Add
`onclick` or a `let` and it stops being static.

## What a browser global answers

A server render runs in happy-dom, so browser globals are present and answering
rather than missing. They answer as a wide desktop:

| Read | On the server |
|---|---|
| `window.innerWidth` / `innerHeight` | `1280` / `1024` |
| `matchMedia(query).matches` | evaluated against that 1280 by 1024 window |
| `window.devicePixelRatio` | `1` |
| `localStorage` | not defined: reading it throws |

None of this is reported. A component that branches on width bakes the desktop
branch into the page, and nothing warns. Write the branch so the server's answer
is the safe one: start narrow and widen with `min-width`, move the check behind
`$.onMount`, or make the component an island. Guard storage with
`typeof localStorage !== 'undefined'`.

```mesa
<script>
  let compact = true            // the server bakes this, the narrow layout

  $.onMount(() => {
    compact = window.innerWidth < 600
  })
</script>

<nav class={compact ? 'compact' : 'wide'}>Menu</nav>
```

## What bites

- **`<script module>` state is shared across renders.** A compiled tree is
  reused, so a module-level variable carries from one render to the next in the
  same process.
- **Pass children by one protocol.** `<Layout><Page /></Layout>` fills `<slot />`.
  `<Layout children={snippet} />` fills `{@render children?.()}`. A layout that
  speaks one and is handed the other renders an empty slot, with no error.
- **`renderComponent` already renders through the string mode.** It compiles to
  string pushes and builds no DOM. Asking it for `target: 'server'` throws,
  because `target` there is the output shape. If you hand `renderToHTML` a
  factory you compiled yourself for the string mode, pass `{ target: 'server' }`
  to it instead.
- **Comment anchors are stripped.** Pass `{ keepAnchors: true }` to
  `renderToHTML` if you need them. Island markers and `<!--[if mso]-->` comments
  always survive.

---

Spec: [VISION.md § 19](../../VISION.md#19-static-detection-and-server-side-rendering) · [STATIC_RENDERING.md](../../STATIC_RENDERING.md) · RULE 19 · RULE 20
