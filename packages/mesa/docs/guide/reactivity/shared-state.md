# Shared state

Mesa has no store API. Shared state is an object exported from a plain JavaScript
module, and a component that imports it says which parts it follows with a `$:` line.

```js
// store.js
export const user = { name: 'Ada' }
```

```mesa
<script>
  import { user } from './store.js'

  $: user.name
</script>

<input bind:value={user.name} />
<p>Hello, {user.name}</p>
```

`$: user.name` has no body. It tells Mesa that this component re-renders when
`user.name` changes. Every component that watches the same path updates together.

## Watch what you read

An imported binding is invisible to the compiler until you watch it.

```js
$: user                       // the whole object, any change
$: user.name                  // one path
$: (cart.items, cart.total)   // several paths in one line
```

A watched path also makes a `const` that reads it derived, so
`const shout = user.name.toUpperCase()` follows `user.name` once `$: user.name` is
there. Without the watch it computes once.

## Share fields, not primitives

An imported number or string is a constant, even if the module reassigns its
`export let`. State that moves lives in a field on an exported object: `store.count`,
not `count`.

## Writing from the module

Writes made inside a component are picked up automatically. A module that changes
its own state needs the same handle the components use, which `watchProxy` returns.

```js
// store.js
import { watchProxy } from '@frontierjs/mesa/runtime'

export const cart = { items: [], total: 0 }
const _cart = watchProxy(cart)

export function add(item) {
  _cart.items = [..._cart.items, item]
  _cart.total = _cart.items.length
}
```

A write straight to `cart.items` from the module reaches nobody. Keep the reacting
in components and compute shared values where you write them, not where you read them.

For giving a lifetime to work that lives outside a component, see
[Lifetimes](../advanced/create-root.md).

---

Spec: [VISION.md § 5](../../VISION.md#5-shared-state--plain-javascript-modules) · RULE 8
