# Navigation

`goto` moves to a path, and `url` builds one with the configured trailing-slash policy. Both come from `@frontierjs/sierra/router`.

```js
import { url } from '@frontierjs/sierra/router'

const href = url('/leads', { status: 'open', tier: 3 })

if (href !== '/leads/?status=open&tier=3') throw new Error(`unexpected url ${href}`)
```

In a component, `goto('/leads/', { status: 'open' })` navigates there and resolves `true` once the route committed.

## What else it can do

- `goto(path, query?, { scroll, replace, directives })` resolves `false` when a guard cancelled, the route failed to load, or a newer navigation won, and it never rejects
- `back()` and `forward()` move through history
- `reload(path?, query?)` starts the whole app again at a path
- `isActive('/leads/', { exact })` is a prefix match for a nav highlight; name `page.route` in the same expression, as in `aria-current={(page.route, isActive('/leads/')) ? 'page' : null}`
- `setParams(obj)` replaces the query and `updateParams(fn)` merges it through a function
- `getDirection()` answers `'next'`, `'prev'` or `'first'`
- `prefetch(path)` preloads a route's chunk and data
- A link with the `prefetch` attribute prefetches at once, `prefetch="hover"` on mouseenter, and `prefetch="visible"` when it scrolls into view
- A prefetched payload is dropped on any change of identity, so a sign-out cannot serve the last person's data

**In depth:** [Sierra README § Navigation API](../../../README.md#navigation-api), [§ Prefetching](../../../README.md#prefetching)
