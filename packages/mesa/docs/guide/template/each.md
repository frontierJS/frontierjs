# `{#each}`

Render a block once per item of an array.

```mesa
<script>
  let todos = [
    { id: 1, text: 'Write docs', done: true },
    { id: 2, text: 'Ship it', done: false },
  ]
</script>

<ul>
  {#each todos as todo (todo.id)}
    <li>{todo.text}</li>
  {:else}
    <li>Nothing to do</li>
  {/each}
</ul>
```

`{:else}` renders when the array is empty.

## Keys

`(todo.id)` is the key. It tells Mesa which row is which, so when the list is
reordered a row moves with its item and keeps its focus, typed text and
animations. State a key whenever rows own that kind of DOM state.

Leave the key off and the list is keyed by index: it always renders correctly,
but a reordered item is poured into the row already at that position. Keying by
the item itself, `(item)`, is only safe when the values are unique.

## Index and destructuring

Add an index after the item. Destructure the item with an array or object
pattern.

```mesa
<script>
  let users = [{ id: 1, name: 'Ada', role: 'admin' }]
  let pairs = [['a', 1], ['b', 2]]
</script>

{#each users as { id, name, role }, i (id)}
  <p>{i}: {name} ({role})</p>
{/each}

{#each pairs as [letter, n] (letter)}
  <p>{letter} = {n}</p>
{/each}
```

Destructured names are plain values inside the block.

## Long lists

To render only the rows in view, see [Virtual lists](../advanced/virtual-lists.md)
(`{#virtual each}`).

---

Spec: [VISION.md § 9.2](../../VISION.md#92-lists--each)
