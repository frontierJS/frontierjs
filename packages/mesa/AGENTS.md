# @frontierjs/mesa — for agents

Compressed reference for writing a `.mesa` component. The README is written for
a person reading once; this file is written for a program that must get one
component right without reading the rest.

If you are changing this package rather than consuming it, read `CLAUDE.md`
instead. Routing, resources, `load()` and prerendering are Sierra's:
`node_modules/@frontierjs/sierra/AGENTS.md`. Class names and tokens are the
design system's: `node_modules/@frontierjs/css/AGENTS.md`.

**Mesa looks like Svelte and is not Svelte.** Most of what goes wrong is a
Svelte 5, Svelte 4, Vue or JSX habit that compiles. Mesa ships no generated
syntax reference, so the vocabulary is here; when this file and a compiler
message disagree, the compiler message is the authority — it names the fix.

---

## The one rule

**A top-level `let` is state, a top-level `const` is derived, and REPLACING a
value is what re-renders.** Mutating one in place does not, and anything
imported is inert until a `$:` names the path you read.

```mesa
<script>
  import { prefs } from '../prefs.js'
  export let items = []                       // a prop
  let filter = ''                             // state
  const shown = items.filter(i => i.name.includes(filter))   // derived, re-runs
  $: prefs.currency                           // an imported path, now watched

  function add(item) { items = [...items, item] }            // replace, not push
</script>
```

---

## A component file

```mesa
---
title: Orders
---
<script module>
  export const PAGE_SIZE = 20                 // runs once at import, importable
</script>

<script>
  export let rows = []
  let open = false
</script>

<button class="btn" on:click={() => open = !open}>{rows.length}</button>

<style>
  .btn { font-weight: 600; }
</style>
```

- **One instance `<script>`, at most one `<script module>`, JavaScript only.** A
  second instance script and `lang="ts"` are both refused.
- **The instance script exports two kinds of thing**: props (`export let`,
  `export const`, `export var`) and methods (`export function`). `export default`
  and `export { … }` are refused; module-scope exports go in `<script module>`.
- **`<script module>` has no `$`** and its bindings are plain JavaScript — a
  module `let` rendered in markup never updates. Import `onMount`/`onDestroy`
  from `@frontierjs/mesa/runtime.js` there.
- **A `---` block in a `.mesa` file is metadata the build reads** (a route's
  title, its render mode) and declares no variables. In a `.md` file the keys
  do become props.
- **Every non-void element closes explicitly.** `<li>a<li>b` is a parse error;
  `<br>` and `<span />` are fine.

---

## State, props and `$:`

| Write | Means |
|---|---|
| `let x = 0` | state; the initializer runs once and is a snapshot |
| `const d = x * 2` | derived when it reaches anything that can move; cannot be assigned |
| `var v = x` | outside the graph — reads without subscribing, writes notify nobody |
| `export let p = 1` | prop the parent updates and the child may write; bindable |
| `export const p = 1` | prop the parent updates and the child may not write |
| `export var p = 1` | prop read ONCE at mount; later parent values never arrive |
| `$: user.name` | watch an imported or local object path (and everything beneath it) |
| `$: id, (id, prev) => load(id)` | effect on change — does **not** run on mount |
| `$: { save(draft) }` | effect, auto-tracked — runs on mount and whenever what it reads changes |
| `$: sel = options[0]` | writable derived: re-derives, but `bind:` may override until the next change |

```mesa
<script>
  import { cart } from '../cart.js'
  export let userId
  let data = null

  $: cart.total                                    // re-render on cart.total writes
  $: userId, async () => {
    const c = new AbortController()
    $.onCleanup(() => c.abort())                   // before the first await
    data = await (await fetch(`/api/${userId}`, { signal: c.signal })).json()
  }
  const cities = await fetch(`/api/c?u=${userId}`).then(r => r.json())
</script>

{#if $async.cities.loading}<p>Loading</p>{:else}<p>{cities.length}</p>{/if}
```

`$:` is top-level only. `$: if (…)` and a `$: { }` block that only reads are
refused, each naming the form you wanted. A `.js` module that WRITES its own
state must write through `watchProxy(obj)` from `@frontierjs/mesa/runtime.js`,
or no component watching that object hears it.

---

## Template

```mesa
<script>
  let count = 0, items = [], query = '', agreed = false, picked = [], on = true
</script>

{#if count > 0}<p>{count}</p>{:else if count < 0}<p>neg</p>{:else}<p>zero</p>{/if}

{#each items as item, i (item.id)}
  {@const label = `${i + 1}. ${item.name}`}
  <li>{label}</li>
{:else}
  <li>None.</li>
{/each}

{#await promise}<p>…</p>{:then value}<p>{value}</p>{:catch err}<p>{err.message}</p>{/await}

{#key selectedId}<Profile id={selectedId} />{/key}

<input bind:value={query} on:input|debounce(300)={search}>
<input type="checkbox" bind:checked={agreed}>
<input type="checkbox" bind:group={picked} value="a">
<div class:active={on} style:color={tone} {@attach focusOnMount}>…</div>
<form on:submit|preventDefault={save}>…</form>
<p style="color: {c}" class="note {kind}">interpolated attributes work</p>
{@html trustedHtml}                                 <!-- not sanitized -->
```

- **`{#each}` takes an array, an iterable or an array-like.** A plain object or a
  number throws naming the fix: `Object.entries(obj)`, `{ length: n }`.
- **On an element, `bind:` is `value`, `checked`, `files`, `group` and `this`.**
  Anything else is refused and names `attr={expr}`.
- Modifiers: `once` `passive` `capture` `preventDefault` `stopPropagation`
  `self` `trusted` `debounce(ms)` `throttle(ms)`. `onclick={fn}` also works on
  an element.
- `{@attach fn}` runs `fn(el)` when the element mounts and a returned function
  is its cleanup. `$.fade()`, `$.slide()`, `$.fly()` and `$.entrance({ in, out })`
  return attachments.
- Globals: `<mesa:window>`, `<mesa:document>`, `<mesa:body>`, `<mesa:head>`,
  `<mesa:portal to={node}>`, `<mesa:element this={tag}>`, `<mesa:boundary>`,
  `<mesa:mounted>`. Any other `mesa:` name is refused with the list.

---

## Components talking to each other

```mesa
<!-- Card.mesa -->
<script>
  export let tone = ''
  export let onclose = undefined
  export let children = null          // a snippet prop: content that takes a value
  const id = 'card-' + crypto.randomUUID()
</script>

<section class="card {tone}" {class} {...$attributes}>
  {#if $slots.header}<header><slot:header /></header>{/if}
  <slot>Nothing here.</slot>
  {@render children?.(id)}
  <button on:click={() => onclose?.()}>Close</button>
</section>
```

```mesa
<!-- a parent -->
<script>
  import Card from './Card.mesa'
  let ref
</script>

<Card bind:this={ref} class="wide" data-test="card" onclose={() => ref = null}>
  <h2 slot="header">Title</h2>
  <p>Body</p>
</Card>
```

- **Events up are callback props.** `onclose={fn}` on the parent, `onclose?.()`
  in the child; `$.emit('close', data)` calls `onclose` or `onClose` too.
- **`class` on a component reaches the child only where the child writes
  `{class}`**, and it MERGES with the element's own classes.
- **`{...$attributes}` forwards what the child did not declare** — declared props
  and `class` are not in it — and it stays live as the parent's values move.
- **`bind:this` on a component is its API** (props and `export function`s); on an
  element it is the node. `bind:x` on a component is two-way on an `export let`.
- **`<slot />` carries content in; a snippet prop carries a value out.** A slot
  accepts no attribute but `name`.
- **Context flows down the tree**: provide with `$context.theme = expr` and read
  with `const theme = $context.theme` at the top of the script. A key nobody
  provides reads `undefined`, silently.

---

## `$`, the component's door

`$.onMount` `$.onDestroy` `$.onCleanup` `$.tick` `$.emit` `$.mounted` `$.inspect`
`$.transition` `$.entrance` `$.fade` `$.slide` `$.fly` — always through `$.`.
**Five data members are written bare**: `$props`, `$attributes`, `$slots`,
`$context`, `$async`. `$` may not be destructured, aliased, passed or shadowed,
and no `$$`-prefixed name or `__anchor`/`__props`/`__block`/`__prev` may be declared. `const ready =
$.mounted(async () => …)` plus `<mesa:mounted />` gates the whole template; one
per component.

---

## Server and client

**There is no hydration.** A server render is HTML; an island is mounted fresh
in the browser (the loader is Sierra's).

- The instance script and auto-tracked `$: { }` effects **run** during a server
  render.
- `$.onMount`, `{@attach}` and `$: dep, fn` handlers **do not**.
- A browser-only API at the top of the script (`localStorage`, a viewport read)
  throws the render. Move it into `$.onMount`.

---

## Wrong guesses

| You will write | Mesa wants | What happens instead |
|---|---|---|
| `let n = $state(0)` · `$derived(…)` · `$effect(…)` | `let n = 0` · `const d = …` · `$: …` | compiles; `$state is not defined` at mount |
| `let { label } = $props()` | `export let label` | compiles; throws at mount |
| `onMount` from `svelte` · bare `$onMount` | `$.onMount(fn)` | bare form refused by name |
| `on:click` on a component · `createEventDispatcher` | `onclick={fn}` prop | refused by name |
| `{@render children()}` for plain content | `<slot />` | throws at mount |
| `<slot item={x}>` · `let:item` | snippet prop + `{@render children?.(x)}` | refused |
| `bind:class` · `bind:disabled` on an element | `{class}` · `disabled={expr}` | refused |
| `{#await p then v}` | `{#await p}…{:then v}…{/await}` | compiles; the emitted JS does not parse |
| `{ok && <b/>}` · `{xs.map(x => <li/>)}` | `{#if}` · `{#each}` | compiles; the emitted JS does not parse |
| `$store.name` auto-subscribe | `$: store.name` then `{store.name}` | `$store is not defined` |
| `<svelte:window>` | `<mesa:window>` | renders a literal `<svelte>` element |
| `transition:fade` · `use:action` | `{@attach $.fade()}` · `{@attach action}` | an inert attribute |
| `className=` · Vue `:label="x"` | `class=` · `label={x}` | a `classname` attribute · the prop never arrives |
| `{$context.form}` in markup | `const form = $context.form` in the script | refused |
| `{title}` from `.mesa` frontmatter | a prop or a `let` | `ReferenceError` at render |
| `<script lang="ts">` · two `<script>` blocks | JS; one instance + one `module` | refused |

**A JavaScript syntax error pointing into a compiled `.mesa` module means a
construct Mesa does not have** — the two *does not parse* rows above, or an
assignment to a derived `const`.

---

## Silent failures

Everything above is loud somewhere. These are not.

- **`arr.push(x)` and `obj.n = 2` render nothing.** Replace (`arr = [...arr, x]`),
  declare `$: obj.n`, or follow the mutation with `obj = obj` inside a
  `<script>` function.
- **An imported object without a `$:` never updates the screen**, and neither
  does a `.js` module writing its raw object — it must write through
  `watchProxy`.
- **A store read hidden inside a helper function is not a dependency.** Pass the
  watched path as an argument: `money(value, prefs.currency)`.
- **`let d = count * 2` is a snapshot.** Use `const` or `$: d = count * 2`.
- **`export var` freezes at mount and `var` in markup never updates**; neither warns.
- **`$: dep, fn` does not run on mount.** Initialize from the `let`.
- **A derived `const` is lazy.** `const handle = subscribe(channelId)` never
  subscribes if nothing reads `handle`; call it from `$.onMount` or an effect.
- **`class="…"` on a child that writes no `{class}` is dropped.**
- **Scoped styles stop at the component edge.** A rule never reaches a child
  component's markup; wrap the selector in `:global(...)`. A tag selector cannot
  match `<mesa:element>` — use a class.
- **An unkeyed `{#each}` is keyed by index**, so focus, an uncontrolled input or an
  animation stays with the POSITION on a reorder. Write `(item.id)`.
- **`{user.middleName}` that is `null` renders empty, but `{user.a.b}` with no
  `a` throws.** Guard with `{#if}` or write `?.` yourself.
- **`false` and `null` remove an attribute, except the four toggle ARIA states**
  (`aria-expanded`, `aria-selected`, `aria-checked`, `aria-pressed`), where
  `false` is written as `"false"`.
- **A compiler warning still builds.** Only errors fail the transform; read the
  warnings a dev server prints.

---

## Checklist before emitting a component

1. One instance `<script>`, plain JavaScript, no runes, no `$props()`.
2. State is `let`, derived is `const`, props are `export let` unless you mean
   `export const` or `export var`.
3. Every array or object change is a replacement or covered by a `$:` watch,
   and every imported object the markup reads has a `$:` naming that path.
4. Events to the parent are `on…` callback props; `on:` appears only on elements.
5. `{#each}` over a list whose rows hold DOM state has a `(key)`.
6. Browser APIs are inside `$.onMount`, `{@attach}` or an event handler.
7. Styles use `@frontierjs/css` classes and tokens; child markup is reached with
   `:global(...)`.
8. Every element is closed; no JSX, no `{#await p then v}`.
9. Ran `fli check` — `css-token-undefined` catches a `var(--token)` in a
   `<style>` no installed stylesheet defines, `resource-script` a resource file
   with no `<script module>`.

`fli make:component` writes a new component into `src/components/`. The
compiler, runtime and render APIs are in this package's `README.md`.
