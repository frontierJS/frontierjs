# Integrations with Conduit

`@frontierjs/conduit` declares each third party once, as a named target with its address, its credential and what to do when it is slow, and every call out goes through that name with `app.conduit.send()`. A webhook coming in from the same vendor is a Receiver on the same name.

```ts
import { conduit } from '@frontierjs/conduit'

// A stand-in for the vendor, on any free port
const vendor = Bun.serve({
  port: 0,
  fetch: req => Response.json({ id: new URL(req.url).pathname.split('/').pop(), status: 'running' }),
})

app.configure(conduit({
  targets: [{
    id:       'provider:hetzner',
    kind:     'provider',
    protocol: 'http',
    address:  `http://localhost:${vendor.port}/v1`,
    auth:     { type: 'none' },
  }],
}))
await app._startForTest()

const result = await app.conduit.send({ target: 'provider:hetzner', method: 'GET', path: '/servers/123' })
vendor.stop(true)

// send() never throws: it answers an error or data
if (result.error) throw new Error(`${result.error.kind}: ${result.error.message}`)
if (result.data.id !== '123') throw new Error(`unexpected body ${JSON.stringify(result.data)}`)
```

A real target names its credential by reference, `auth: { type: 'bearer', ref: 'HETZNER_TOKEN' }`, and the reference is resolved at send time, from `process.env` unless you pass a `credentials` resolver.

## What else it can do

- A target is a `provider`, an `outpost`, a `local` socket or a `broker`, over `http`, `websocket` or `unix`
- `store: createSQLiteStore(db)` keeps the registry across restarts, and `register()` adds a target at runtime
- `result.error.kind` names the failure, such as `timeout`, `auth_failed`, `rate_limited` or `circuit_open`, and says whether it is retryable
- Idempotent calls retry with backoff inside one `deadline_ms`
- A per-target circuit breaker and concurrency cap shed load from a failing vendor
- `app.conduit.stream(req)` yields a server-sent-event or byte stream
- `app.conduit.receive(receiver)` takes a vendor's webhook on its own route, and mail arrives this way
- A destination a user pasted into a row is `address_from: 'request'`, graded as a stranger's URL on every send
- HMAC signing, form encoding, constant headers and per-caller credentials are target options
- `createTestConduit({ target: { '/path': body } })` from `@frontierjs/conduit/testing` stubs targets, so a test makes no real call
- Connectors such as `conduit-postmark` and `conduit-stripe` declare a vendor's targets for you

**In depth:** [Conduit README § Quick start](../../../../conduit/README.md#quick-start)
