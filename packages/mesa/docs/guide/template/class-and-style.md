# `class:` and `style:`

Toggle one class, or set one style property, from a variable.

```mesa
<script>
  let active = true
  let dark = false
  let color = 'tomato'
  let size = 18
</script>

<p
  class="note"
  class:active={active}
  class:dark
  style:color
  style:font-size="{size}px"
>
  Hello
</p>
```

`class:active={active}` adds `active` while the expression is truthy and removes
it otherwise. It sits beside a normal `class` attribute without replacing it.

## Shorthand

When the variable has the same name, drop the value: `class:dark` means
`class:dark={dark}`, and `style:color` means `style:color={color}`.

## Style values

`style:` takes a bare expression, or a quoted value with text around braces, such
as `style:font-size="{size}px"`. Use the CSS property name with its hyphens.

## On a component

`class:` does not reach into a child component and is a compile error there. Pass
a `class` attribute through instead; see
[Passing a class](../styling/class-passthrough.md).

---

Spec: [VISION.md § 10.4](../../VISION.md#104-class-directive--classname) · [§ 10.5](../../VISION.md#105-style-directive--styleprop)
