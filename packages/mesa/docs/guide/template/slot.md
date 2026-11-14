# `<slot />`

A slot is a hole a component leaves for its caller to fill.

```mesa
<script>
  export let title = ''
</script>

<div class="card">
  <h2>{title}</h2>
  <slot />
</div>
```

```mesa
<script>
  import Card from './Card.mesa'
</script>

<Card title="Welcome">
  <p>Whatever you put here lands at the slot.</p>
</Card>
```

## Named slots and fallbacks

Name a slot with `<slot:name />`, or `<slot name="name" />`. The caller routes
content to it with a `slot="name"` attribute. Content between the tags is the
fallback, shown when the caller passes nothing.

```mesa
<script>
  export let open = true
</script>

<div class="card">
  <header><slot:header>Untitled</slot:header></header>
  <main><slot /></main>
  {#if $slots.footer}
    <footer><slot:footer /></footer>
  {/if}
</div>
```

```mesa
<script>
  import Card from './Card.mesa'
</script>

<Card>
  <h1 slot="header">Title</h1>
  <p>Body (the default slot)</p>
  <p slot="footer">Footer line</p>
</Card>
```

`$slots.name` is true when the caller passed that slot, so you can skip the
wrapper around an empty one.

## A slot carries content in, not a value out

`<slot>` takes no attribute but `name`; any other is a compile error, because
nothing could read it. When the caller needs a value from the child, use a
[snippet prop](snippet.md) with an argument.

---

Spec: [VISION.md § 9.6](../../VISION.md#96-slots--slot-) · RULE 35 · RULE 35a · RULE 35b
