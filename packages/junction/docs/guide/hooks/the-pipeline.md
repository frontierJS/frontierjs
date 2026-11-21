# The pipeline

Every call to a service, from any transport, runs the same chain of hooks around the method. Auth, validation, rate limits, caching and real-time pushes live in hooks and compose without touching a method body.

```ts
const trail: string[] = []
const note = (name: string) => () => { trail.push(name) }

app.services.register(createService({
  name: 'deployments',
  async create(ctx) { trail.push('method'); return { id: 1, ...ctx.data } },
  hooks: {
    around: { all: [async (_ctx, next) => { trail.push('around:enter'); await next(); trail.push('around:exit') }] },
    before: { all: [note('before')] },
    after:  { all: [note('after')] },
  },
}))

await app.service('deployments').create({ ref: 'main' })
const order = trail.join(' > ')
if (order !== 'around:enter > before > method > after > around:exit') throw new Error(order)
```

## What else it can do

- A hook is a function of the call's `ctx`; it may be `async`
- `all` runs on every method and a method name runs on that one, `all` first
- A `before` hook that sets `ctx.result` skips the method, which is how a cache answers
- A hook that throws ends the chain and runs the `error` hooks; an `around` hook reaches its exit code only through `try`/`finally`
- `validated:` is a stage between `before` and the method, after the schema's own derivation
- The gate wraps every hook the app wrote, so a call the gate refuses reaches none of them
- The same hooks run for HTTP, the socket, MCP, a job and `app.service(...)`
- `authenticate`, `requireRole`, `paginate`, `protect`, `allow`, `timestamps`, `logTiming`, `circuitBreaker` and `rateLimitHook` come from `@frontierjs/junction/hooks`
- Pipelines are compiled once per service when the app starts

**In depth:** [README § 2. The hook pipeline — `core/hooks.ts`](../../../README.md#2-the-hook-pipeline--corehooksts)
