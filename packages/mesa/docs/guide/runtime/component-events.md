# Component events

A component takes a handler as a prop with the DOM's own event name. `onclick`
is spelled the same on an element and on a component.

```mesa
<script>
  export let onsave = undefined
  let draft = ''
</script>

<input bind:value={draft}>
<button onclick={() => onsave?.(draft)}>Save</button>
```

The parent passes a function:

```mesa
<script>
  import Editor from './Editor.mesa'
  function save(text) { console.log('saved', text) }
</script>

<Editor onsave={save} />
```

A handler prop is just a prop, so call it when something happens.

## `$.emit`

`$.emit(name, data)` calls the parent's `on{name}` prop if there is one, and does
nothing if not:

```js
function handleClick(e) {
  $.emit('click', e)
}
```

It looks for `onclick` and `onClick`. Calling the prop directly, as above, is
preferred for new code; `$.emit` is kept for compatibility.

## Modifiers

Modifiers on a component are applied to the function it is handed.
`<Button onclick|preventDefault={save}>` passes `onclick` already wrapped, so
the guard survives the child forwarding it to its own element. `once`, `passive`
and `capture` are listener options, a component has no listener of its own, so
they are refused there.

`on:click` and `@click` are not Mesa. There is one spelling.

---

Spec: [VISION.md § 8.2](../../VISION.md#82-component-events) · RULE 23
