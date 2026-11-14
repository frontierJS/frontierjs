# Animations

`$.fade`, `$.slide` and `$.fly` animate an element as it enters and leaves.
Attach one with `{@attach}`.

```mesa
<script>
  let show = false
  const fade = $.fade({ duration: 250 })
</script>

<button onclick={() => show = !show}>Toggle</button>

{#if show}
  <div {@attach fade}>content</div>
{/if}
```

Each takes options: `$.fade({ duration, easing })`, `$.slide({ duration,
easing })` for height, and `$.fly({ x, y, duration, easing })` for an offset. They
are CSS transitions, with no animation library needed.

## `$.entrance`

For your own animation, `$.entrance({ in, out })` builds the attachment. If
`out` returns a Promise, the element stays in the DOM until it resolves.

```js
const pop = $.entrance({
  in:  (el) => el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 250, fill: 'forwards' }),
  out: (el) => el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).finished
})
```

Use it as `<div {@attach pop}>`, the same as the ready-made ones.

## `$.transition`

`$.transition(fn)` runs a state change inside the browser's View Transitions API
and falls back to an immediate update where it is missing:

```js
$.transition(() => tab = 'home')
```

Style the result with `::view-transition-old(name)` and
`::view-transition-new(name)` in CSS.

---

Spec: [VISION.md § 16](../../VISION.md#16-animations)
