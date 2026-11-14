# Getting started

Mesa runs in a Vite project. Install the package, add the plugin, and write
`.mesa` files next to your other source.

```bash
bun add @frontierjs/mesa
bun add -d vite
```

```js
// vite.config.js
import mesa from '@frontierjs/mesa/vite'

export default {
  plugins: [mesa()],
}
```

The plugin compiles `.mesa` and `.md` files, scopes their styles, shows compiler
errors in the browser, and hot-reloads a component without losing the page.

## Write a component

```mesa
<!-- src/App.mesa -->
<script>
  export let name = 'world'
  let clicks = 0
</script>

<button onclick={() => clicks++}>
  Hello {name}, clicked {clicks} times
</button>
```

## Mount it

`mount` takes a node that is already in the page and renders the component right
after it.

```js
// src/main.js
import { mount } from '@frontierjs/mesa/runtime'
import App from './App.mesa'

const anchor = document.createComment('')
document.getElementById('app').append(anchor)

const app = mount(anchor, App, { props: { name: 'Mesa' } })

// later: app.destroy() removes the markup and its listeners
```

## Optional packages

The compiler and runtime need nothing else. A feature that reaches for a library
asks you to install it, and the error names the package.

| To use | Add to your app |
|---|---|
| `.md` pages | `unified remark-parse remark-gfm remark-rehype rehype-slug rehype-stringify` |
| Server rendering | `happy-dom` |

---

Spec: [README.md § Vite plugin](../../../README.md#vite-plugin)
