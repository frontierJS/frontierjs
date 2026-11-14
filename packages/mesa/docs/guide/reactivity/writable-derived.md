# Writable derived

`$: name = expr` declares a value that re-derives whenever its inputs change and
that you can still assign to.

```mesa
<script>
  let cities = ['Boston', 'Denver', 'Austin']
  $: selected = cities[0]
</script>

<select bind:value={selected}>
  {#each cities as city}
    <option value={city}>{city}</option>
  {/each}
</select>

<button onclick={() => cities = ['Seattle', ...cities]}>Add a city</button>
<p>Selected: {selected}</p>
```

`selected` starts as the first city. The user can pick another, which overwrites it.
When `cities` changes, it re-derives and goes back to `cities[0]`.

## Why not `const` or `let`

A [`const`](const.md) is authoritative. It recomputes and can never be assigned, so
it cannot sit behind a `bind:`. A [`let`](let.md) can be assigned, but its
initializer runs once and never re-derives. Writable derived is the one form that is
both.

## Overrides are temporary

Every time an input changes, the value re-derives and the override is lost. To keep
the user's choice across changes, use a `let` and reset it only when you say so.

```js
let selected = cities[0]
$: cities, () => { selected = cities[0] }
```

The handler form is deferred, so it does not run on mount. The initial value
comes from the `let`.

---

Spec: [VISION.md § 4.5](../../VISION.md#45-writable-derived---name--expr) · RULE 14a
