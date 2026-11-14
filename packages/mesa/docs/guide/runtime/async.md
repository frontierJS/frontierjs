# Async

Top-level `await` works in a component's `<script>`. A top-level `const` that
awaits becomes an async value with a state object, `$async`, generated for it.

```mesa
<script>
  let selectedState = 'CA'
  const cities = await getCities(selectedState)
</script>

<select bind:value={selectedState}>
  <option>CA</option>
  <option>OR</option>
</select>

<button onclick={() => $async.cities.refresh()} disabled={$async.cities.pending}>
  Reload
</button>

{#if $async.cities.error}
  <p>{$async.cities.error.message}</p>
{:else}
  <ul>{#each cities ?? [] as city}<li>{city}</li>{/each}</ul>
{/if}
```

`getCities(selectedState)` reads reactive state, so it re-runs when
`selectedState` changes. A run still in flight is aborted, and the latest run
wins however the replies arrive. An `await` that reads nothing reactive runs
once.

## The `$async` object

For `const cities = await …`:

- `$async.cities.loading` is true during the first fetch only.
- `.pending` is true whenever a fetch is in flight.
- `.error` is the `Error`, or `null`.
- `.status` is `'pending'`, `'success'` or `'error'`.
- `.refresh()` runs it again now. The old value stays until the new one lands.

To show a placeholder around the part that depends on it, use
[`<mesa:boundary>`](../special-elements/boundary.md).

## A function can have `$async` too

A top-level `async function` whose `$async` you read gets the same object, so a
button needs no hand-kept `busy` and `error`:

```mesa
<script>
  async function remove(id) {
    await api.remove(id)
  }
</script>

<button onclick={() => remove(1)} disabled={$async.remove.pending}>Delete</button>
{#if $async.remove.error}<p>{$async.remove.error.message}</p>{/if}
```

Its `status` starts as `'idle'`. The call still returns its promise and still
rejects. Overlapping calls are counted, so `pending` holds until all have
settled. In a list, `$async.remove.for(id).pending` is the state for one key.
Reading `.error` marks the rejection as handled. `$async.x` exists for these two
forms only, and reading it for anything else is a compile error.

## Optimistic updates

Mesa has no reconciliation API. Write the value you expect now, then correct it
when the call settles:

```js
let price = 100

async function applyDiscount() {
  const before = price
  price = price * 0.9
  try { await api.discount() } catch { price = before }
}
```

Any non-`const` variable can be assigned at any time, and the last write wins.

---

Spec: [VISION.md § 13](../../VISION.md#13-async-model) · RULE 15 · RULE 16
