# Plugins

A plugin is an object handed to `app.configure()`. `register` runs at once and mounts routes and middleware, and `boot` runs at startup for async setup. The first-party plugins are packages of their own, and each is a page after this one.

```ts
let booted = false

app.configure({
  name: 'greeter',
  register(app) {
    app.get('/hello', ctx => ctx.json({ hello: 'world' }))
  },
  async boot(app) {
    app.registerMetricsSource('greeter', () => ({ booted: true }))
    booted = true
  },
})

await app._startForTest()
const res = await app.http.fetch(new Request('http://localhost/hello'))

if (!booted) throw new Error('boot did not run')
if ((await res.json()).hello !== 'world') throw new Error('the route was not mounted')
```

## What else it can do

- `register` is synchronous, so anything async goes in `boot`
- `work` starts a timer or worker, and a one-shot process skips it
- `ready` runs after the app is listening, `shutdown` when it stops
- `requires: ['mailer']` refuses a start where a plugin it needs is not configured first
- `configKeys` names the `junction.config.js` section the plugin reads
- `app.own('thing', value)` takes the `app.thing` slot, and a second owner throws
- First-party plugins are [Caravan](caravan.md) for jobs, [Conduit](conduit.md) for integrations, [Notifications](notifications.md) and [MCP](mcp.md) for agents
- Each subsystem is an interface, so `IAuth`, `IMail`, `ICache` and `IEventBus` swap a provider in one file, and an AI model is a toolbelt `Door` registered with `ai({ doors })`

**In depth:** [README § Tier 1 Plugins](../../../README.md#tier-1-plugins)
