# Ordered watch groups

You need this page when several handlers react to the same change and the
order they run in matters: reset the page, then fetch, then log.

```mesa
<script>
  let query = ''
  let page = 3
  let results = []
  let log = []

  function resetPage() { page = 1 }
  async function fetchData() { results = await search(query, page) }

  $: {
    query, () => resetPage()
    query, () => fetchData()
    query, () => { log = [...log, query] }
  }

  async function search(q, p) { return [q + ' #' + p] }
</script>

<input bind:value={query}>
<p>page {page}: {results.join(', ')}</p>
```

When `query` changes, the three handlers run in the order written, once per
flush. Each line is a `dependency, handler` pair. Like the unbraced
`$: dep, handler` form, a group does not run at mount.

## The handler must be an inline function

Inside `$: { }` the handler has to be written out as a function. The shorthand
that passes a function by name works only without braces, because
`{ a, load }` and `{ a, b }` parse identically and the compiler cannot tell a
handler from two values.

```js
$: { userId, () => load() }     // fine
$: { userId, load }             // compile error: write () => load()
$: userId, load                 // fine, unbraced
```

The error names the fix.

## A block runs code, a sequence watches paths

Parentheses are the only thing separating a path watch from a block, and the
compiler reads them from where they sit in your source:

```js
$: (cart.items, cart.total)      // watches two paths
$: { (cart.items, cart.total) }  // compile error: a block that only reads
```

A `$: { }` block runs code. If every top-level statement in it is a bare read,
or it is empty, it is an error that names the form you probably wanted: drop the
braces to watch, or add a handler to run something. `$: if (...) { }` and
`$: for (...) { }` are errors too; put the statement inside a block.

## What bites

- **A group still only wakes for what its dependencies read.** A write a handler
  makes is not a trigger for the group it sits in.
- **The first run is skipped.** If a handler must also run once at mount, call
  it from `$.onMount` or write an auto-tracked `$: expression` beside the group.

---

Spec: [VISION.md § 4.4](../../VISION.md#44-ordered-watch-groups) · RULE 52 · RULE 14b · RULE 50
