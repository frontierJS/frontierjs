# Debugging

Two tools for seeing what reactive state is doing.

```mesa
<script>
  let count = 0
  let user = { name: 'Alice' }

  $.inspect(count, user.name)

  $_syncCount: count, () => console.log('count is', count)
</script>

<button onclick={() => count++}>{count}</button>
```

## `$.inspect`

`$.inspect(...exprs)` logs the expressions' labels and values whenever any of
them changes. Replace the logger with `.with`:

```js
$.inspect(count).with(console.trace)
```

It must be a top-level statement of `<script>`, and it is development-only: with
the compiler's `debug: false` the call is removed entirely, so leaving one in
costs nothing in production.

## `$_name:` labels

Put `$_name:` in place of `$:` to give a watch or effect a name. The name shows
in the DevTools graph panel instead of an anonymous node:

```js
$_fetchData: selectedId, async () => { /* … */ }
$_computeTotal: total = items.reduce((sum, i) => sum + i.price, 0)
```

Only the label changes. The statement behaves as it would with `$:`.

---

Spec: [VISION.md § 17](../../VISION.md#inspect-examples) · [§ 4.6](../../VISION.md#46-debug-labels--_name) · RULE 42
