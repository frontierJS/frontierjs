# Overview

Mesa is a compiler for user interfaces. It turns `.mesa` components into plain
DOM code that runs on a small signal runtime, so a button click changes one text
node instead of re-rendering a tree.

The reactive model is three JavaScript keywords you already know. A top-level
`let` is state, a top-level `const` is derived from state, and `var` opts out.
There is no store API, no `.value`, and no wrapper function. A component's
script is plain JavaScript that any JavaScript parser accepts.

```mesa
<script>
  let count = 0
  const double = count * 2
</script>

<button onclick={() => count++}>
  {count} doubled is {double}
</button>

<style>
  button { padding: 0.5em 1em }
</style>
```

The script and the markup share one scope, and the `<style>` block is scoped to
this component.

## Where next

- [Getting started](getting-started.md) installs the compiler and mounts a
  component.
- [`.mesa` files](mesa-files.md) names the parts of a component file.
- [`let`](../reactivity/let.md) is the first primitive.
- The full language is specified in [VISION.md](../../VISION.md).

---

Spec: [VISION.md § 1](../../VISION.md#1-design-philosophy)
