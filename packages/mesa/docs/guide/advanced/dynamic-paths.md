# Dynamic paths

You need this page when a template or `const` reads a path whose shape is only
known at run time: an index into an array, a computed key, a path through an
object that may be missing a level.

```mesa
<script>
  let cart = {
    items: [{ price: 4 }, { price: 9 }],
    user: null,
  }
  let index = 0

  $: cart.items

  const price = cart.items[index].price
</script>

<button onclick={() => index = (index + 1) % cart.items.length}>
  Item {index}: {price}
</button>
<p>{cart.user?.prefs?.theme}</p>
```

## Static and dynamic paths

For a path the compiler can read as written, `cart.total`, it builds a targeted
accessor. For a path it cannot, `cart.items[index].price` or `cart[key].total`,
it generates an effect that re-evaluates when any top-level variable in the
path changes. Here that is `cart` and `index`. You write the same code either
way.

```js
const price = cart.items[index].price    // re-runs when cart or index changes
const total = cart[dynamicKey].total     // re-runs when cart or dynamicKey changes
```

## Paths are plain JavaScript

A template path is an ordinary expression. Mesa does not rewrite it into a
safe-navigation chain, so `cart.user.prefs.theme` throws where it is read if
`cart.user` is `null`. A nullish value renders as nothing, so
`{user.middleName}` shows an empty string, never the word `undefined`.

Guard a level that can legitimately be missing yourself, in one of two ways:

```mesa
{#if cart.user}
  <p>{cart.user.prefs.theme}</p>
{/if}
<p>{cart.user?.prefs?.theme}</p>
```

The reason Mesa does not add the `?.` for you: a misspelled path and a value
that is truly absent would look identical, an empty cell that reports nothing.
Writing `?.` says in the source that you meant it.

## Getters

A getter on a reactive object is invisible to the compiler. At run time it
runs with the watch proxy as `this`, so what it reads subscribes normally. Watch
what the getter reads, not the getter:

```js
let user = { first: 'Ada', last: 'L', get full() { return this.first + ' ' + this.last } }

$: user.first      // {user.full} updates when first changes
$: user.full       // never fires: nothing writes that path
```

A top-level `const` is usually clearer than a getter.

---

Spec: [VISION.md § 14](../../VISION.md#14-dynamic-paths-and-runtime-effects) · RULE 11 · RULE 12
