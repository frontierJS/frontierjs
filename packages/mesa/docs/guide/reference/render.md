# `@frontierjs/mesa/render`

Static rendering: turn a Mesa component into an HTML string at build time or on
a server. Two entry points. `@frontierjs/mesa/render` renders a component you
have already compiled and imported. `@frontierjs/mesa/render-component` takes
source in and does the compiling for you. See
[Server rendering](../advanced/server-rendering.md) for the model.

The DOM path needs `happy-dom` installed in your app. `render-component` also
needs `css-tree`.

## `initRenderer`

```js
initRenderer(options?: { url?: string, window?: Window }): void
```

Installs the DOM globals a compiled component reads. Call it **before** you
import any compiled component, because a component builds its templates when its
module loads. Calling it again does nothing.

| Option | Default | Effect |
|---|---|---|
| `url` | `'http://localhost'` | The base URL of the virtual window |
| `window` | a new happy-dom `Window` | Your own window |

```js
import { initRenderer, renderToHTML } from '@frontierjs/mesa/render'

initRenderer()
const { default: Page } = await import('./Page.mesa.js')
const html = await renderToHTML(Page, { title: 'Hello' })
```

## `renderToHTML`

```js
renderToHTML(component: Function, props?: object, options?: object): Promise<string>
```

Renders the default export of a compiled component. Renders run one at a time, so
`Promise.all` over many is safe. The component runs inside a `createRoot` that is
disposed as soon as the HTML is read. It waits on every `{#await}` and writes the
branch it settled into.

| Option | Default | Effect |
|---|---|---|
| `full` | `false` | Wrap the result in a whole HTML document with [`wrapPage`](#wrappage) |
| `keepAnchors` | `false` | Keep Mesa's comment anchors in the output |
| `label` | none | Names the component in a failure message |
| `target` | none | `'server'` for a component compiled with `target: 'server'`. It needs no window and no `initRenderer` call |
| `title`, `css`, `scripts`, `islandLoader`, `meta`, `head` | | With `full: true`, passed on to `wrapPage` |

A component that throws is rethrown as an `Error` that names it and keeps the
original as `cause`.

## `wrapPage`

```js
wrapPage(bodyHTML: string, options?: object): string
```

Wraps HTML in a full document.

| Option | Default | Effect |
|---|---|---|
| `title` | `'Mesa'` | The `<title>` |
| `css` | none | A stylesheet URL for a `<link>` |
| `scripts` | `[]` | Module script URLs, added at the end of `<body>` |
| `islandLoader` | none | A module script URL for the island loader |
| `meta` | `{}` | `{ name: content }` for `<meta>` tags |
| `head` | `''` | Markup already rendered, placed as written |

Every URL and attribute is escaped.

## `renderAll`

```js
renderAll(pages: Array<{ component, props?, options? }>): Promise<string[]>
```

Renders many pages, in order, and answers all the HTML.

## `escapeHTML`

```js
escapeHTML(value: any): string
```

Escapes `& < > " '`. Use it for any value going into HTML by hand.

## `resetRenderer`

```js
resetRenderer(): void
```

Removes the installed globals. For tests.

## `@frontierjs/mesa/render-component`

```js
import { renderComponent, renderFile } from '@frontierjs/mesa/render-component'

renderComponent(source: string, options?: object): Promise<RenderResult>
renderFile(filePath: string, options?: object): Promise<RenderResult>
```

Compiles source, follows its imports, collects its CSS and renders it, in one
call. `renderFile` reads the path and uses its directory as `cwd`.

| Option | Default | Effect |
|---|---|---|
| `target` | `'html'` | `'html'`, `'email'` (CSS inlined, plain-text copy), `'fragment'` (no document wrapper) or `'js'` (compiled modules, nothing rendered) |
| `data` | `{}` | Props for the component |
| `cwd` | `process.cwd()` | Where imports resolve from |
| `filename` | `'Component.mesa'` | The source's name |
| `islands` | `false` | Mark `client:*` components so a client loader can find them |
| `compileOptions` | `{}` | Extra options for [`compileSource`](compiler.md#options) |
| `alias` | none | Bundler-style import aliases, `{ '@': '/abs/path/src' }` |
| `tmpDir` | Mesa's package root | Where the temporary compiled modules go. Point it at a directory your app resolves packages from |
| `transformSource` | none | `(source, filename) => string`, applied to every file read before it is compiled |
| `styleTag` | `true` | `html` target: prepend the CSS as one `<style>` block |
| `preserveMediaQueries` | `true` | `email` and `fragment`: keep `@media` rules in a `<style>` block |
| `unocss` | none | A UnoCSS config, when `@unocss/core` is installed |

The result:

| Field | Holds |
|---|---|
| `html` | The rendered HTML (not set for `js`) |
| `css` | The collected CSS |
| `styles` | `{ id, css }` per component, in order |
| `exports` | The component's named exports |
| `subject`, `text` | `email` only: `export const subject`, and a plain-text copy |
| `islands` | Each `client:*` call site, `{ component, directive, media?, props?, file }` |
| `unlowered` | Files the string mode could not render and sent through the DOM path |
| `modules`, `entry` | `js` only: a `Map` of path to compiled JavaScript, and the root's key |

## `@frontierjs/mesa/css-inliner`

```js
inlineCSS(html: string, extraCSS?: string, options?: object): string
```

Moves CSS into `style=""` attributes, resolving custom properties, for email
clients. Options: `preserveMediaQueries` (default `true`), `inlineStyleTags`
(default `true`) and `customProps` (extra custom properties to resolve).

---

Spec: [VISION.md § 19](../../VISION.md#19-static-detection-and-server-side-rendering) · RULE 19, RULE 20
