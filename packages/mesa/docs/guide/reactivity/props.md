# Props

`export` marks a top-level declaration as a prop, a value the parent passes in.
The keyword after `export` says how the component relates to it.

```mesa
<script>
  export let count = 0
  export const label = 'Clicks'
  export var step = 1
</script>

<button onclick={() => count += step}>
  {label}: {count}
</button>
```

A parent passes them as attributes: `<Counter count={5} label="Taps" step={2} />`.

| Declaration | The parent's later values | The component can assign it |
|---|---|---|
| `export let` | arrive | yes |
| `export const` | arrive | no |
| `export var` | never arrive | yes, but nothing re-renders |

## Defaults

The initializer is the default. It applies when the parent passes nothing, or
passes `undefined`. An explicit `null` is a real value, and it is how a parent
clears a prop. A prop with no initializer, such as `export let selected`, is
`undefined` until the parent provides one.

## `export const` is read-only to the component

Assigning to it is a compile error. It is not frozen in time, though: a new value
from the parent still reaches it and the page updates. If you want a value that
really is fixed at mount, that is `export var`.

## `export var` is a snapshot

The component reads it once at mount and ignores the parent after that. It is the
one form whose keyword misleads, since it reads like `let`. Reach for `export let`
unless a frozen value is what you mean.

## `bind:` needs `export let`

A parent can bind to a child's prop with `bind:count={n}` only when the child
declares it `export let`. Binding to a prop declared any other way does nothing, and
Mesa reports it in the console, naming the prop. The variable on the parent's side
must be a top-level `let`.

## `$props` and `$attributes`

`$props` is an object of every prop passed to the component, declared or not.
`$attributes` is the same set for forwarding, usually onto an element.

```mesa
<script>
  export let label = ''
</script>

<button {...$attributes}>{label}</button>
```

`<Fancy label="Save" disabled />` puts `disabled` on the button and takes `label` for
itself. A `class` does not travel through `$attributes`; see
[Passing a class](../styling/class-passthrough.md).

An instance script exports props and `export function` methods and nothing else. A
default export is a compile error.

---

Spec: [VISION.md § 3](../../VISION.md#3-component-props), [§ 17](../../VISION.md#17-built-in-functions-the--door) · RULE 56
