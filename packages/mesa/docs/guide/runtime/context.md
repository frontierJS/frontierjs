# Context

`$context` shares values down a component tree without passing props through
every level. Each component that provides a key scopes it to its own subtree.

```mesa
<script>
  let dark = false
  $context.theme = dark ? 'dark' : 'light'
  $context.locale = 'en-US'
</script>

<button onclick={() => dark = !dark}>Toggle</button>
<slot />
```

A descendant reads it:

```mesa
<script>
  const theme = $context.theme
</script>

<p class={theme}>Themed</p>
```

Assigning `$context.key` at the top level of the script provides it. If the
right-hand side reads reactive state, descendants update when it changes.

## The keyword sets the relationship

Read a key with any variable keyword, with the same meaning as elsewhere:

```js
const theme = $context.theme   // follows the provider
let theme = $context.theme     // starts from it at mount, then is yours
var theme = $context.theme     // a snapshot at mount, not reactive
```

## Lookup

The nearest ancestor that provides the key wins. A component can read a key
from above and provide a changed value to its own descendants under the same
name. If no ancestor provides it, the value is `undefined`, silently: the
consumer supplies its own fallback.

## Script only

`$context.key` is rewritten by the compiler, so use it in `<script>`, at the top
level. In a template, read it once into a variable and use that. The imperative
pair `$context.use(key)` and `$context.provide(key, getter)` works anywhere.

## Not a store

Context belongs to one instance's subtree, so two trees are isolated. For state
every instance shares, use [shared state](../reactivity/shared-state.md).

---

Spec: [VISION.md § 7](../../VISION.md#7-context) · RULE 25
