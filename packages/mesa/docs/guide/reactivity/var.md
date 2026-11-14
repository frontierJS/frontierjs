# `var`

A top-level `var` is outside the reactive graph. It can read reactive values
without subscribing, and writing to it notifies nobody.

```mesa
<script>
  let price = 100
  var previous = null

  function update(next) {
    previous = price      // remember the old value, no re-render
    price = next
  }
</script>

<button onclick={() => update(price + 10)}>Raise</button>
<p>Price: {price}</p>
```

`previous` is bookkeeping. Changing it never touches the page, which is the point.

## A snapshot, not a binding

`var snapshot = price` captures the value `price` has right now and never updates.
Use `var` for a cache, a value held between two events, or anything the page does
not need to follow.

```js
var cache = new Map()      // reads and writes trigger nothing
var staged = ''            // hold input before committing it to a let
```

## In the template, it shows what it was

If you put a `var` in the markup, the page shows the value it had when it was
sampled and never updates. Mesa does not warn, because writing `var` says that is
what you want. If the page must follow a value, use `let` or
[`const`](const.md).

## No `bind:` on a `var`

`bind:value={staged}` is a compile error, because a binding that wrote the DOM once
and then went quiet would be confusing. To capture input without re-rendering,
write the handler yourself.

```mesa
<script>
  var staged = ''
</script>

<input oninput={(e) => { staged = e.target.value }} />
```

---

Spec: [VISION.md § 2.3](../../VISION.md#23-var--non-reactive-sampler), [§ 6](../../VISION.md#6-var-in-the-component--non-reactive-sampling) · RULE 13
