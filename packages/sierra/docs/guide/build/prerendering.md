# Prerendering

Under `target: 'static'` a route is rendered to its own `index.html` at build time, so a visitor and a crawler get the page before any script runs. Declaring `render: static` makes that a promise, and the build fails if the page cannot be made.

```mesa
---
render: static
---
<script>
  export let data = null
</script>

<h1>{data.name}</h1>
```

```js
// src/routes/products/[slug].meta.js
export async function load({ params }) {
  return { name: `Product ${params.slug}` }
}

export async function getStaticPaths() {
  return [{ slug: 'tee' }, { slug: 'mug' }]
}
```

## What else it can do

- `render: spa` opts one route out, and the browser renders it
- A dynamic route needs a `getStaticPaths()` companion to say which paths exist
- The build checks what each `load()` read against the schema's `@@gate` and refuses to publish a page that would expose gated data
- `db` in the config names the Litestone client that check reads through
- `status: draft` and `redirect:` routes are not prerendered, and a redirect lands in `_redirects`
- `head()` in the companion answers `{ title, description, meta, links, jsonLd }` for each page
- `document: { bodyClass, lang, head, bodyEnd, meta, links, jsonLd }` wraps every page, and the build's own stylesheets are linked for you
- A layout reads `page` while it prerenders as it does in the browser

**In depth:** [README § Build targets](../../../README.md#build-targets), [§ The document around a prerendered page](../../../README.md#the-document-around-a-prerendered-page)
