# Coming from Svelte

Mesa is close to Svelte 5 on purpose: single-file components, `{#if}` and
`{#each}`, snippets, scoped styles. The difference is how reactivity is written.
Svelte marks state with runes, which are function calls. Mesa uses the JavaScript
keywords themselves. The script is plain JavaScript, and the compiler works out
which values are reactive.

## A component, side by side

Svelte 5:

```svelte
<script>
  let { step = 1 } = $props()
  let count = $state(0)
  let double = $derived(count * 2)

  $effect(() => {
    document.title = `Count ${count}`
  })
</script>

<button onclick={() => count += step}>{count} x2 = {double}</button>
```

Mesa:

```mesa
<script>
  export let step = 1
  let count = 0
  const double = count * 2

  $: document.title = `Count ${count}`
</script>

<button onclick={() => count += step}>{count} x2 = {double}</button>
```

There is no import, no wrapper and no `.value`.

## Translation table

### Reactivity

| Svelte 5 | Mesa | Notes |
|---|---|---|
| `let n = $state(0)` | `let n = 0` | A top-level `let` is reactive. The initializer runs once. See [`let`](../reactivity/let.md) |
| `const d = $derived(n * 2)` | `const d = n * 2` | A `const` that reads reactive state is derived. See [`const`](../reactivity/const.md) |
| `let { a = 1 } = $props()` | `export let a = 1` | A prop. Parent updates arrive and the component may reassign. See [Props](../reactivity/props.md) |
| `let { a } = $props()` (read-only by habit) | `export const a = 1` | A prop the component may not write. A write is a compile error |
| `let { a = $bindable() } = $props()` | `export let a` | Any `export let` can be bound with `bind:` |
| `let { ...rest } = $props()` | `{...$attributes}` on the element | Also `$props` for all props. See [Props](../reactivity/props.md) |
| `$effect(() => { … })` | `$: { … }` | Dependencies are found by running. See [`$:` watches and effects](../reactivity/watches-and-effects.md) |
| `$effect` returning a cleanup | `$.onCleanup(fn)` inside the effect | Call it before the first `await` |
| an effect on named values | `$: a, b, () => { … }` | You list the dependencies. The handler runs untracked and not on mount |
| `$derived` you can also write to | `$: name = expr` | Re-derives when its inputs change, and can be assigned or bound in between. See [Writable derived](../reactivity/writable-derived.md) |
| reading a value without tracking | `var x = count` | A `var` samples once and never subscribes. See [`var`](../reactivity/var.md) |
| `$inspect(x)` | `$.inspect(x)` | Top-level, dev-only |
| `untrack(fn)` | `untrack(fn)` from `@frontierjs/mesa/runtime` | |

### Lifecycle

| Svelte | Mesa |
|---|---|
| `onMount(fn)` | `$.onMount(fn)` |
| `onDestroy(fn)` | `$.onDestroy(fn)` |
| `await tick()` | `await $.tick()` |
| `createEventDispatcher()` | a callback prop, `export let onchange = null` and `onchange?.(value)`. `$.emit('change', value)` calls it for you. See [Component events](../runtime/component-events.md) |
| `setContext` / `getContext` | `$context.key = value` / `$context.key`. See [Context](../runtime/context.md) |
| `{#await promise}` | `{#await promise}`, and also `const x = await …` at the top level, with `$async.x` for its state. See [Async](../runtime/async.md) |

### Template

| Svelte | Mesa | Notes |
|---|---|---|
| `onclick={fn}` | `onclick={fn}` | Same |
| `on:click={fn}` | `onclick={fn}` | `on:` and `@` are refused by name |
| `onclick={e => { e.preventDefault(); … }}` | `onclick\|preventDefault={fn}` | Modifiers are piped on: `once`, `passive`, `capture`, `stopPropagation`, `self`, `trusted`, `debounce(ms)`, `throttle(ms)` |
| `{#if}` `{#each}` `{#key}` `{#await}` | the same | `{#each}` is keyed by index unless you write `(item.id)` |
| `{#snippet name(a)}` / `{@render name(a)}` | the same | See [`{#snippet}` and `{@render}`](../template/snippet.md) |
| `{@const x = …}` | `{@const x = …}` | |
| `{@html x}` | `{@html x}` | |
| `{@attach fn}` or `use:action` | `{@attach fn}` | See [`{@attach}`](../template/attach.md) |
| `bind:value` `bind:checked` `bind:group` `bind:this` | the same | On an element, `bind:` is only `value`, `checked`, `files`, `group` and `this` |
| `class:active={x}` / `style:color={c}` | the same | |
| `{#snippet children()}` / `{@render children?.()}` | the same, or `<slot />` | `<slot />` is a snippet with no arguments |
| `<slot name="header" />` | `<slot name="header" />` or `<slot:header />` | A slot takes no attribute but `name` |
| a virtual list library | `{#virtual each items as item}` | Built in. See [Virtual lists](../advanced/virtual-lists.md) |

### Special elements

| Svelte | Mesa |
|---|---|
| `<svelte:window>` | `<mesa:window>` |
| `<svelte:document>`, `<svelte:body>` | `<mesa:document>`, `<mesa:body>` |
| `<svelte:head>` | `<mesa:head>` |
| `<svelte:element this={tag}>` | `<mesa:element this={tag}>` |
| `<svelte:boundary>` | `<mesa:boundary>` (it also gates an async read, with `pending` and `failed` snippets) |
| none | `<mesa:portal to={node}>` and `<mesa:mounted>` |

An unknown `mesa:` name is a compile error, not a dropped element.

### Modules and files

| Svelte | Mesa |
|---|---|
| `<script module>` | `<script module>` |
| `.svelte.js` with runes, and stores | A plain `.js` module. See below |
| `$store` auto-subscription | There is none. See below |
| `.svelte` | `.mesa`. A `.md` file is also a component |
| the `<style>` block | the `<style>` block. Scoped by default, `:global(...)` to cross a boundary |

## Differences that change how you write

**Shared state is a plain module, not a store.** There is no `writable`, no
`$store` and no store contract. Export an object, import it, and tell the
component which paths to watch:

```js
// cart.js
export const cart = { items: [] }
```

```mesa
<script>
  import { cart } from './cart.js'

  $: cart.items
</script>

<p>{cart.items.length} in the cart</p>
```

An import is inert until a `$:` names it. A module that writes its own state
writes through `watchProxy(cart)` from `@frontierjs/mesa/runtime`. See
[Shared state](../reactivity/shared-state.md).

**Replacing is reactive, and in-place changes need a watch.** `$state` makes
objects deeply reactive. In Mesa, `o = { … }` always notifies. For `push` or
`o.n = 2` on an object, see [Objects and arrays](../reactivity/objects-and-arrays.md).

**An `export let` prop gets its default for `undefined` only.** `undefined` means
not given, so the default applies. An explicit `null` clears it.

**`export var` is a snapshot.** A prop declared `export var` is read once at
mount and never updated by the parent. Svelte has no equivalent. Use `export let`
unless a frozen value is what you mean.

**Dependencies are stated once, by the declaration form.** In Svelte an effect's
dependencies are whatever it reads. In Mesa that is the `$: { … }` block. The
`$: a, () => { … }` form is the one that names them and does not run on mount.

**Every element closes explicitly.** HTML's optional end tags (`</li>`, `</p>`,
`</td>`) are a parse error. `<br>` and `<span />` are fine.

**Timers are declared.** Raw `setTimeout` and `setInterval` in a script are a
compile warning. Use `$.after(ms, fn)`, `$.every(ms, fn)` or `await $.sleep(ms)`,
which sit on a clock a test can hold still. See
[Timers and measuring](../runtime/timers-and-measuring.md).

**No hydration.** A server render is HTML. An island is a fresh `mount()` into a
marked range, and nothing adopts server DOM. See [Islands](../advanced/islands.md).

---

Spec: [VISION.md § 1](../../VISION.md#1-design-philosophy)
