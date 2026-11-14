# Passing a class

Write `class` on a component the way you would on an element. The component
decides which of its own elements receives it by marking that element `{class}`.

```mesa
<script>
  export let label = ''
</script>

<button class="btn" {class}>{label}</button>

<style>
  .btn { padding: 0.5rem 1rem }
</style>
```

The parent passes a class with no special syntax:

```mesa
<script>
  import Btn from './Btn.mesa'
  let primary = true
</script>

<Btn label="Save" class="wide" />
<Btn label="Send" class={primary ? 'primary' : 'secondary'} />
```

The parent's class is merged into the element's own. Its `btn` class and its
scope class stay, and so does anything another binding put there.

## You choose the element

`{class}` does not have to sit on the root, and more than one element may carry
it.

## `class` is not a prop you declare

`class` is a reserved word in JavaScript, so you never write `export let class`.
Use the `{class}` marker on the child and a plain `class=` on the parent.

## `bind:class`

On a component, `bind:class` is an ordinary two-way prop. On an element it is a
compile error, because there is no way to read a class set back from the DOM.
Use [`class:` and `style:`](../template/class-and-style.md) to toggle classes.

---

Spec: [VISION.md § 10.8](../../VISION.md#108-class-prop-passthrough) · RULE 31
