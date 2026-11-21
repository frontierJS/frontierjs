# Loading data for a page

A route gets its data from a `load()` function in a `.meta.js` file beside it. What it returns is `page.data` before the page renders.

```js
// src/routes/blog/[slug].meta.js
export const meta = { section: 'blog' }

export async function load({ params, fetch }) {
  const res = await fetch(`/posts/${params.slug}`)
  if (!res.ok) throw new Error('Post not found')
  return res.json()
}

const fetch = async path => ({ ok: true, json: async () => ({ path, title: 'Hello' }) })
const data = await load({ params: { slug: 'hello' }, fetch })

if (data.path !== '/posts/hello' || meta.section !== 'blog') throw new Error(`unexpected ${JSON.stringify(data)}`)
```

## What else it can do

- `load({ params, url, meta, fetch })` takes the path captures, the path plus search as a string, the merged frontmatter, and a `fetch`
- `fetch` attaches the signed-in session to the app's own origin and to nothing else
- Returning a string that starts with `/` redirects
- A thrown error lands in `page.error` and the router stays on the route, so the page draws its own error state
- `meta` is merged into the route's frontmatter
- `getStaticPaths()` returns the params a `static` build prerenders
- `head({ params, data, url })` sets the document title
- A prefetched `load()` is cached per URL for 30 seconds

**In depth:** [Sierra README § Data loading](../../../README.md#data-loading)
