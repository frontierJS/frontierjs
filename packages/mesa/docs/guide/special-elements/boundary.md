# `<mesa:boundary>`

Show a placeholder while the async values its body reads are loading, and an
error view if they fail or something inside throws.

```mesa
<script>
  let selectedState = 'CA'
  let selectedCity = ''
  const cities = await getCities(selectedState)
</script>

<mesa:boundary>
  {#snippet pending()}<p>Loading cities...</p>{/snippet}
  {#snippet failed(error, reset)}
    <p>{error.message}</p>
    <button onclick={reset}>Try again</button>
  {/snippet}

  <select bind:value={selectedCity}>
    {#each cities as city}<option>{city}</option>{/each}
  </select>
</mesa:boundary>
```

Awaiting a top-level `const` makes an [async value](../runtime/async.md). The
boundary renders `pending` while any it reads is in flight and `failed` if one
rejects.

## It waits only on what its body reads

A body that reads no async value shows at once. A body that renders a snippet
defined elsewhere waits on every async value in the component, since those reads
are not in its subtree. To hold the whole template until something has loaded,
use [`<mesa:mounted>`](mounted.md).

## It also catches a throw

A throw while rendering inside the boundary, or in a derivation or `$:` effect
that feeds it, disposes the content and renders `failed(error, reset)` in its
place. `reset` builds the content again; nothing retries on its own. A throw in
an event handler or a timer is not caught. The nearest boundary above the throw
that has a `failed` snippet catches it.

## The `pending` and `failed` snippets

`<mesa:boundary>` and `<mesa:mounted>` find `pending` and `failed` the same way,
in this order:

1. Snippets written inside the element.
2. `{#snippet pending()}` and `{#snippet failed(error, reset)}` written anywhere
   in the template.
3. Nothing: a blank pending state, and a rejection is swallowed. A boundary with
   no `failed` does not catch a throw, so it goes on to the boundary above.

A boundary can wrap just the part of the page that needs data, and a component
may have several.

---

Spec: [VISION.md § 12.6](../../VISION.md#126-mesaboundary-and-mesamounted) · RULE 40
