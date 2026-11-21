# CSRF

A bearer token is already safe from cross-site forgery, because a foreign page cannot set the header. `csrf()` is for cookie sessions, where the browser attaches the cookie to a forged request, and it refuses a write that comes from another site.

```ts
import { request } from '@frontierjs/junction/testing'

app.services.register(createService({ name: 'notes', async create(ctx) { return { ...ctx.data } } }))
app.configure(csrf({ origins: ['https://admin.example.com'] }))

const same = await request(app).post('/notes').set('sec-fetch-site', 'same-origin').send({ text: 'a' })
if (same.status !== 201) throw new Error(`a same-origin write should pass, got ${same.status}`)

const forged = await request(app).post('/notes').set('sec-fetch-site', 'cross-site').set('origin', 'https://evil.example').send({ text: 'a' })
if (forged.status !== 403) throw new Error(`a cross-site write should be refused, got ${forged.status}`)

const listed = await request(app).post('/notes').set('sec-fetch-site', 'cross-site').set('origin', 'https://admin.example.com').send({ text: 'a' })
if (listed.status !== 201) throw new Error(`a listed origin should pass, got ${listed.status}`)
```

## What else it can do

- Cookie mode installs it for you: `auth(auth, { cookieAuth: true })` or `config.auth.cookie` turns it on, and `middleware.csrf` or `middleware.cors.origins` lists the other origins allowed
- It checks `POST`, `PUT`, `PATCH` and `DELETE`, and reads `Sec-Fetch-Site`, then `Origin`, then the origin of `Referer`
- `origins` may be a list or a predicate such as `o => o.endsWith('.example.com')`
- `combineOrigins([...])` shares one list between `cors()` and `csrf()`
- `allowMissingOrigin: false` refuses a request with no origin information at all
- `onRejected(ctx, reason)` replaces the refusal, to log instead of throwing
- Configure `cors()` first, so a preflight is answered before `csrf()` looks at the origin
- `FRONTIER_CORS_ORIGINS` adds the origins a deploy derives
- Auth with a cookie is the [Sessions](../identity/sessions.md) page

**In depth:** [README § CSRF protection](../../../README.md#csrf-protection)
