# `{#if}`

Render a block only while a condition is true.

```mesa
<script>
  let count = 0
</script>

<button onclick={() => count++}>Add</button>

{#if count > 0}
  <p>Positive: {count}</p>
{:else if count < 0}
  <p>Negative: {count}</p>
{:else}
  <p>Zero</p>
{/if}
```

The block is added and removed as the condition changes, so anything inside it
(a component, an input and what was typed into it) is created fresh each time
the condition turns true.

## `{:else if}` and `{:else}`

Both are optional. Chain as many `{:else if}` branches as you need; the first
true one renders.

## Only the markup changes

`{#if}` shows and hides template, nothing else. To run code when a value
changes, use a [`$:` watch](../reactivity/watches-and-effects.md).

---

Spec: [VISION.md § 9.1](../../VISION.md#91-conditional--if)
