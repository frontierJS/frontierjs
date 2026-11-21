# The page object

`page` is one object that holds everything about the current route: its params, its query, its data, its frontmatter. It is a plain object, and a component makes the fields it uses reactive with a `$:` path watch.

```mesa
<script>
  import { page } from '@frontierjs/sierra/router'
  $: (page.params, page.data)
</script>

<h1>{page.title}</h1>
<p>{page.params.slug}</p>
{#if page.error}<p class="error">{page.error.message}</p>{/if}
```

## What else it can do

- `pathname`, `search` and `hash` are the current address
- `params` is the path captures, so `/leads/:leadId/` gives `{ leadId }`
- `query` is the URL's filters, coerced, so `?status=active&tier=3` gives `{ status: 'active', tier: 3 }`
- `directives` is the URL's `$` params, so `?$limit=20&$orderBy=-name` gives `{ limit: 20, orderBy: '-name' }`
- `orders.tethered()` reads `page.query` and `page.directives`, so a filtered, sorted, paged list lives in its URL and survives a reload
- `setParams(obj)` and `updateParams(fn)` write the query back to the URL
- `meta` is the raw frontmatter, and each of its keys is also spread onto `page`
- `route` is the matched route node, and `pending` is the in-flight route during a navigation
- `data` is what the route's `load()` returned, and `error` is what it threw
- `slots` holds the named slots a page provided
- `title` also becomes `document.title` on every navigation

**In depth:** [Sierra README § The `page` object](../../../README.md#the-page-object)
