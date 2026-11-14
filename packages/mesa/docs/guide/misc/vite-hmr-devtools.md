# Vite, HMR and DevTools

The Vite plugin is part of `@frontierjs/mesa`, at the subpath
`@frontierjs/mesa/vite`. Install the one package.

## The plugin

```js
// vite.config.js
import mesaPlugin from '@frontierjs/mesa/vite'

export default {
  plugins: [mesaPlugin()]
}
```

It handles `.mesa` and `.md` files: compiling them, scoped CSS, the error
overlay, HMR, click-to-source and DevTools. In dev it compiles with `dev: true`
on its own. A production build compiles with `dev: false`.

For `.md` files, install the Markdown packages in your app:
`unified remark-parse remark-gfm remark-rehype rehype-slug rehype-stringify`. A
missing one fails the first `.md` transform with the install line. `.mesa` files
are unaffected.

### Options

```js
mesaPlugin({
  extensions:   ['.mesa', '.md'],   // file extensions to process
  css:          true,               // emit <style> blocks. false DROPS them
  hmr:          true,               // HMR in dev, for .mesa
  inspect:      true,               // click-to-source in dev. { key: 'meta' } names the modifier
  compilerPath: undefined,          // a compiler build to use instead of the installed one
})
```

| Option | Default | Effect |
|---|---|---|
| `extensions` | `['.mesa', '.md']` | Which files the plugin transforms |
| `css` | `true` | `false` drops every `<style>`. It does not hand it to you, so nothing styles the page |
| `hmr` | `true` | Turns the hot-update boundary on in dev |
| `inspect` | `true` | Click-to-source. `false` also stops the compiler stamping `data-fjs-loc` on elements |
| `compilerPath` | the installed compiler | For testing against another compiler build |

### Scoped CSS

Each component's `<style>` is added to its module as an `addStyles(id, css)`
call, keyed by a hash of the CSS. A prerendered page and the client agree about
which styles are already there.

### Errors

A compile error answers the module request with a 500, and Vite shows it in the
browser overlay with the file, the message and the position. Warnings print in the
terminal. See [Errors and warnings](../reference/errors-and-warnings.md).

### Click-to-source

Hold **Alt** and the element under the pointer is outlined with the line that
wrote it. Click, and the dev server opens that line in your editor. `Alt`+`Z`
does the same to whatever has focus. Which editor opens is Vite's answer
(`$EDITOR`, or its own detection). The compiler stamps
`data-fjs-loc="src/pages/Home.mesa:12:3"` on each template element in dev. A
production build stamps and injects nothing.

## HMR

On save, Mesa recompiles the file and re-renders the live instances of that
component in place. The parent's tree is not rebuilt, and props flow through
unchanged. `.md` files do not hot-update. They reload the page.

**Top-level state is recreated on each update.** A `let` goes back to its
initializer. State that has to survive an edit (a form in progress, a request in
flight) belongs in a plain module, which stays loaded across reloads. See
[Shared state](../reactivity/shared-state.md).

If the hot-update client cannot be built, the plugin injects no boundary at all.
That leaves the file on Vite's full-reload path, and a warning says why. The other
choice would be a boundary that swallows every edit.

Edit twice in a few tens of milliseconds and the file watcher sees one event. If a
hot update seems missing, that is the likely cause.

## Mesa DevTools

In dev the plugin serves a DevTools page at `/__mesa/devtools`: the live
component tree, a signal inspector with current values, and an update log of the
last few hundred reactive events. The server prints the address at startup:

```
  ➜  Mesa DevTools: http://localhost:5173/__mesa/devtools
```

The page reads the runtime's dev registry, `window.__MESA_DEV__`, over a
`BroadcastChannel`, so open it in a second tab or window beside the app. It is
dev-only. A build ships no DevTools and no relay script.

Components must be compiled with `dev: true` to register. The plugin does that for
you in dev. If you compile by hand, pass it yourself. See
[Debugging](../runtime/debugging.md).

### DevTools with Sierra

Sierra compiles `.mesa` files with its own plugin rather than `mesaPlugin()`, so
the plugin's server hooks never run, and the DevTools route and the client
injection are silently absent. Add `mesaDevtools()` through the `plugins` list in
`sierra.config.js`:

```js
// web/config/sierra.config.js
import { mesaDevtools } from '@frontierjs/mesa/vite'

export default {
  target:  'spa',
  plugins: [mesaDevtools()],   // adds /__mesa/devtools route + client injection
}
```

`mesaDevtools()` does nothing for the transform, CSS or HMR. Those still come
from whichever plugin compiles your `.mesa` files. The same applies to any other
plugin that compiles `.mesa` itself. An app that uses `mesaPlugin()` directly
already has DevTools and needs no import.

---

Reference: [`@frontierjs/mesa` compiler](../reference/compiler.md)
