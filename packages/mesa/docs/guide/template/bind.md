# `bind:`

Keep a variable and a form control in step, in both directions.

```mesa
<script>
  let name = ''
  let agreed = false
  let qty = 1
  let size = 'M'
  let toppings = []
</script>

<input bind:value={name} placeholder="Name">
<input type="number" bind:value={qty}>
<label><input type="checkbox" bind:checked={agreed}> I agree</label>

<input type="radio" bind:group={size} value="S"> S
<input type="radio" bind:group={size} value="M"> M

<input type="checkbox" bind:group={toppings} value="cheese"> Cheese
<input type="checkbox" bind:group={toppings} value="olives"> Olives

<p>{name}, {qty}, {size}, {toppings.join(', ')}</p>
```

`bind:value` works on `<input>`, `<textarea>` and `<select>`. A
`type="number"` or `type="range"` input gives you a number, and `undefined`
while the box is empty or half-typed.

## `bind:group`

Radios share one variable that holds the selected `value`. Checkboxes share one
array that holds every checked `value`.

## `bind:this`

On an element, `bind:this` sets the variable to the DOM node once it mounts and
back to `null` when it is destroyed. On a component it gives the component's
exported props and functions, never a DOM node.

```mesa
<script>
  let canvas = null

  $.onMount(() => {
    canvas.getContext('2d').fillRect(0, 0, 20, 20)
  })
</script>

<canvas bind:this={canvas}></canvas>
```

## What you can bind to

The variable must be a top-level `let`. A `const`, a `var`, an import or a
function is a compile error that names the variable. For a component, the child
must declare the prop with `export let`. The parent cannot see the child's
declaration, so binding to an `export const` or `export var` prop compiles,
logs a warning when it mounts, and does nothing.

```mesa
<script>
  import Field from './Field.mesa'

  let email = ''
</script>

<Field bind:value={email} />
```

To format as the user types, see [Input masking](../advanced/input-masking.md)
(`bind:value|mask`).

---

Spec: [VISION.md § 10.1](../../VISION.md#101-two-way-binding--bindvalue) · [§ 10.2](../../VISION.md#102-element-reference--bindthis) · [§ 10.3](../../VISION.md#103-group-binding--bindgroup) · [§ 3.4](../../VISION.md#34-bind-validity) · RULE 22 · RULE 24 · RULE 36
