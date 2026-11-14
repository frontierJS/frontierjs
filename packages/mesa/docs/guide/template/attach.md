# `{@attach}`

Run a function with an element when it mounts.

```mesa
<script>
  const focus = (el) => el.focus()

  const tooltip = (el) => {
    const show = () => el.setAttribute('data-open', '')
    const hide = () => el.removeAttribute('data-open')
    el.addEventListener('mouseenter', show)
    el.addEventListener('mouseleave', hide)
    return () => {
      el.removeEventListener('mouseenter', show)
      el.removeEventListener('mouseleave', hide)
    }
  }
</script>

<input {@attach focus}>
<button {@attach tooltip}>Hover me</button>
```

The function receives the element. Put `{@attach fn}` on the tag like an
attribute; an inline arrow works too, and a tag can carry several.

## What it returns

- **Nothing.** There is nothing to clean up.
- **A function.** It runs as cleanup before the attachment runs again and when
  the element is destroyed. Remove the listeners and timers you added.
- **A promise.** The element stays in the page until it resolves, which is how an
  exit animation works: return `el.animate(...).finished`.

---

Spec: [VISION.md § 10.6](../../VISION.md#106-element-lifecycle--attach)
