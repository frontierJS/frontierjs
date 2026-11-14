# `{#await}`

Render a promise's three states: pending, resolved and rejected.

```mesa
<script>
  const load = () => fetch('/api/user').then((r) => r.json())
</script>

{#await load()}
  <p>Loading...</p>
{:then user}
  <p>Hello {user.name}</p>
{:catch error}
  <p>Failed: {error.message}</p>
{/await}
```

`{:then}` and `{:catch}` are optional, the pending part can be empty, and
`{:then}` can omit the name when you do not need the value.

## One block form only

Write the whole `{#await p}...{:then v}...{/await}` block. The one-line
`{#await p then v}` form is a compile error.

## For more than a render

`{#await}` is for showing a promise in the template. For loading data, caching
and cancelling, see [Async](../runtime/async.md).

---

Spec: [VISION.md § 9.3](../../VISION.md#93-async--await)
