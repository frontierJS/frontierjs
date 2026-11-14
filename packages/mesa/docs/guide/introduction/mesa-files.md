# `.mesa` files

A `.mesa` file is one component: some script, some markup, some styles. Each part
is optional, and they can appear in any order.

```mesa
---
title: Counter
---

<script module>
  let created = 0
</script>

<script>
  export let start = 0
  let count = start
  created++
</script>

<button onclick={() => count++}>
  {count}
</button>

<style>
  button { font-weight: bold }
</style>
```

## `<script>`

The instance script runs once for every copy of the component, in the order it is
written. Top-level `let`, `const` and `var` are the [reactive model](../reactivity/let.md),
and `export` declares a [prop](../reactivity/props.md). Markup is everything
outside the `<script>` and `<style>` blocks, and it reads the script's names
directly.

## `<script module>`

A module script runs once, when the file is first imported, and every instance
shares what it declares. Use it for caches, counters and helper functions. Named
exports from it are ordinary ES exports that other files can import. It is not
reactive, and `$` does not exist there.

## `<style>`

Styles are scoped to the component by default. See
[Scoped styles](../styling/scoped-styles.md).

## Frontmatter

A `---` block at the very top is metadata for tools, such as a layout name. The
compiler hands it to whatever asked for it as `ctx.frontmatter`. In a `.mesa`
file it never becomes a prop and the markup cannot read it, which is different
from a [`.md` file](markdown-files.md), where frontmatter keys do become values.

The file extension decides the language. A `---` block at the top of a `.mesa`
file never switches it to markdown.

---

Spec: [VISION.md § 11](../../VISION.md#11-module-script--script-module) · RULE 30
