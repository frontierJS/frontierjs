# `<mesa:window>`

Attach listeners to `window` and bind to its measurements. The listeners are
removed when the component is destroyed.

```mesa
<script>
  let width = 0
  let scrollPos = 0

  function handleKey(e) {
    if (e.key === ' ') console.log('space')
  }
</script>

<mesa:window
  onkeydown|preventDefault={handleKey}
  bind:innerWidth={width}
  bind:scrollY={scrollPos}
/>

<p>{width}px wide, scrolled {scrollPos}px</p>
```

Events use the DOM's own names, with modifiers piped on, as on any element.

## What you can bind

`innerWidth`, `innerHeight`, `outerWidth`, `outerHeight`, `scrollX`, `scrollY`
and `devicePixelRatio`. Any other name is a compile error.

Whether the network is up is not a window binding. Read `tab.online` from
`@frontierjs/mesa/browser`.

## Other targets

To listen to `document` or `document.body`, see
[`<mesa:document>` and `<mesa:body>`](document-and-body.md).

---

Spec: [VISION.md § 12.1](../../VISION.md#121-mesawindow)
