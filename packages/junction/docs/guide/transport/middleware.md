# Middleware

Middleware is a plugin that wraps every request, installed with `app.configure()`. Junction ships the ones an API needs, and each is off until it is configured except helmet.

```ts
import { cors, correlationId } from '@frontierjs/junction'
import { request } from '@frontierjs/junction/testing'

app.configure(cors({ origins: ['https://myapp.com'] }))
app.configure(correlationId())
app.get('/ping', ctx => ctx.json({ ok: true }))

const res = await request(app).get('/ping').set('origin', 'https://myapp.com').set('x-request-id', 'req-123')
if (res.headers['access-control-allow-origin'] !== 'https://myapp.com') throw new Error('cors did not allow the origin')
if (res.headers['x-request-id'] !== 'req-123') throw new Error('the request id was not echoed')
```

## What else it can do

- `helmet()` sets security headers, with a strict `Content-Security-Policy` unless `http: { helmet: { csp } }` widens it or `csp: false` drops it
- `rateLimit({ max: 100, window: 60_000 })` throttles per caller, counted in the process
- `requestLogger()` writes one line per request, and a method declared with `log: false` writes none while it answers below 400
- `csrf({ origins })` protects a cookie-session API
- `cors({ origins, exposeHeaders })` names the response headers a cross-origin page may read
- `correlationId()` stamps `ctx.requestId`; the id is a `traceparent` trace id, else `X-Request-ID`, else minted
- The same options live under `middleware:` in `junction.config.js`

**In depth:** [README § Middleware](../../../README.md#middleware)
