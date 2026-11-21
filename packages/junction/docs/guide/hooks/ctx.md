# What is on ctx

`ctx` is the one object every hook and method receives, on every transport. It holds the caller, what was asked for, and a place for a hook's own scratch, and each field has one rule for whether it travels into a nested call.

```ts
const app = await createTestApp({ users: [{ id: 'u1', role: 'developer' }] })
const seen: Record<string, unknown> = {}

app.services.register(createService({
  name: 'projects',
  async find(ctx) {
    seen.user       = ctx.user?.id
    seen.query      = ctx.query
    seen.limit      = ctx.directives.limit
    seen.stamp      = ctx.locals.stamp
    return []
  },
  hooks: { before: { find: [(ctx) => { ctx.locals.stamp = 'set in before' }] } },
}))

await app.runAs('u1', () => app.service('projects').find({ status: 'open' }, { directives: { limit: 10 } }))
if (seen.user !== 'u1') throw new Error('the principal did not arrive')
if (JSON.stringify(seen.query) !== '{"status":"open"}') throw new Error('query holds more than filters')
if (seen.limit !== 10) throw new Error('the limit is a directive')
if (seen.stamp !== 'set in before') throw new Error('locals did not reach the method')
```

## What else it can do

- `ctx.user` is the principal, frozen, and propagates to nested calls; `null` when nobody is signed in
- `ctx.caller` holds `ip`, `userAgent` and `headers`, and is `{}` on an in-process call
- `ctx.query` is filters only and `ctx.directives` is `{ limit, offset, orderBy, select }`; no `$` key is on either
- `ctx.data` is the payload, a row or an array of rows
- `ctx.route` holds path captures and is `{}` on an internal call; there is no `ctx.params`
- `ctx.locals` is scratch, fresh for every call and not shared with a nested one
- `ctx.transients` and `ctx.reserved` hold the payload and query keys a service set aside
- `ctx.result` is `null` until the method has run; a `before` hook may set it to answer early
- `ctx.signal` aborts when the caller leaves
- `ctx.afterCommit(fn)` and `ctx.enqueue(job, payload)` queue work for after the write
- A request handler written with `app.get` holds a different context, with `ctx.json` and `ctx.headers`

**In depth:** [README § 1. The transport bridge — `transport/bridge.ts`](../../../README.md#1-the-transport-bridge--transportbridgets) and [docs/internals.md](../../internals.md)
