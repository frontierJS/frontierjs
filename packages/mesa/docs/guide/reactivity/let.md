# `let`

A top-level `let` is reactive state. Assign to it and everything that reads it
updates.

```mesa
<script>
  let count = 0
</script>

<button onclick={() => count++}>
  Clicked {count} times
</button>
```

There is no wrapper and no `.value`. `count` is a number, and `count++` is how you
change it.

## The initializer runs once

`let` takes a snapshot. Its initializer runs when the component is created and is
never re-run, even if what it read changes later.

```js
let first = items[0]      // stays the first item it saw
```

To keep re-deriving and still allow writes (for example from `bind:value`), use
[writable derived](writable-derived.md). To derive a value nobody writes to,
use [`const`](const.md).

## Only the top level

Reactivity applies to a `let` declared at the top level of `<script>`. A `let`
inside a function or block is plain JavaScript. It can read and write top-level
state, but nothing tracks the local itself.

## Objects and arrays

Assigning a new object or array updates the page. Changing one in place
(`user.name = 'Grace'`, `todos.push(x)`) does not, unless a `$:` watch covers
that path. See [Objects and arrays](objects-and-arrays.md).

---

Spec: [VISION.md § 2.1](../../VISION.md#21-let--mutable-reactive-state) · RULE 14 · RULE 43
