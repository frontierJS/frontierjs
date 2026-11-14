# `$:` watches and effects

`let`, `const` and `var` declare values. `$:` is for everything else, and it comes in
three kinds: a **watch** makes an imported object observable, an **effect** runs code
when something changes, and a [writable derived](writable-derived.md) is a value
`const` cannot express. This page covers the first two.

```mesa
<script>
  let count = 0

  $: document.title = `Count ${count}`

  $: count, (n, prev) => {
    console.log(`count went from ${prev} to ${n}`)
  }
</script>

<button onclick={() => count++}>{count}</button>
```

## Automatic dependencies

`$: expr` and `$: { block }` run whenever anything they read changes. They run once
on mount too, because they find their dependencies by running.

```js
$: document.title = `Count ${count}`

$: {
  console.log(count)
  localStorage.setItem('count', count)
}
```

Auto-tracking sees your own `let` and `const` values. It does not see inside an
imported object, so a path there needs its own watch (see below).

## Explicit dependencies

`$: deps, handler` names what to watch, and the handler runs untracked, so reads
inside it add no dependencies. This is the form to reach for by default.

```js
$: userId, () => load(userId)
$: (a, b), () => sync()          // several dependencies go in parentheses
$: userId, (id, prevId) => log(id, prevId)
```

The handler is deferred. It does not run on mount, only on the first change and
every change after, so a previous value always exists. If you find yourself writing
an effect that just assigns a value from its own dependency, you wanted a
[`const`](const.md).

A `prev` that holds an object holds the same reference when you mutated it in place.
Replace the object if you need the old one.

## Cleanup and async

Return a function and it runs before the next call and on destroy. In an `async`
handler, register cleanup with `$.onCleanup` before the first `await`.

```js
$: selectedId, async () => {
  const controller = new AbortController()
  $.onCleanup(() => controller.abort())
  result = await (await fetch(`/api/${selectedId}`, { signal: controller.signal })).json()
}
```

## Watches

A watch has no handler. It only says that this component re-renders when a path
changes, which is how imported and in-place-mutated objects become reactive. See
[Shared state](shared-state.md) and [Objects and arrays](objects-and-arrays.md).

```js
$: user.name
```

A `$:` is top-level only. Nested in a function or a block it is a compile error.
For handlers that must fire in a fixed order, see
[Ordered watch groups](../advanced/watch-groups.md), and for when an effect runs
relative to the DOM, [Timing and the flush](../advanced/timing-and-the-flush.md).

---

Spec: [VISION.md § 4.0](../../VISION.md#40-what--is-for) · RULE 7 · RULE 60
