# `@frontierjs/mesa/runtime`

The signal runtime that compiled components call. A component's own code never
imports it: Mesa's builtins come through the `$` door. What an app imports from
here is the code that starts the app, and helpers for code that lives outside a
component.

```js
import { mount, flushSync } from '@frontierjs/mesa/runtime'
```

Other targets have their own subpaths (`/runtime/terminal`, `/runtime/native`,
`/runtime/server`) and expose the same component contract. Everything below is
the browser runtime.

## Mounting

### `mount`

```js
mount(label: Node, component: Function, options?: { props?: object, root?: ShadowRoot }): { find, destroy, $dom }
```

Renders `component` after `label`, which must already be in the document and
have a parent. Returns a handle: `find(selector)` is `querySelector` scoped to the
mounted tree, and `destroy()` removes the DOM, disposes every effect and
removes the event listeners and styles the mount added.

| Option | Effect |
|---|---|
| `props` | Props for the root component |
| `root` | A shadow root. Event delegation and styles are scoped to it. See [Shadow DOM](../advanced/shadow-dom.md) |

`mount` throws outside a browser. On a server use [`@frontierjs/mesa/render`](render.md).

### `mountStatic`

```js
mountStatic(label: Node, component: Function, options?: { props?: object }): { $dom }
```

Renders `component` inside `label` with no event delegation and no lifetime. For
markup that is built once.

### `flushSync`

```js
flushSync(): void
```

Runs every pending reactive update now. Updates normally flush on a microtask;
use this when you must read the DOM straight after a write, in a test or a
measurement. In a component, `await $.tick()` does the same job.

## Lifetimes and reactivity

### `createRoot`

```js
createRoot<T>(fn: (dispose: () => void) => T): T
```

Owns everything created inside `fn` and ends it when you call `dispose()`. The
root subscribes to nothing, so it can never re-run. See
[Lifetimes: `createRoot`](../advanced/create-root.md).

### `createSignal`, `createMemo`, `createEffect`

```js
createSignal<T>(value: T, options?: { equals?: (a, b) => boolean }): [read: () => T, write: (next: T) => boolean]
createMemo<T>(fn: () => T, options?: { equals?: (a, b) => boolean }): () => T
createEffect(fn: () => void | (() => void)): () => void
```

The primitives that `let`, `const` and `$:` compile to. They work outside a
component, but reactive logic belongs in components ([RULE 51](../../VISION.md#5-shared-state--plain-javascript-modules)). `createEffect` returns a disposer.

### `watchProxy`

```js
watchProxy<T extends object>(obj: T): T
```

Returns the handle that `$:` path watches observe. A module that owns shared
state writes through it. It is cached per object, so every caller gets the same
proxy. See [Shared state](../reactivity/shared-state.md).

### `batch`, `untrack`, `tick`

```js
batch(fn: () => void): void
untrack<T>(fn: () => T): T
tick(fn?: () => void): Promise<void>
```

`batch` groups writes and flushes once at the end. `untrack` reads without
subscribing. `tick` resolves after the DOM has updated.

### `createKeyedEquals`

```js
createKeyedEquals<K>(source: () => K): (key: K) => boolean
```

A comparison against a changing value that wakes only the two keys it moved
between. For a selected row in a long `{#each}`. See [`{#each}`](../template/each.md).

## Lifecycle

```js
onMount(fn: () => void | (() => void)): void
onDestroy(fn: () => void): void
onCleanup(fn: () => void): void
```

The module spelling of `$.onMount`, `$.onDestroy` and `$.onCleanup`, for a helper
written outside a component where there is no `$`. `onMount` does nothing on a
server. `onCleanup` with no owning scope warns and drops the callback. See
[Lifecycle](../runtime/lifecycle.md).

## Context

```js
context.provide(key: string, getter: () => any): void
context.use(key: string): any
```

The imperative form of `$context`. Both must run during component setup. See
[Context](../runtime/context.md).

## Time and layout

```js
clock.now(): number
clock.after(ms: number, fn: () => void): () => void
clock.every(ms: number, fn: () => void): () => void
clock.frame(fn: () => void): () => void
debounce(fn, ms): Function
throttle(fn, ms): Function
measure(el: Element): Promise<{ left, top, right, bottom, width, height } | null>
viewport(): Promise<{ width, height }>
focus(el: Element): Promise<void>
```

`clock` is the one clock every timer Mesa owns reads, so a drive can hold time
still. `after`, `every` and `frame` return a cancel function. See
[Timers and measuring](../runtime/timers-and-measuring.md) and
[`@frontierjs/mesa/drive`](drive.md) for holding the page's clock.

## Animation

```js
transition(fn: () => void): void
entrance({ in, out }): Function
fade({ duration = 200, easing = 'ease' }): Function
slide({ duration = 250, easing = 'ease' }): Function
fly({ x = 0, y = -12, duration = 220, easing = 'ease-out' }): Function
```

Also available as `$.transition`, `$.entrance`, `$.fade`, `$.slide` and `$.fly`.
The last four return a function for `{@attach}`. See [Animations](../runtime/animations.md).

## Other exports

`inspect` is the dev-time logger behind `$.inspect`. `version` is the runtime's
version string. The rest of the file's exports (`bindText`, `ifBlock`,
`$$eachBlock` and the like) are the calls compiled output makes. Do not write them by hand.

---

Spec: [VISION.md § 17](../../VISION.md#17-built-in-functions-the--door) · RULE 54
