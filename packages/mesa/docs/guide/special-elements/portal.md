# `<mesa:portal>`

Render children into any DOM node, outside the component's own place in the page.
Use it for a modal or tooltip that must escape a parent's `overflow` or stacking
context.

```mesa
<script>
  let open = false
</script>

<button onclick={() => open = true}>Open</button>

{#if open}
  <mesa:portal to={document.body}>
    <div class="modal">
      <p>I'm in body, not where I was written.</p>
      <button onclick={() => open = false}>Close</button>
    </div>
  </mesa:portal>
{/if}
```

The children are still this component's: they read its state and run its
handlers. Only their place in the DOM moves.

---

Spec: [VISION.md § 12.4](../../VISION.md#124-mesaportal)
