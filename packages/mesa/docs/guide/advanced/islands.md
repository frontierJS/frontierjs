# Islands

You need this page when most of a page is static HTML and one or two regions
need to be interactive. You mark those regions with a `client:*` directive,
render the page to HTML on the server, and a small loader mounts only the marked
components in the browser.

```mesa
<script>
  import Counter from './Counter.mesa'
  import Chart from './Chart.mesa'
</script>

<h1>Dashboard</h1>
<p>This part ships as plain HTML.</p>

<Counter client:load start={2 + 3} />
<Chart client:visible data={[1, 2, 3]} />
```

By default the compiler strips `client:*`. Render with `islands: true` and each
marked component is wrapped in comment markers that carry its name, directive
and props:

```js
import { renderFile } from '@frontierjs/mesa/render-component'

const { html, islands } = await renderFile('./pages/Dashboard.mesa', {
  target: 'fragment',
  islands: true,
})
```

```html
<p>This part ships as plain HTML.</p>
<!--mesa-island {"component":"Counter","directive":"load","props":{"start":5}}-->
<button>5</button>
<!--/mesa-island-->
```

## Directives

| Directive | The loader mounts the island |
|---|---|
| none | Auto: static if it has no reactivity, interactive if it does |
| `client:static` | Never. The prerendered markup is all of it |
| `client:load` | Immediately |
| `client:idle` | When `requestIdleCallback` fires |
| `client:visible` | When the marked range enters the viewport |
| `client:media="(query)"` | When the media query matches |

The directive is never passed to the component as a prop. The schedule is the
loader's job. Sierra's loader honors all of these. Mesa itself only writes the
markers.

## Mounting is replacement

There is no hydration. The loader clears everything between the two comments and
mounts the component fresh into that range:

```js
import { mount } from '@frontierjs/mesa/runtime'

function mountIsland(open, Component, props) {
  while (open.nextSibling && open.nextSibling.data !== '/mesa-island') {
    open.nextSibling.remove()
  }
  return mount(open, Component, { props })
}
```

If you write a loader, call `mount`. Calling the component directly renders the
right markup and registers no event delegation, so the island looks right and
answers no clicks.

## Details worth knowing

- **Props are written as rendered.** `start={2 + 3}` arrives in the marker as
  `{"start":5}`. A prop that cannot survive JSON (a function, a symbol) is
  dropped with a warning.
- **`result.islands` is the build-time view.** One entry per call site, with
  `component`, `directive` and the import `specifier`, which is how a bundler
  maps a name to a module. It sees only literal attributes.
- **Markers appear on the server only.** On a live client the island is a
  direct call, with no markers and no extra DOM.
- **They are comments, not an element.** An element would be moved out of a
  `<tbody>` by the HTML parser and would take part in flex and grid layout. A
  loader reads them with a `TreeWalker`, not `querySelectorAll`.
- **Async data is the loader's to fetch again.** Nothing from the server render
  is serialized except the props.

---

Spec: [VISION.md § 18.6](../../VISION.md#186-client-directives) · [README § Islands](../../../README.md#islands---islands-true-) · [STATIC_RENDERING.md § Island markers](../../STATIC_RENDERING.md#island-markers) · RULE 26
