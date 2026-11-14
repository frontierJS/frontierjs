# `<mesa:element>`

An element whose tag name is an expression. Apart from the tag, it is an
ordinary element: attributes, events, `style:`, `bind:`, `{@attach}` and children
all work as written.

```mesa
<script>
  export let level = 2
  export let title = ''
</script>

<mesa:element this={'h' + level} class="title">{title}</mesa:element>
```

## The tag must be a string

`this` must resolve to a non-empty string. A missing one throws, naming the
element, rather than rendering a stray node. To render nothing, wrap it in
[`{#if}`](../template/if.md).

## Changing the tag rebuilds it

An element's tag cannot be changed in place, so a new tag builds a new element
and its subtree.

## Style it with a class

A tag selector in a scoped `<style>` cannot match a `<mesa:element>`, because the
tag is not known when the styles are scoped. Match on a class instead, as
`.title` above. See [Scoped styles](../styling/scoped-styles.md).

---

Spec: [VISION.md § 12.5](../../VISION.md#125-mesaelement) · RULE 57
