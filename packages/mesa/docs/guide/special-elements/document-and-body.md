# `<mesa:document>` and `<mesa:body>`

Attach event listeners to `document` or to `document.body` from inside a
component.

```mesa
<script>
  let hidden = false
  let hovering = false
</script>

<mesa:document onvisibilitychange={() => hidden = document.hidden} />
<mesa:body
  onmouseenter={() => hovering = true}
  onmouseleave={() => hovering = false}
/>

<p>Tab hidden: {hidden}. Pointer in page: {hovering}.</p>
```

Neither element renders anything. They exist only to carry listeners, and the
listeners are removed when the component is destroyed.

For `window` events and its bindings, use [`<mesa:window>`](window.md).

---

Spec: [VISION.md § 12.2](../../VISION.md#122-mesadocument-and-mesabody)
