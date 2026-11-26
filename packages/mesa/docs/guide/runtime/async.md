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

## One load feeding another

A load never starts until every awaited `const` it reads has had its first
successful answer. It reads one directly, or through a derived `const` or a `$:`
writable derived:

```mesa
<script>
  const states = await getStates()
  $: selectedState = states?.[0]
  const cities = await getCities(selectedState)
</script>

<mesa:boundary>
  {#snippet pending()}<p>Loading…</p>{/snippet}
  {#snippet failed(error, reset)}<p>{error.message} <button onclick={reset}>Retry</button></p>{/snippet}

  <select bind:value={selectedState}>
    {#each states as state}<option>{state}</option>{/each}
  </select>
  <ul>{#each cities as city}<li>{city}</li>{/each}</ul>
</mesa:boundary>
```

`getCities` is called once `states` lands, first with the real first state, and
never with `undefined`. Until then `$async.cities.loading` is true and its loader
has not run. No `&&` guard is needed in front of the call.

After that first answer, a refetch of `states` does not hold `cities` back. It
keeps its value and reports `pending` while `states` is in flight, then re-runs
if `states` lands with a new value.

A derived value is not deferred. `selectedState` runs while `states` is still
`undefined`, so it keeps its `?.`: `$: selectedState = states?.[0]`.

If the first load of `states` fails, `cities` takes that error as its own.
`$async.cities.error` is the same `Error`, its `status` is `'error'`, and its
loader is never called. A later successful `$async.states.refresh()` starts it.
A load that starts from its hydrated server value does not wait.

Two reads are invisible to the compiler, so a load that depends on them is not
held and runs at once:

- A read inside a called `function` declaration. The loader runs with the value
  as it stands, `undefined` for an unanswered load; a `TypeError` from that read
  prints `[Mesa] ASYNC_OUTSIDE_LOADING_BOUNDARY` naming the load and the
  unanswered const. Pass the value in as an argument instead.
- A `let` that a `$:` watch writes, as in `$: states, () => { first = states.n }`.
  Read the value through a derived: `const first = states.n`, or
  `$: first = states?.n`.

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
