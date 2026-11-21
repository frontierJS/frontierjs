# Frontmatter

A block at the top of a `.mesa` or `.md` file describes the page: its title, whether it prerenders, where it redirects. Keys Sierra does not act on are yours and are spread onto `page`.

```js
import { parseFrontmatter } from '@frontierjs/sierra/scanner'

const source = `---
title: Pricing
render: static
robots: noindex
---
<h1>Pricing</h1>`

const { frontmatter, content } = parseFrontmatter(source)

if (frontmatter.title !== 'Pricing' || frontmatter.render !== 'static') throw new Error(`unexpected ${JSON.stringify(frontmatter)}`)
if (content !== '<h1>Pricing</h1>') throw new Error(`unexpected body ${content}`)
```

## What else it can do

- `reset: true` renders the route with no layout
- `render: static` makes a page that cannot prerender fail a `static` build, and `render: spa` leaves it to the browser
- `redirect: /path/` redirects a navigation there and is also written to `_redirects`
- `status: draft` leaves the page out of `published` and `indexed`
- `robots: noindex` leaves it out of `indexed` and the sitemap
- `siteName: My App` becomes `{page.siteName}`
- The merge order is layout frontmatter, layout `.meta.js`, route `.meta.js`, route frontmatter, then system flags, and the rightmost wins
- The syntax is a YAML subset, with no anchors, aliases or tags, and a date stays a string
- A key named like a router field, such as `params` or `data`, is shadowed and the scanner warns

**In depth:** [Sierra README § Frontmatter](../../../README.md#frontmatter)
