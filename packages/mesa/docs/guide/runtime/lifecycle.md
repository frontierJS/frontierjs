# Lifecycle

A component's lifecycle functions hang off `$`, the component instance. You write
no import for it.

```mesa
<script>
  let width = 0
  let box

  $.onMount(() => {
    const ro = new ResizeObserver(([entry]) => width = entry.contentRect.width)
    ro.observe(box)
    $.onDestroy(() => ro.disconnect())
  })
</script>

<div bind:this={box}>{width}px wide</div>
```

`$.onMount(fn)` runs after the component is in the DOM. It does nothing on the
server. `$.onDestroy(fn)` runs when the component is removed.

## `$.onCleanup`

Inside a [`$:` watch](../reactivity/watches-and-effects.md), `$.onCleanup(fn)`
registers work to undo. It runs before the handler's next run and when the
component is destroyed. Call it before the first `await`.

```js
$: id, async () => {
  const c = new AbortController()
  $.onCleanup(() => c.abort())
  result = await (await fetch(`/api/${id}`, { signal: c.signal })).json()
}
```

## `$.tick`

Writes to state are batched, so code after `count++` still sees the old DOM.
`$.tick()` resolves once the DOM has updated:

```js
messages = [...messages, m]
await $.tick()
scrollToBottom(el)
```

`$.tick(fn)` takes a callback instead. Use it to read the result of a change you
just made.

## `$.mounted`

`$.mounted(fn)` is `onMount` that also gates the template. See
[`<mesa:mounted>`](../special-elements/mounted.md).

## What `$` is

`$` is the component. Everything the framework gives a component is reached
through it: `$.onMount`, `$.emit`, `$.after`. Five names read as data also have a
bare spelling, which is the one you write: `$props`, `$attributes`, `$slots`,
`$context` and `$async`.

`$` is only legal as the object of a member expression. Destructuring it,
aliasing it or passing it to a function is a compile error. It does not exist in
`<script module>`; there, import from `@frontierjs/mesa/runtime`, which exports
`onMount` and `onDestroy` for helpers written outside a component. `$:` is a
separate thing that shares the character.

---

Spec: [VISION.md § 17](../../VISION.md#17-built-in-functions-the--door) · RULE 18 · RULE 18a
