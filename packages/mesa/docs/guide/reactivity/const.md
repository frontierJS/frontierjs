# `const`

A top-level `const` that reads reactive state is derived. It recomputes when
anything it reads changes, and you cannot assign to it.

```mesa
<script>
  let price = 20
  let quantity = 1
  const total = price * quantity
  const label = total > 100 ? 'Bulk order' : 'Order'
</script>

<input type="number" bind:value={quantity} />
<p>{label}: {total}</p>
```

`total` has no wrapper and no dependency list. Mesa sees that it reads `price` and
`quantity` and wires it up. `label` reads `total`, so it follows along.

## Static unless it can move

A `const` is derived only when it reaches something that can change: a `let`, a
[prop](props.md), a `$context` read or an awaited value. Every other `const` is a plain
constant, with no signal behind it.

```js
const MAX = 100              // static
const doubleMax = MAX * 2    // static: MAX cannot move
const page = items.length    // derived: items is a let
```

## Derived means lazy

A derived `const` computes when something reads it, not when it is declared. A
`const` whose initializer does work, such as subscribing to a channel, only does that
work if the page reads the value, and Mesa warns when a derived `const` that calls
something is never read. Work that must start at mount belongs in a
[`var`](var.md) or in `$.onMount`.

## Imports are static

A value imported from another module is invisible to the compiler, so a `const`
built from one is computed once. To make it follow, see
[Shared state](shared-state.md).

## Derived and writable

A `const` is authoritative: it recomputes and overwrites. For a derived value that
the user can also overwrite, such as a `<select>` that starts at the first city, use
[writable derived](writable-derived.md).

---

Spec: [VISION.md § 2.2](../../VISION.md#22-const--derived--static) · RULE 2
