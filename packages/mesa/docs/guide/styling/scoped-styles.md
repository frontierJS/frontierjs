# Scoped styles

A `<style>` block belongs to its component. Its rules apply to that component's
own elements and nothing else.

```mesa
<script>
  let count = 0
</script>

<button onclick={() => count++}>
  Clicked {count} times
</button>

<style>
  button {
    color: white;
    background: rebeccapurple;
  }
</style>
```

The compiler puts a content-addressed class on every element in the component
and on the end of every selector, so `button` becomes `button.mHASH`. Other
components' buttons are untouched.

## The class goes on the subject

The scope class is appended to the rightmost part of a selector, the thing the
rule actually styles. Two things follow:

- **You can style your own root.** A rule for the component's outermost element
  matches it.
- **You cannot style a child component's elements.** They carry the child's
  class, not yours.

To cross that boundary on purpose, wrap the selector in `:global(...)`:

```css
.card :global(.badge) { color: red }
```

`:global(...)`, `:root`, `html` and `body` are emitted unscoped.

## Tag selectors and `<mesa:element>`

A tag selector cannot match a [`<mesa:element>`](../special-elements/element.md),
whose tag is only known at run time. Match it on a class.

## When styles do not appear

Through the Vite plugin, scoped styles are injected for you. If you call the
compiler yourself with `css: false`, the styles come back on `ctx.css.result`
and you must inject them: the markup still carries the class and matches no
rule. See [the compiler reference](../reference/compiler.md).

Mesa does not ship a design system. For tones, treatments and tokens, see
[`@frontierjs/css`](../../../../css/README.md), the styling language for
FrontierJS apps.

---

Spec: [VISION.md § 5](../../VISION.md#css-scoping--the-class-goes-on-the-subject) · RULE 55
