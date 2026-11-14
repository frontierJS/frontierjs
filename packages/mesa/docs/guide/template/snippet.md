# `{#snippet}` and `{@render}`

A snippet is a named piece of template you define once and render wherever you
need it.

```mesa
<script>
  let people = [
    { id: 1, name: 'Ada', status: 'active' },
    { id: 2, name: 'Grace', status: 'away' },
  ]
</script>

{#snippet badge(status)}
  <span class="badge {status}">{status}</span>
{/snippet}

<ul>
  {#each people as person (person.id)}
    <li>{person.name} {@render badge(person.status)}</li>
  {/each}
</ul>
```

A snippet sees the component's variables and updates when they change. Write its
arguments as plain values; Mesa reads them fresh each time, so the body keeps up
when an argument changes.

## Passing a snippet to a component

A snippet defined inside a component's tag is passed as a prop of the same name.
The child declares it with `export let` and renders it.

```mesa
<script>
  export let items = []
  export let row
  export let header = null
</script>

<table>
  {@render header?.()}
  {#each items as item}
    {@render row(item)}
  {/each}
</table>
```

```mesa
<script>
  import Table from './Table.mesa'

  let items = [{ name: 'Ada' }, { name: 'Grace' }]
</script>

<Table {items}>
  {#snippet row(item)}
    <tr><td>{item.name}</td></tr>
  {/snippet}
</Table>
```

Use `?.` on `{@render header?.()}` for a snippet the parent may not pass.

## Snippets and slots

For content with no arguments, [`<slot />`](slot.md) is shorter. Reach for a
snippet prop when the child must hand a value back to the caller.

---

Spec: [VISION.md § 9.5](../../VISION.md#95-snippets--snippet--render) · RULE 28 · RULE 29
